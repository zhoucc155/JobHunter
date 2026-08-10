// ============================================================
// utils.js — 通用工具：存储、延迟、DOM 查询、风控检测
// ============================================================

const JH = {};

/** 随机整数 [min, max] */
JH.rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** 等待 ms 毫秒 */
JH.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 随机等待 [minMs, maxMs] */
JH.randSleep = (minMs, maxMs) => JH.sleep(JH.rand(minMs, maxMs));

/**
 * 判断元素是否属于插件自身 UI（面板/悬浮球）。
 * 教训：宽泛选择器（如 'textarea'、'input[type="file"]'）曾匹配到插件自己的简历输入框/上传框，
 * 导致文字打进自己面板、图片塞进自己控件，BOSS 页面什么都没收到却上报"成功"。
 * 因此所有页面查询必须排除插件自身 DOM。
 */
JH.isOwnEl = (el) => {
  try { return !!(el && el.closest && el.closest('#jh-panel, #jh-fab')); } catch (e) { return false; }
};

/** 按选择器数组依次尝试，返回第一个命中的元素（自动排除插件自身 DOM） */
JH.$ = (selArr, root = document) => {
  for (const sel of selArr) {
    try {
      const els = root.querySelectorAll(sel);
      for (const el of els) if (!JH.isOwnEl(el)) return el;
    } catch (e) { /* 非法选择器跳过 */ }
  }
  return null;
};

/** 按选择器数组依次尝试，返回第一个命中的元素列表（自动排除插件自身 DOM） */
JH.$$ = (selArr, root = document) => {
  for (const sel of selArr) {
    try {
      const els = Array.from(root.querySelectorAll(sel)).filter((el) => !JH.isOwnEl(el));
      if (els.length) return els;
    } catch (e) { /* skip */ }
  }
  return [];
};

/** 页面正文文本（排除插件自身面板），用于发送结果校验，防止面板里的文案造成误判 */
JH.pageText = () => {
  let t = '';
  try {
    for (const node of document.body.children) {
      if (node.id === 'jh-panel' || node.id === 'jh-fab') continue;
      t += (node.innerText || '');
    }
  } catch (e) { t = document.body.innerText || ''; }
  return t;
};

/**
 * 等待某元素出现（超时返回 null）。
 *
 * 【为什么不用 setTimeout 轮询】详情页是 background 以 active:false 打开的**隐藏标签页**，
 * Chrome 会把隐藏页里的 setTimeout 钳制到「最快每秒一次」。原来每 150ms 轮询一次，实际
 * 每轮要等满 1 秒 —— 元素早就出来了还得干等到整秒对齐。
 * MutationObserver 的回调由 DOM 变更直接派发、**不走定时器、不受节流**，元素一插入立刻接住。
 *
 * 超时兜底仍用 setTimeout（8 秒量级，1 秒粒度无所谓），到点前再查一次再返回 null。
 * MutationObserver 构造失败时自动回退到轮询，保证任何环境都能用。
 */
JH.waitFor = (selArr, timeoutMs = 10000, root = document) => {
  const hit = JH.$(selArr, root);
  if (hit) return Promise.resolve(hit);

  return new Promise((resolve) => {
    let done = false;
    let mo = null;
    let timer = null;
    const finish = (el) => {
      if (done) return;
      done = true;
      if (mo) { try { mo.disconnect(); } catch (e) {} }
      if (timer) clearTimeout(timer);
      resolve(el);
    };

    try {
      mo = new MutationObserver(() => {
        const el = JH.$(selArr, root);
        if (el) finish(el);
      });
      mo.observe(root === document ? (document.documentElement || document) : root,
                 { childList: true, subtree: true });
    } catch (e) { mo = null; }

    // MutationObserver 不可用时的兜底轮询（正常 Chrome 环境走不到这里）
    if (!mo) {
      (async () => {
        while (!done) {
          const el = JH.$(selArr, root);
          if (el) return finish(el);
          await JH.sleep(200);
        }
      })();
    }

    timer = setTimeout(() => finish(JH.$(selArr, root)), timeoutMs);
  });
};

/** chrome.storage.local 读 */
JH.get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));

/** chrome.storage.local 写 */
JH.set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

/** 发消息给 background */
JH.send = (msg) => new Promise((r) => {
  try { chrome.runtime.sendMessage(msg, (resp) => r(resp)); } catch (e) { r(null); }
});

/** 记录最近一次异常结构到 storage，供面板「诊断」读回（BOSS 反调试无法用 F12 时尤其有用） */
JH.setLastError = (info, ctx) => {
  try {
    const entry = { ts: Date.now(), ctx: ctx || '' };
    if (info instanceof Error) {
      entry.kind = 'Error';
      entry.name = info.name || 'Error';
      entry.message = info.message || String(info);
      entry.stack = (info.stack || '').split('\n').slice(0, 4).join('\n');
    } else {
      entry.kind = 'object';
      entry.message = (info && (info.message || String(info))) || String(info);
      try { entry.raw = JSON.parse(JSON.stringify(info)); } catch (e) { entry.raw = String(info); }
    }
    JH.set({ jhLastError: entry });
  } catch (e) { /* storage 不可用时忽略 */ }
};
JH.getLastError = () => JH.get(['jhLastError']).then((r) => r.jhLastError || null);

/** 风控检测：页面是否出现验证码/安全校验 */
JH.riskDetected = () => {
  if (JH_RISK_URL_PATTERNS.some((p) => location.href.includes(p))) return true;
  if (JH.$(JH_SELECTORS.captchaHints)) return true;
  if (/验证|安全检查/.test(document.title)) return true;
  return false;
};

/**
 * 模拟真人平滑滚动一段距离。
 * @param {number} distance 滚动总距离(px)
 * @param {object} [pace] 可选节奏参数。不传时与原行为完全一致（6~12 步、每步 80~260ms），
 *                        投递流程与列表页滚动均沿用默认值，勿改；
 *                        仅详情页补采传快速档以提速（步数少、间隔短，但保留分步+抖动的真人特征）。
 * @param {number} [pace.minSteps=6] @param {number} [pace.maxSteps=12]
 * @param {number} [pace.minGap=80]  @param {number} [pace.maxGap=260]
 * @param {boolean} [pace.skipLastGap=false] 跳过最后一步之后的等待。
 *        隐藏标签页里每次 sleep 都被 Chrome 钳到 ≥1 秒，滚完最后一下再干等 1 秒毫无意义。
 *        **默认关闭**：投递流程与列表页滚动行为一字不变，仅详情页补采开启。
 */
JH.humanScroll = async (distance, pace) => {
  const p = pace || {};
  const steps = JH.rand(p.minSteps || 6, p.maxSteps || 12);
  const minGap = p.minGap || 80;
  const maxGap = p.maxGap || 260;
  const per = distance / steps;
  for (let i = 0; i < steps; i++) {
    window.scrollBy(0, per + JH.rand(-20, 20));
    if (p.skipLastGap && i === steps - 1) break;
    await JH.randSleep(minGap, maxGap);
  }
};

/**
 * 用原生 setter 给 textarea/input 赋值（Vue/React 的 v-model 只认原生 setter + input 事件，
 * 直接 el.value = x 会被框架忽略，导致"看着有字、发送时却是空的"）
 */
JH.setNativeValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
};

/** 模拟真人逐字输入（兼容 textarea/input 与 contenteditable。2026新版聊天页输入框是 textarea） */
JH.humanType = async (el, text) => {
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // textarea：逐字用原生 setter 累加赋值 + input 事件，Vue 才能感知；换行直接写入 \n，不会触发发送
    let cur = el.value || '';
    for (const ch of text) {
      cur += ch;
      JH.setNativeValue(el, cur);
      await JH.randSleep(25, 90);
    }
    return;
  }
  // contenteditable div（旧版聊天输入框）
  for (const ch of text) {
    if (ch === '\n') {
      // 段落换行：insertLineBreak 等效 Shift+Enter，不会触发发送；失败则退化为文本换行
      if (!document.execCommand('insertLineBreak')) document.execCommand('insertText', false, '\n');
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
    }
    await JH.randSleep(25, 90);
  }
};

/** dataURL 转 File 对象 */
JH.dataUrlToFile = (dataUrl, filename) => {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new File([u8], filename, { type: mime });
};

/** 追加投递日志并更新累计统计 */
JH.appendLog = async (entry) => {
  const { logs = [], stats = { success: 0, skip: 0, fail: 0 } } = await JH.get(['logs', 'stats']);
  logs.unshift({ time: new Date().toLocaleString('zh-CN'), ...entry });
  if (entry.result === 'success') stats.success++;
  else if (entry.result === 'skip') stats.skip++;
  else if (entry.result === 'fail') stats.fail++;
  await JH.set({ logs: logs.slice(0, 500), stats });
};

/** 今日投递计数 */
JH.getDailyCount = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { dailyCount = {} } = await JH.get(['dailyCount']);
  return dailyCount.date === today ? dailyCount.count : 0;
};

JH.incDailyCount = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { dailyCount = {} } = await JH.get(['dailyCount']);
  const count = (dailyCount.date === today ? dailyCount.count : 0) + 1;
  await JH.set({ dailyCount: { date: today, count } });
  return count;
};
