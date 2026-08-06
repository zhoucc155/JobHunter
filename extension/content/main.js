// ============================================================
// main.js — 入口路由
// 根据当前页面与任务状态决定角色：
//  - 普通页面 → 挂载面板
//  - background 打开的详情页（detailTask 匹配）→ 采集详情
//  - 投递由 background 直接驱动（scripting.executeScript），详情页不再自行发起沟通/打字
// ============================================================

(async function jhMain() {
  // 等页面稳定
  await JH.sleep(800);

  const { detailTask, autoCollect, collectNav } = await JH.get(['detailTask', 'autoCollect', 'collectNav']);
  const href = location.href;
  const isDetail = href.includes('job_detail');

  // ---------- 角色1：采集详情页 ----------
  if (isDetail && detailTask && href.includes(detailTask.jobId) && Date.now() - detailTask.ts < 60000) {
    await JHCollector.runDetailExtraction(detailTask);
    return; // 工作标签页不挂面板
  }

  // ---------- 角色2：投递由 background 直接驱动（通过 scripting.executeScript），
  //            详情页 content script 不再自行发起沟通/打字，避免与 background 重复操作。
  //            此处只负责：采集详情页 / 普通页面挂载面板。----------

  // ---------- 角色3：普通页面，挂载面板 ----------
  // 面板初始化失败不能连累后面的自动采集续跑，故单独 try
  try {
    await JHPanel.init();
  } catch (e) {
    console.warn('[JobHunter] 面板初始化异常：', e);
  }

  // 工具栏图标点击 → 切换面板
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOGGLE_PANEL') JHPanel.toggle();
    if (msg && msg.type === 'COLLECT_PROGRESS') {
      JHPanel.status(`详情补采中 ${msg.done}/${msg.total}：${msg.job.title}`, 'info', 0);
    }
    if (msg && msg.type === 'COLLECT_RISK') {
      JHPanel.status('⚠️ 详情采集触发安全验证，已熔断。请手动完成验证', 'error', 0);
    }
  });

  // ---------- 跳转落地后自动续跑采集 ----------
  // 场景：用户在推荐页/旧条件搜索页点了「岗位采集」→ 面板按新配置跳到搜索页 → 本次脚本重新注入，
  //       需要在这里把采集接着跑起来；多城市遍历跳下一城同理。
  //
  // 【安全铁律】只有「程序自己刚发起的那次跳转」才允许自动开跑。用户手动刷新 / 前进后退
  // 一律不得触发采集——否则就是「我没点采集，刷新一下就自己跑起来了」。为此做三件事：
  //  A) 一次性令牌：读到 autoCollect 立刻清除，无论后续走哪个分支、是否抛错，令牌都不会残留；
  //     （此前令牌只在 JHPanel.el 存在时才清，面板初始化失败就会永久残留 → 每次刷新都自动采集）
  //  B) 导航类型闸门：performance 的 navigation.type 为 reload / back_forward 时直接放弃续跑；
  //  C) collectNav 兜底收紧：必须「当前页 == 那次跳转的目标页（query+city 一致）」且 30 秒内，
  //     不再是「任意页面 90 秒内刷新都算」。
  //
  // 另外两个曾导致「跳转后反而不自动采集」的坑也保留着修复：
  //  1) BOSS 搜索页是 SPA，落地瞬间列表常未渲染 → 轮询等待而不是判一次就放弃；
  //  2) 站点会改写地址栏（复数 /jobs、旧版 /c<cityCode>/）→ isSearchPage 已放宽。
  // 且真正触发时无论成败都在面板给常驻提示，绝不静默。

  // A) 令牌一次性消费（务必在任何 return / 异常之前完成）
  if (autoCollect) await JH.set({ autoCollect: false });

  // B) 判定本次页面加载的来源
  let navType = 'navigate';
  try {
    const e = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (e && e.type) navType = e.type;
    else if (performance.navigation && performance.navigation.type === 1) navType = 'reload';
  } catch (e) {}
  const userInitiated = (navType === 'reload' || navType === 'back_forward');

  // C) 兜底触发条件：仅限锁定到那次跳转目标页、且刚跳过来不久
  const navFresh = !!(collectNav && collectNav.ts && Date.now() - collectNav.ts < 30000
                      && JHCollector.isNavTarget(collectNav.url));

  if (userInitiated) {
    // 用户手动刷新 / 前进后退：绝不自动采集，并顺手清掉可能残留的跳转记录
    if (collectNav) await JH.set({ collectNav: null });
  } else if (autoCollect || navFresh) {
    if (!JHPanel.el) {
      // 面板没挂上就别硬跑，避免无提示的黑箱行为
      await JH.set({ collectNav: null });
      console.warn('[JobHunter] 检测到自动采集任务，但面板未初始化，已取消续跑');
    } else {
      JHPanel.open();
      JHPanel.status('<span class="jh-spin"></span>检测到自动采集任务，正在等待搜索结果页加载…', 'info', 0);

      let ready = false;
      for (let i = 0; i < 24; i++) { // 最长等约 12 秒
        if (JHCollector.isSearchPage() && JH.$$(JH_SELECTORS.jobCard).length) { ready = true; break; }
        await JH.sleep(500);
      }
      // 卡片没渲染出来但确实落在搜索页 → 仍然交给采集流程（其内部还会滚动重试）
      if (!ready && JHCollector.isSearchPage()) ready = true;

      if (ready) {
        JHPanel.status('<span class="jh-spin"></span>已落地搜索结果页，即将自动开始采集…', 'info', 0);
        await JH.sleep(1200);
        JHPanel.startCollect();
      } else {
        await JH.set({ collectNav: null });
        JHPanel.status(`自动采集未启动：当前页面不是岗位搜索结果页（path=${location.pathname}）。请确认已登录并停留在搜索结果页后，手动点「岗位采集」`, 'warn', 0);
      }
    }
  }
})();
