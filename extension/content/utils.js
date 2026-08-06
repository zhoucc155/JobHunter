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

/** 等待某元素出现（超时返回 null） */
JH.waitFor = async (selArr, timeoutMs = 10000, root = document) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = JH.$(selArr, root);
    if (el) return el;
    await JH.sleep(300);
  }
  return null;
};

/** chrome.storage.local 读 */
JH.get = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));

/** chrome.storage.local 写 */
JH.set = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

/** 发消息给 background */
JH.send = (msg) => new Promise((r) => {
  try { chrome.runtime.sendMessage(msg, (resp) => r(resp)); } catch (e) { r(null); }
});

/** 风控检测：页面是否出现验证码/安全校验 */
JH.riskDetected = () => {
  if (JH_RISK_URL_PATTERNS.some((p) => location.href.includes(p))) return true;
  if (JH.$(JH_SELECTORS.captchaHints)) return true;
  if (/验证|安全检查/.test(document.title)) return true;
  return false;
};

/** 模拟真人平滑滚动一段距离 */
JH.humanScroll = async (distance) => {
  const steps = JH.rand(6, 12);
  const per = distance / steps;
  for (let i = 0; i < steps; i++) {
    window.scrollBy(0, per + JH.rand(-20, 20));
    await JH.randSleep(80, 260);
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
