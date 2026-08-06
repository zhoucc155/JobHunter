// ============================================================
// deliver.js — 单阶段投递执行器（在 background 打开的标签页中运行）
// 详情页点击「立即沟通」→ BOSS 原地弹出聊天小窗 → 在小窗内逐字打字并发送文案
// （不再二次拉起聊天页/定位会话；简历图功能已下线）
// ============================================================

const JHDeliver = {

  // ---------- 单阶段：详情页发起沟通，并在弹出的聊天小窗内直接发送文案 ----------
  // 不再二次拉起聊天页：点击「立即沟通」后 BOSS 会原地弹出聊天小窗，直接在其中打字发送即可，
  // 彻底绕开「跳转聊天页 + 定位/打开会话」这一最脆弱、最容易失败的环节。
  async runContactStage(task) {
    await JH.randSleep(1800, 3500);

    if (JH.riskDetected()) {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, risk: true, reason: '安全验证' });
      return;
    }

    const btn = await JH.waitFor(JH_SELECTORS.detailChatBtn, 8000);
    if (!btn) {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, reason: '未找到「立即沟通」按钮' });
      return;
    }

    const btnText = btn.textContent.trim();
    if (btnText.includes('继续沟通')) {
      // 已经沟通过 → 跳过，防止重复骚扰
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, skip: true, reason: '此前已沟通过该岗位' });
      return;
    }

    // 模拟真人阅读 JD 后再点击
    await JH.humanScroll(JH.rand(200, 500));
    await JH.randSleep(1500, 3000);

    btn.click();

    // 等聊天小窗出现（最多 15s）：仅用于"确认进入对话上下文"，超时也不致命，
    // 后面会退而求其次整页找输入框。命中即作为 scoped 范围，提升输入框定位精度。
    const dialog = await this.waitForDialog(task, 15000);
    if (JH.riskDetected()) {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, risk: true, reason: '安全验证' });
      return;
    }
    await JH.randSleep(800, 1800); // 等小窗输入框渲染

    // 定位输入框：小窗范围内优先，失败再整页兜底（覆盖小窗容器类名不匹配的情况）
    let input = await this.findChatInput(10000, dialog || undefined);
    if (!input) input = await this.findChatInput(5000);
    if (!input) {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, reason: '点击「立即沟通」后找不到可输入的消息框，未能自动发送' });
      return;
    }

    // 逐字拟人打字 + 发送 + 校验（sendText 内含完整逻辑与回车发送）
    const textSent = await this.sendText(task.greeting, input);
    if (textSent) {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: true, reason: '打招呼文案已在聊天小窗发送' });
    } else {
      JH.send({ type: 'CONTACT_DONE', jobId: task.jobId, ok: false, reason: '文案已输入但未能成功发送（发送方式可能已变化）' });
    }
  },

  /** 等待聊天小窗弹出（点击「立即沟通」后 BOSS 原地弹出的对话浮层）。
   *  仅用于"确认已进入对话上下文"，超时返回 null 也不可怕——调用方会退而求其次整页找输入框。
   *  注意：本方法不自行发送 CONTACT_DONE，风控交由调用方统一处理。 */
  async waitForDialog(task, timeoutMs = 15000) {
    const sel = ['.dialog-wrap', '.chat-block', '[class*="chat-dialog"]', '[class*="chat-window"]', '[class*="im-dialog"]', '.chat-conversation'];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const d = JH.$(sel);
      if (d) return d;
      await JH.sleep(400);
    }
    return null;
  },




  /** 读取输入框当前文本（兼容 contenteditable 与 textarea） */
  getInputText(input) {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    return input.textContent || '';
  },

  /** 派发完整回车事件链（keydown/keypress/keyup）。新版聊天页无发送按钮，回车是唯一发送方式 */
  pressEnter(input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  },

  /** 统计页面消息区的图片数量（排除插件面板自身的简历预览图，防止校验误判） */
  countPageImages() {
    let n = 0;
    for (const img of document.images) if (!JH.isOwnEl(img)) n++;
    return n;
  },

  /**
   * 定位"发送图片"用的 file input，排除插件自身与"上传简历"弹窗控件。
   * 优先级：聊天主区 > 聊天小窗([class*="chat"]) > 非简历弹窗的全局 file input。
   * 教训：诊断证实页面存在两类 file input——聊天工具栏的发图片、上传简历弹窗的简历上传，
   * 后者祖先链是 .upload-resume-dialog，必须排除，否则图片会被塞进简历弹窗而非发给 HR。
   */
  findFileInput() {
    const cands = [
      '.chat-conversation input[type="file"]',
      '[class*="chat"] input[type="file"]',
      '.dialog-wrap:not(.upload-resume-dialog) input[type="file"]'
    ];
    for (const sel of cands) {
      const el = JH.$(sel);
      if (el) return el;
    }
    const all = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((el) => !JH.isOwnEl(el) && !el.closest('.upload-resume-dialog'));
    return all[0] || null;
  },

  /**
   * 定位聊天页输入框（多级兜底，不依赖 BOSS 类名，规避其反复改版）。
   * ① 直接选择器（chatInput 数组，已排除插件自身）；
   * ② 任意 [contenteditable]（兼容 plaintext-only 等新取值）；
   * ②b div[role="textbox"] / 非 file 的 input（部分版本输入框形态）；
   * ②c 同源 iframe 内的输入框（聊天可能被包进 iframe）；
   * ③ 就近反推：从简历/图片上传按钮向上遍历祖先，取其内的可编辑元素（最稳健）。
   * 注意：输入框只在「点开会话后」渲染，调用方需先确保已点开目标会话。
   */
  /** 定位输入框（多级兜底，不依赖 BOSS 类名，规避其反复改版）。
   *  @param {number} timeoutMs 超时毫秒
   *  @param {Element|null} root 限定搜索范围（如聊天小窗容器）；为 null 时整页搜索。
   *  小窗内优先从 root 内查找，避免命中详情页其它可编辑元素。 */
  async findChatInput(timeoutMs = 6000, root = null) {
    const scope = root || document;
    const trySelectors = () => {
      let el = JH.$(JH_SELECTORS.chatInput, scope);
      if (el) return el;
      el = JH.$('[contenteditable]', scope);
      if (el && el.getAttribute('contenteditable') !== 'false' && el !== document.body) return el;
      el = JH.$('div[role="textbox"], input:not([type="file"])', scope);
      if (el) return el;
      // 同源 iframe 内探测
      for (const f of document.querySelectorAll('iframe')) {
        try {
          const fd = f.contentDocument;
          if (!fd) continue;
          const ie = fd.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), div[role="textbox"], input:not([type="file"])');
          if (ie) return ie;
        } catch (e) { /* 跨域忽略 */ }
      }
      return null;
    };

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let el = trySelectors();
      if (el) return el;
      // ③ 就近反推：上传按钮 → 向上找输入区容器 → 取其中可编辑元素
      // 2026-07-29 修正：优先在 .chat-conversation 容器内找 file input，排除"上传简历"弹窗控件
      const fileInput = this.findFileInput();
      if (fileInput) {
        let node = fileInput.parentElement;
        for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
          let edit = node.matches && node.matches('[contenteditable]:not([contenteditable="false"]), textarea, input:not([type="file"]), div[role="textbox"]')
            ? node
            : node.querySelector('[contenteditable]:not([contenteditable="false"]), textarea, input:not([type="file"]), div[role="textbox"]');
          // 最后手段：连 contenteditable/textarea 都没有时，在输入区容器里挑一个看起来像输入框的 div/span
          if (!edit) {
            for (const d of node.querySelectorAll('div, span')) {
              if (d !== fileInput && !JH.isOwnEl(d) && d.offsetHeight > 20 && /input|editor|text|chat|msg|reply/i.test(d.className || '')) { edit = d; break; }
            }
          }
          if (edit && !JH.isOwnEl(edit)) return edit;
        }
      }
      await JH.sleep(300);
    }
    return null;
  },

  /**
   * 逐字输入文案并发送。
   * 双重校验：① 输入后确认文字真的进入了输入框（execCommand 对部分输入框无效）；
   * ② 发送后确认文案片段确实出现在页面会话消息区，才算发送成功。
   * @param {string} text 文案
   * @param {Element|null} input 已定位的输入框（调用方提前定位好，避免重复查找/范围漂移）
   */
  async sendText(text, input = null) {
    try {
      if (!input) input = await this.findChatInput(6000);
      if (!input) return false;

      await JH.humanType(input, text);
      await JH.randSleep(600, 1500);

      // 校验①：文字确实进入了输入框；没进去则改用兜底注入
      const snippet = text.replace(/\s+/g, '').slice(0, 10);
      if (!this.getInputText(input).replace(/\s+/g, '').includes(snippet)) {
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          JH.setNativeValue(input, text);
        } else {
          // contenteditable（含 plaintext-only）：execCommand 注入最稳，框架才认
          input.focus();
          try {
            input.innerHTML = '';
            const range = document.createRange();
            range.selectNodeContents(input);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            if (!document.execCommand('insertText', false, text)) input.textContent = text;
          } catch (e) {
            input.textContent = text;
          }
          input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        await JH.randSleep(400, 800);
        if (!this.getInputText(input).replace(/\s+/g, '').includes(snippet)) return false;
      }

      // 发送：新版聊天页没有发送按钮，靠回车发送（需派发完整 keydown/keypress/keyup 事件链）
      const sendBtn = JH.$(JH_SELECTORS.chatSendBtn);
      if (sendBtn) {
        sendBtn.click();
      } else {
        this.pressEnter(input);
      }

      // 校验②：文案片段出现在页面会话消息区（= 真发出去了）。
      // 注意：contenteditable 输入框发送后不一定自清空，故以"消息区出现文案"为唯一成功判据，
      // 防止因 remain 非空而误判失败；第3秒若仍卡在输入框再补一次回车。
      for (let i = 0; i < 12; i++) {
        await JH.sleep(500);
        const bodyText = JH.pageText().replace(/\s+/g, '');
        if (bodyText.includes(snippet)) return true;
        const remain = this.getInputText(input).replace(/\s+/g, '');
        if (i === 5 && remain) this.pressEnter(input);
      }
      return false;
    } catch (e) {
      return false;
    }
  },

  /**
   * 聊天页选择器诊断 v4（2026-07-29）。
   * 关键修正：之前点 <li> 并不能真正打开会话（点开后右侧仍是 .chat-no-data 空态，
   * URL 反而跳成 ?ka=header-message）。本版改用「多点击目标穷举 + no-data 空态消失判定」，
   * 找到能真正打开会话的元素，并 dump 打开后的右侧 HTML（含工具栏/发图片按钮/输入框），
   * 以及所有 file input 的祖先链（区分"上传简历弹窗"与"聊天工具栏发图片"）。
   */
  async buildChatDiagnostics() {
    const L = [];
    L.push('=== JobHunter 聊天页诊断报告 ===');
    L.push('URL: ' + location.href.split('?')[0]);
    L.push('时间: ' + new Date().toLocaleString('zh-CN'));
    L.push('诊断版本: chat-diag-v5 (editorDump+mainWorldInject)');

    const count = (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => !JH.isOwnEl(el)).length;
    const dumpCounts = (tag) => {
      L.push(`[${tag}] textarea=${count('textarea')} contenteditable=${count('[contenteditable]')} role=textbox=${count('div[role="textbox"]')} input非file=${count('input:not([type="file"])')} iframe=${count('iframe')} file=${count('input[type="file"]')}`);
    };
    const noData = () => !!document.querySelector('.chat-conversation .chat-no-data');

    L.push('--- 点开会话前计数 ---');
    dumpCounts('before');
    const convs = JH.$$(JH_SELECTORS.chatConvList);
    L.push(`会话项数量: ${convs.length}`);

    // 多目标穷举：依次尝试 li 自身 / .friend-content / .friend-content-warp / .title-box / .name-box
    // 判定标准：右侧 .chat-no-data 空态消失（=会话被真正打开）
    const candSel = [null, '.friend-content', '.friend-content-warp', '.title-box', '.name-box'];
    let opened = false, openedBy = '', openedConvIdx = -1;
    for (let ci = 0; ci < Math.min(convs.length, 3) && !opened; ci++) {
      const conv = convs[ci];
      for (const sel of candSel) {
        const target = sel ? JH.$(sel, conv) : conv;
        if (!target) continue;
        const was = noData();
        target.click();
        await JH.randSleep(2000, 2200);
        const now = noData();
        L.push(`  会话#${ci} 点「${sel || 'li自身'}」: no-data ${was}→${now}`);
        if (was && !now) { opened = true; openedBy = sel || 'li自身'; openedConvIdx = ci; break; }
        if (!was && !now && document.querySelector('.chat-conversation [class*="chat-"]')) { opened = true; openedBy = sel || 'li自身'; openedConvIdx = ci; break; }
      }
    }
    L.push(`--- 打开会话结果: ${opened ? '成功（会话#' + openedConvIdx + '，点击目标=' + openedBy + '）' : '失败：所有目标均未打开会话'} ---`);

    L.push('--- 点开会话后计数 ---');
    dumpCounts('after');
    L.push(`当前 URL: ${location.href}`);

    // dump 右侧聊天主区（打开后应含工具栏/输入框/发图片按钮）
    L.push('--- 右侧聊天主区 HTML（打开会话后）---');
    const main = document.querySelector('.chat-conversation');
    if (main) {
      L.push(main.outerHTML.slice(0, 5000));
    } else {
      L.push('(未找到 .chat-conversation)');
    }

    // 所有 file input 的祖先链（区分"上传简历弹窗"与"聊天工具栏发图片"）
    L.push('--- 所有 file input 祖先链（区分输入区）---');
    const files = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => !JH.isOwnEl(el));
    L.push(`file input 总数: ${files.length}`);
    files.forEach((f, i) => {
      L.push(`  file#${i}:`);
      let node = f;
      for (let k = 0; k < 8 && node; k++, node = node.parentElement) {
        L.push(`    层级${k}: <${node.tagName} class="${node.className}">`);
      }
    });

    // 图片发送按钮专项（图片投递功能前置诊断：判定是否为标准 <input type=file>）
    L.push('--- 图片发送按钮专项（图片投递前置）---');
    const imgKw = ['图片', '相册', '发图', '照片', 'image', 'photo', 'album', 'picture', 'img'];
    const imgCands = Array.from(document.querySelectorAll('button, [role="button"], a, label, div, span'))
      .filter((el) => !JH.isOwnEl(el) && (el.textContent || '').trim().length <= 30)
      .map((el) => {
        const t = (el.textContent || '').trim();
        const title = el.getAttribute('title') || '';
        const aria = el.getAttribute('aria-label') || '';
        const hay = (t + ' ' + title + ' ' + aria).toLowerCase();
        return { el, t, title, aria, hit: imgKw.some((k) => hay.includes(k.toLowerCase())) };
      })
      .filter((x) => x.hit);
    L.push(`候选图片触发元素: ${imgCands.length}`);
    imgCands.slice(0, 8).forEach((x, i) => {
      let rel = '';
      if (x.el.tagName === 'LABEL' && x.el.getAttribute('for')) {
        const f = document.getElementById(x.el.getAttribute('for'));
        if (f && f.tagName === 'INPUT' && f.type === 'file') rel = '→ 关联 #' + f.id + ' (file input)';
      }
      if (!rel && x.el.parentElement) {
        const sib = x.el.parentElement.querySelector('input[type="file"]');
        if (sib) rel = '→ 父级含 file input';
      }
      L.push(`  候选#${i}: <${x.el.tagName} class="${x.el.className}"> text="${x.t.slice(0, 30)}" title="${x.title}" aria="${x.aria}" ${rel}`);
      L.push('       outerHTML=' + x.el.outerHTML.slice(0, 400));
    });

    // 所有"非本插件"的 file input 明细（accept / 是否隐藏 / 是否图片型）
    const realFiles = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => !JH.isOwnEl(el));
    L.push(`--- 页面 file input 明细（不含插件自身）: ${realFiles.length} ---`);
    realFiles.forEach((f, i) => {
      const cs = getComputedStyle(f);
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || (f.offsetWidth === 0 && f.offsetHeight === 0);
      const acc = f.getAttribute('accept') || '';
      L.push(`  file#${i}: accept="${acc}" multiple=${f.multiple} hidden=${hidden} id="${f.id}" class="${f.className}" accept含image=${/image/i.test(acc)}`);
    });
    L.push('  结论预判: ' + (realFiles.some((f) => /image/i.test(f.getAttribute('accept') || '') || (() => { const cs = getComputedStyle(f); return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0; })())
      ? '存在隐藏/图片型 file input → 可用 CDP 或 MAIN 世界注入发图（路线可行）'
      : '未发现图片型 file input → 可能为非标准实现，需进一步核实'));

    // 上传预览/确认 UI 线索（选图后是否弹出预览+「发送」确认）
    const prevKw = ['preview', 'upload', 'send-img', 'img-preview', '预览', '发送图片'];
    const prevHints = Array.from(document.querySelectorAll('*'))
      .filter((el) => { const c = (el.className || '').toString().toLowerCase(); return prevKw.some((k) => c.includes(k)) && el.children.length < 6; })
      .slice(0, 8)
      .map((el) => `<${el.tagName} class="${el.className}"> text="${(el.textContent || '').trim().slice(0, 20)}"`);
    if (prevHints.length) L.push('上传预览/确认UI线索: ' + prevHints.join(' | '));

    // iframe 兜底探测
    const frames = Array.from(document.querySelectorAll('iframe'));
    if (frames.length) {
      L.push('--- iframe 探测 ---');
      frames.forEach((f, i) => {
        try {
          const fd = f.contentDocument;
          if (!fd) { L.push(`  iframe#${i}: 无 contentDocument`); return; }
          const fi = fd.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), div[role="textbox"], input:not([type="file"])');
          L.push(`  iframe#${i}: src=${f.src.slice(0, 60)} 输入框=${fi ? fi.outerHTML.slice(0, 220) : '未发现'}`);
        } catch (e) { L.push(`  iframe#${i}: 访问被跨域拦截`); }
      });
    }

    // 编辑区 / 发送按钮结构（图片草稿出现后靠什么发送，需看到真实发送控件）
    L.push('--- 编辑区结构（输入框+发送按钮）---');
    const editor = document.querySelector('.chat-controls, .chat-editor, .message-controls');
    if (editor) {
      L.push(editor.outerHTML.slice(0, 2200));
    } else {
      L.push('(未找到 .chat-controls/.chat-editor/.message-controls，可能会话未真正打开)');
    }

    // 简历图注入探针（不真正注入，仅确认 MAIN world 可达 + 发图片 file input 可命中）
    L.push('--- 简历图注入探针 ---');
    L.push('window.__jhPageWorld 就绪: ' + (typeof window.__jhPageWorld !== 'undefined' && window.__jhPageWorld && typeof window.__jhPageWorld.injectResumeImage === 'function' ? '是' : '否'));
    const probeInput = document.querySelector('.chat-conversation input[type="file"]');
    if (probeInput) {
      L.push('发图片 file input: 命中 (class="' + (probeInput.className || '') + '" accept="' + (probeInput.getAttribute('accept') || '') + '")');
    } else {
      L.push('发图片 file input: 未命中 .chat-conversation input[type="file"]');
    }
    L.push('chrome.scripting 可用: ' + (typeof chrome !== 'undefined' && chrome.scripting ? '是' : '否'));

    return L.join('\n');
  },

  /**
   * 详情页选择器诊断（detail-diag-v1，2026-07-29）。
   * 投递实际发生在详情页：点「立即沟通」→ 原地弹出的聊天小窗内打字发送。
   * 本诊断 dump：①「立即沟通」按钮候选命中情况与结构 ②点击后是否跳转聊天页 ③
   * 小窗/聊天容器的 HTML ④页面内所有 contenteditable 输入框 ⑤模拟 jhFindInput 会命中谁。
   * 注：点「立即沟通」只会打开聊天小窗、不会真正发送消息，故可安全用于诊断。
   */
  async buildDetailDiagnostics() {
    const L = [];
    const push = (s) => L.push(s);
    push('=== JobHunter 详情页诊断报告 (detail-diag-v1) ===');
    push('URL: ' + location.href.split('?')[0]);
    push('时间: ' + new Date().toLocaleString('zh-CN'));
    push('页面标题: ' + document.title);

    const isOwn = (el) => JH.isOwnEl(el);

    // ① 「立即沟通」按钮候选
    push('--- 「立即沟通」按钮候选 (detailChatBtn) ---');
    let btn = null, btnSel = '';
    for (const s of JH_SELECTORS.detailChatBtn) {
      const e = JH.$(s);
      const hit = e && !isOwn(e);
      push('  ' + s + ': ' + (hit ? '命中' : '未命中'));
      if (hit && !btn) { btn = e; btnSel = s; }
    }
    if (btn) {
      push('  命中选择器: ' + btnSel);
      push('  按钮文本: "' + (btn.textContent || '').trim().slice(0, 40) + '"');
      push('  按钮可见(宽高>0): ' + (btn.offsetWidth > 0 && btn.offsetHeight > 0));
      push('  按钮 outerHTML: ' + btn.outerHTML.slice(0, 600));
    } else {
      push('  !! 所有 detailChatBtn 候选均未命中（按钮选择器可能已失效，需更新 selectors.js）');
    }

    // ② 仅静态分析「立即沟通」候选是否跳转（不点击，避免 BOSS 检测到程序化点击后跳转到首页/聊天页，导致诊断失败）
    push('--- 「立即沟通」候选(按文本) 及其标签/href/外层容器（揭示它是原地弹窗还是跳转链接）---');
    const chatText = /立即沟通|打招呼|开始沟通|和我沟通|聊一聊|发消息/i;
    const candidates = Array.from(document.querySelectorAll('a,button')).filter((el) => !isOwn(el) && chatText.test((el.textContent || '').replace(/\s/g, '')));
    if (candidates.length) {
      candidates.slice(0, 6).forEach((e, i) => {
        const href = e.tagName === 'A' ? (e.getAttribute('href') || '') : '(非a标签)';
        let p = e.parentElement, chain = [];
        for (let k = 0; k < 4 && p; k++, p = p.parentElement) chain.push('<' + p.tagName + ' class="' + (p.className || '') + '">');
        push('  候选#' + i + ' tag=' + e.tagName + ' href="' + href + '" text="' + (e.textContent || '').replace(/\s/g, '').slice(0, 20) + '" 外层=' + chain.join(' '));
        push('        outerHTML=' + e.outerHTML.slice(0, 360));
      });
    } else {
      push('  (未发现文本含"立即沟通/打招呼"的 a/button)');
    }

    const count = (sel) => Array.from(document.querySelectorAll(sel)).filter((el) => !isOwn(el)).length;
    push('  [计数] textarea=' + count('textarea') + ' contenteditable=' + count('[contenteditable]') + ' role=textbox=' + count('div[role="textbox"]') + ' input非file=' + count('input:not([type="file"])') + ' iframe=' + count('iframe') + ' file=' + count('input[type="file"]'));

    // ③ 小窗/聊天容器
    push('--- 聊天小窗/容器 (静止详情页通常无；点击「立即沟通」后会出现，届时再在详情页点一次诊断即可看到) ---');
    const containers = ['.dialog-wrap', '.chat-block', '[class*="chat-dialog"]', '[class*="chat-window"]', '.chat-conversation', '.message-controls', '.chat-editor', '.chat-im'];
    let dumped = false;
    for (const s of containers) {
      const e = JH.$(s);
      if (e && !isOwn(e)) { push('  容器 ' + s + ' 命中，HTML:\n' + e.outerHTML.slice(0, 2600)); dumped = true; break; }
    }
    if (!dumped) push('  (未找到任何已知聊天容器)');

    // ④ 所有 contenteditable 输入框
    push('--- 页面内所有 contenteditable 输入框 ---');
    const eds = Array.from(document.querySelectorAll('[contenteditable]')).filter((el) => !isOwn(el) && el.getAttribute('contenteditable') !== 'false');
    if (eds.length) {
      eds.forEach((e, i) => push('  editable#' + i + ' tag=' + e.tagName + ' class="' + (e.className || '') + '" outerHTML=' + e.outerHTML.slice(0, 300)));
    } else {
      push('  (无 contenteditable)');
    }

    // ⑤ 模拟 jhFindInput 会命中谁
    push('--- jhFindInput 模拟结果 (background.js 用同样选择器) ---');
    const simSels = ['.chat-conversation [contenteditable]', '.chat-editor [contenteditable]', '[contenteditable]:not([contenteditable="false"])', 'textarea', 'input:not([type="file"])'];
    let found = null;
    for (const s of simSels) {
      const e = JH.$(s);
      if (e && !isOwn(e)) { found = s; break; }
    }
    push('  会命中的选择器(静止详情页): ' + (found || '(无 — 静止态无聊天小窗符合预期；点击「立即沟通」后输入框才出现，届时 jhFindInput 会重新解析)'));

    return L.join('\n');
  }
};
