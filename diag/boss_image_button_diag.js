// =============================================================
// BOSS 聊天页「发送图片」按钮 DOM 诊断脚本
// -------------------------------------------------------------
// 用途：判断 BOSS 发送图片究竟是「标准 <input type=file>」(→ 路线 A: CDP 注入)
//       还是「非标准实现」(→ 路线 B: MAIN 世界 File 注入)。
//       只有摸清楚 DOM，才能拍板图片投递怎么做。
//
// 用法：
//   1. 打开任意一个 BOSS 聊天会话页（点过「立即沟通」或打开已有对话，
//      页面上能看到输入框 + 发送图片按钮）。
//   2. 按 F12 打开开发者工具 → Console（控制台）。
//   3. 把本文件【全部内容】粘贴进去，回车执行。
//   4. 控制台会打印结构化报告，并自动尝试复制 + 下载 boss_image_diag.txt。
//   5. 把控制台里的「=== BOSS 图片按钮诊断报告 ===」整段贴回来即可。
//
// 可选：执行后控制台里可手动调用  window.JH_diagClickImage()
//       它会点击最可能的图片按钮，并在 600ms 后重新扫描文件输入，
//       用来验证「点击后才动态生成 <input type=file>」的情况。
// =============================================================

(function () {
  'use strict';

  const report = {
    meta: {},
    chatContainer: null,
    fileInputs: [],
    imageTriggerCandidates: [],
    uploadPreviewHints: [],
    notes: []
  };

  report.meta.url = location.href;
  report.meta.title = document.title;
  report.meta.ts = new Date().toISOString();
  report.meta.hasJQuery = typeof window.jQuery !== 'undefined';

  // 生成可读的 css 路径（最多向上 8 层）
  function cssPath(el) {
    if (!el) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) { sel += '#' + cur.id; parts.unshift(sel); break; }
      let sib = 0, same = 0;
      const sibs = cur.parentElement ? Array.from(cur.parentElement.children) : [];
      sibs.forEach((s) => { if (s.tagName === cur.tagName) { same++; if (s === cur) sib = same; } });
      sel += same > 1 ? ':nth-of-type(' + sib + ')' : '';
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // 1) 聊天输入框容器（确认我们现有的 .chat-conversation 选择器是否仍有效）
  const chatSelCandidates = ['.chat-conversation', '.chat-input', '.conversation', '#chat-input', '.im-input', '.chat-editor'];
  let chatEl = null;
  for (const s of chatSelCandidates) {
    const el = document.querySelector(s);
    if (el) { chatEl = el; break; }
  }
  if (chatEl) {
    report.chatContainer = {
      selector: cssPath(chatEl),
      htmlSnippet: chatEl.outerHTML.slice(0, 900)
    };
  } else {
    report.notes.push('未找到聊天输入框容器（候选选择器均无匹配），可能不在聊天页或选择器已变。');
  }

  // 2) 全文档扫描 <input type="file">
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  inputs.forEach((inp) => {
    const cs = getComputedStyle(inp);
    const isHidden = cs.display === 'none' || cs.visibility === 'hidden' ||
      parseFloat(cs.opacity) === 0 || (inp.offsetWidth === 0 && inp.offsetHeight === 0);
    report.fileInputs.push({
      selector: cssPath(inp),
      id: inp.id || '',
      name: inp.name || '',
      className: (inp.className || '').toString(),
      accept: inp.getAttribute('accept') || '',
      multiple: inp.multiple,
      webkitdirectory: inp.hasAttribute('webkitdirectory'),
      capture: inp.getAttribute('capture') || '',
      hidden: isHidden,
      style: inp.getAttribute('style') || '',
      labeledBy: inp.getAttribute('aria-labelledby') || '',
      forAttribute: inp.getAttribute('for') || ''
    });
  });
  if (!inputs.length) {
    report.notes.push('全文档未找到任何 <input type="file">。图片按钮可能并非标准文件输入（如 canvas/剪贴板方案），路线 A(CDP 注入) 可能失效，需走路线 B(MAIN 世界注入)。');
  } else {
    report.notes.push('已找到 ' + inputs.length + ' 个 <input type="file">，重点看 hidden=true 且 accept 含 image 的那个——它极可能就是图片按钮背后的隐藏输入，CDP 可直接喂文件。');
  }

  // 3) 候选「发送图片」触发按钮（按关键词 + 文字长度过滤，避免把大容器算进来）
  const kw = ['图片', '相册', '发图', '照片', 'image', 'photo', 'album', 'picture', 'img'];
  const allEls = Array.from(document.querySelectorAll('button, [role="button"], a, label, div, span'));
  const seen = new Set();
  allEls.forEach((el) => {
    const txt = (el.textContent || '').trim();
    if (txt.length > 30) return;
    const title = el.getAttribute('title') || '';
    const aria = el.getAttribute('aria-label') || '';
    const hay = (txt + ' ' + title + ' ' + aria).toLowerCase();
    if (!kw.some((k) => hay.includes(k.toLowerCase()))) return;
    if (seen.has(el)) return;
    seen.add(el);

    // 关联文件输入：自身是 label[for] 指向 file input，或其父/兄弟里存在 file input
    let relatedInput = '';
    if (el.tagName === 'LABEL' && el.getAttribute('for')) {
      const f = document.getElementById(el.getAttribute('for'));
      if (f && f.tagName === 'INPUT' && f.type === 'file') relatedInput = cssPath(f);
    }
    if (!relatedInput && el.parentElement) {
      const sib = el.parentElement.querySelector('input[type="file"]');
      if (sib) relatedInput = cssPath(sib);
    }

    report.imageTriggerCandidates.push({
      tag: el.tagName.toLowerCase(),
      text: txt.slice(0, 40),
      title,
      ariaLabel: aria,
      hasFor: el.getAttribute('for') || '',
      relatedFileInput: relatedInput,
      htmlSnippet: el.outerHTML.slice(0, 500)
    });
  });
  if (!report.imageTriggerCandidates.length) {
    report.notes.push('未找到文字/title/aria 含图片关键词的触发元素。可能是纯图标按钮（无文字），需要人工在控制台用元素选择器再抓一次。');
  }

  // 4) 上传预览 / 确认 UI 提示（选文件后是否出现预览+「发送」按钮很关键）
  const prevKw = ['preview', 'upload', 'send-img', 'img-preview', 'confirm', '预览', '发送图片'];
  const hints = [];
  document.querySelectorAll('*').forEach((el) => {
    const cls = (el.className || '').toString().toLowerCase();
    if (prevKw.some((k) => cls.includes(k)) && el.children.length < 6) {
      hints.push({ selector: cssPath(el), class: (el.className || '').toString(), text: (el.textContent || '').trim().slice(0, 30) });
    }
  });
  report.uploadPreviewHints = hints.slice(0, 12);
  if (report.uploadPreviewHints.length) {
    report.notes.push('发现上传预览/确认相关元素 ' + report.uploadPreviewHints.length + ' 个——若选图后出现预览且需点「发送」确认，CDP 注入后还需再点一次确认按钮。');
  }

  // ---- 输出 ----
  const txt = '=== BOSS 图片按钮诊断报告 ===\n' + JSON.stringify(report, null, 2);
  console.log(txt);
  console.log('%c复制下方 JSON 回贴给开发即可：', 'color:#0f766e;font-weight:bold');
  console.log(JSON.stringify(report));

  try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (e) {}
  try {
    const blob = new Blob([txt], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'boss_image_diag.txt';
    a.click();
  } catch (e) {}

  // 暴露手动验证函数：点击最可能的图片按钮后再扫一次文件输入
  window.JH_diagClickImage = function () {
    const cand = report.imageTriggerCandidates[0];
    if (!cand) { console.log('没有候选图片按钮可点'); return; }
    const needle = (cand.text || cand.ariaLabel || cand.title || '').toLowerCase();
    const els = Array.from(document.querySelectorAll('button,[role=button],a,label,div,span')).filter((e) => {
      const h = ((e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase();
      return h.includes(needle) && (e.textContent || '').trim().length <= 30;
    });
    if (els[0]) {
      console.log('点击候选图片按钮：', els[0]);
      els[0].click();
      setTimeout(() => {
        const after = document.querySelectorAll('input[type=file]');
        console.log('点击后文件输入数量：', after.length);
        console.log(after);
      }, 600);
    }
  };

  console.log('%c已挂载 window.JH_diagClickImage() —— 想验证「点击后才动态生成文件输入」，可在控制台调用它。', 'color:#6366f1');
})();
