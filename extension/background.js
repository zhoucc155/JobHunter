// ============================================================
// background.js — Service Worker
// 职责：DeepSeek API 调用、采集/投递的标签页调度、状态机管理
// ============================================================

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// 复用 content 侧的城市编码表（selectors.js 为纯数据、无 DOM 依赖，可安全在 SW 内导入），
// 避免在 background 里重复维护一份 JH_CITY_CODES 造成漂移。
try { importScripts('content/selectors.js'); } catch (e) { /* 导入失败时下方有兜底 */ }

// ---------- 小工具 ----------
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const sSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));

// ============================================================
// 工具栏图标点击 → 通知当前页面切换面板
// ============================================================
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('zhipin.com')) {
    // 不在 BOSS 页面时：按【已保存的采集配置】直接打开「关键词+城市」搜索页。
    // 旧实现固定打开推荐页 /web/geek/job-recommend，两个问题：
    //   ① 推荐页岗位与采集配置完全无关（BOSS 自己的推荐逻辑）；
    //   ② 其路径同样含 "/web/geek/job" 片段，会被采集侧的宽松判断误认成搜索页，
    //      于是点「岗位采集」时不再跳转搜索，直接抓推荐页岗位 → 配置形同虚设。
    const { config = {} } = await sGet(['config']);
    const kw = (config.jobKeywords || '').trim();
    const city = ((config.cities || '').split(/[,，]/)[0] || '').trim();
    let url = 'https://www.zhipin.com/web/geek/job-recommend';
    if (kw) {
      const params = new URLSearchParams();
      params.set('query', kw);
      const codes = (typeof JH_CITY_CODES !== 'undefined') ? JH_CITY_CODES : {};
      if (codes[city]) params.set('city', codes[city]);
      url = `https://www.zhipin.com/web/geek/job?${params.toString()}`;
    }
    chrome.tabs.create({ url });
    return;
  }
  try { chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }); } catch (e) {}
});

// ============================================================
// DeepSeek API 封装
// ============================================================
async function callDeepSeek(messages, apiKey, jsonMode = false) {
  const body = {
    model: 'deepseek-chat',
    messages,
    temperature: jsonMode ? 0.2 : 0.8,
    max_tokens: 1000
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`DeepSeek API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

/** 匹配度分析：JD × 简历 → {score, reason, keywords} */
async function analyzeMatch(job, resumeText, apiKey) {
  // 评分卡(4正向维度加权) + 负向扣分机制 + few-shot(锚点80/60/30)：缓解分数偏高与扎堆
  const SYSTEM = [
    '你是资深HR和职业规划师。根据岗位JD与候选人简历，严格评估匹配度。',
    '',
    '【评分卡】先按以下 4 个维度评估匹配度（各 0-100），加权合成基准分：',
    '- 岗位核心要求匹配 权重35%：JD列出的关键职责、硬技能、方法论，候选人是否具备',
    '- 项目/经验匹配 权重30%：相关项目年限、规模、量化成果、与JD贴近度',
    '- 背景/行业匹配 权重20%：学历专业、行业领域、平台类型契合度',
    '- 软性/加分项 权重15%：语言、地域、特殊资源、证书等',
    '基准分 = 四舍五入(核心*0.35 + 经验*0.30 + 背景*0.20 + 加分*0.15)',
    '',
    '【负向扣分】检查候选人与JD的明显差距，从基准分中扣除（各项累加，总扣分上限30）：',
    '- 核心能力缺失（缺少关键证据）：JD要求的关键能力候选人明显不具备，扣3-10分（缺失越多扣越多）',
    '- 平台/行业差异：JD要求行业/平台/业务类型候选人完全不沾边，扣5-8分',
    '- 职能偏移：岗位职能方向与候选人经验方向明显偏离（如策略产品 vs 执行运营），扣3-7分',
    '- 经验/级别不匹配（硬性缺失）：JD明确要求X年经验或某级别，候选人明显不满足，扣2-5分',
    '最终 score = 基准分 - 负向扣分（下限0，上限100）',
    '',
    '【分数段定义】',
    '90-100 = JD几乎为候选人量身定做',
    '80-89  = 核心要求高度满足，可快速上手',
    '70-79  = 大部分匹配，有1-2项明显短板',
    '60-69  = 勉强相关，需较大调整',
    '<60    = 有明显偏离或硬性缺失',
    '',
    '【输出要求】严格输出一个 JSON 对象（不要 markdown、不要解释文字）：',
    '{"score": 0-100整数, "keywords": ["JD核心能力关键词,最多6个"], "reason": "一句话评估理由,30字内", "dims": {"core":0-100,"exp":0-100,"bg":0-100,"bonus":0-100}, "penalty": {"missing":0-10,"industry":0-8,"shift":0-7,"level":0-5}}',
    '必须基于真实匹配点评分，不得无依据虚高；各维度须反映真实差距，不得全部趋同；负向扣分须有依据，不可随意抬高。'
  ].join('\n');

  // few-shot：贴合候选人（社区/创作者/内容运营方向），锚点钉在 80/60/30 三档
  const fewshot = [
    {
      role: 'user',
      content: '【岗位】创作者生态运营专家｜某互联网公司｜25-40K\n【JD】\n负责创作者生态体系建设，制定创作者成长激励机制；策划创作者活动提升活跃与留存；搭建创作者分层运营体系；联动内容团队孵化优质创作者。要求：3年以上社区/创作者运营经验，熟悉活动策划与用户分层，有从0到1搭建经验者优先。\n\n【候选人简历】\n7年社区与创作者运营经验。曾主导创作者成长体系从0搭建，将培养周期从3个月缩短至1个月，新创作者7日留存提升40%；策划多场创作者活动单场UV破50万；搭建官方MCN，深度连接50+核心创作者。'
    },
    {
      role: 'assistant',
      content: '{"score": 80, "keywords": ["创作者运营","社区增长","活动策划","用户分层"], "reason": "核心技能与项目经验高度对口，能力可迁移", "dims": {"core":82,"exp":84,"bg":72,"bonus":78}, "penalty": {"missing":0,"industry":0,"shift":0,"level":0}}'
    },
    {
      role: 'user',
      content: '【岗位】内容策略产品经理｜某内容平台｜20-35K\n【JD】\n负责内容生态策略规划，制定内容分发与质量规则；联动运营与算法团队优化内容供给；要求：有内容/社区运营经验，具备策略思维与数据分析能力，独立负责过策略规划。\n\n【候选人简历】\n5年内容社区运营经验，负责过内容活动策划与创作者运营，具备基础数据分析能力；偏执行落地，较少独立负责策略规划，无产品经理title。'
    },
    {
      role: 'assistant',
      content: '{"score": 60, "keywords": ["内容策略","社区运营","数据分析"], "reason": "相关经验充足但偏执行层，缺策略规划与产品title", "dims": {"core":72,"exp":68,"bg":66,"bonus":58}, "penalty": {"missing":0,"industry":0,"shift":5,"level":3}}'
    },
    {
      role: 'user',
      content: '【岗位】AI 算法工程师（推荐方向）｜某科技公司｜30-50K\n【JD】\n负责推荐/排序模型的设计、训练与上线；精通深度学习、PyTorch/TensorFlow；有大规模特征工程与AB实验经验。要求：计算机/数学相关硕士以上，2年以上算法落地经验。\n\n【候选人简历】\n3年内容运营经验，负责社区内容策划与用户增长；熟练使用运营工具与数据分析，无算法/建模背景，未参与过模型开发。'
    },
    {
      role: 'assistant',
      content: '{"score": 30, "keywords": ["深度学习","模型训练","算法工程"], "reason": "职能完全偏离，核心能力与行业均不沾边", "dims": {"core":50,"exp":45,"bg":55,"bonus":60}, "penalty": {"missing":8,"industry":6,"shift":5,"level":3}}'
    }
  ];

  const prompt = [
    { role: 'system', content: SYSTEM },
    ...fewshot,
    { role: 'user', content: `【岗位】${job.title}｜${job.company}｜${job.salary}\n【JD】\n${(job.jd || '').slice(0, 2500)}\n\n【候选人简历】\n${resumeText.slice(0, 2500)}` }
  ];
  const content = await callDeepSeek(prompt, apiKey, true);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // 兜底：模型偶尔在 JSON 外包了 markdown 代码块，抽取第一个 {...} 再解析
    const m = content && content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }
  return {
    score: Math.max(0, Math.min(100, parseInt(parsed.score) || 0)),
    keywords: parsed.keywords || [],
    reason: parsed.reason || ''
  };
}

/** 计字数：不含换行 */
function plainLen(text) {
  return (text || '').replace(/\n/g, '').length;
}

/**
 * 兜底优雅截断：只在句子边界（。！？；）截断，绝不砍在半句中间。
 * 仅当 AI 两轮压缩后仍超长时才会走到这里。
 */
function truncateAtSentence(text, limit) {
  let out = '', n = 0;
  for (const ch of text) {
    if (ch !== '\n') { if (n >= limit) break; n++; }
    out += ch;
  }
  const m = out.match(/^[\s\S]*[。！？；]/);
  if (m) return m[0].replace(/\n+$/, '');
  return out.replace(/\n+$/, '');
}

/**
 * 兜底补收尾：若文案末尾缺少「期待/希望…」类收尾信号，
 * 则补一句标准收尾，并保证总字数 ≤160（必要时先截断主体到句末）。
 */
function ensureClosing(text) {
  const tailWords = ['期待', '希望', '愿', '盼', '静候', '恭候', '望能', '盼望'];
  const segs = (text || '').split(/[。！？；]/).filter(s => s.length > 0);
  const last = segs[segs.length - 1] || '';
  const hasTail = tailWords.some(w => last.includes(w));
  if (hasTail) return (text || '').replace(/\n+$/, '');
  const tail = '期待进一步交流。';
  let base = (text || '').replace(/\n+$/, '');
  if (!/[。！？；]$/.test(base)) base += '。';
  if (plainLen(base + tail) > 160) {
    base = truncateAtSentence(base, 160 - tail.length - 1);
  }
  return base + tail;
}

/** 打招呼文案生成：单段真人风（自然语流、不分段、160字内） */
async function genGreeting(job, resumeText, apiKey, userName) {
  // 开头称呼：优先用用户填写的姓名；未填则要求AI从简历中提取真实姓名；再取不到用"您好！"
  const nameRule = userName
    ? `开头必须以「您好，我是${userName}，」起句，紧接职业定位。`
    : '开头必须以「您好，我是XX，」起句（XX=从简历中提取的候选人真实姓名；若简历中确实没有姓名，则以「您好！」起句），紧接职业定位。绝不允许编造姓名或输出"您好，我是xxx"这类占位符。';
  const sys = [
    '你是候选人本人，在BOSS直聘上给招聘方写首次打招呼消息。像真人通过微信/BOSS首次沟通那样，自然、有温度、不套路。',
    '',
    '【字数约束】全文不含换行，严格不超过150字（目标区间120~150字）。能讲清楚即可，不必凑字数、不要写半句。',
    '',
    '【结构（单段，不分段、不编号、不写"第一/第二"）】一句话自然语流，按此顺序展开：',
    '① 开头：您好，我是{真实姓名}，{年限}+{核心领域}经验，{一句话职业定位}；',
    '② 关联公司：点出你关注到贵司正在做什么 / 这岗位为何吸引你（只基于JD推断，不得编造公司动向）；',
    '③ 最匹配项目：只讲1个最贴合该岗位的项目，含「做了什么 / 解决了什么业务问题 / 用了什么方法 / 拿到什么量化结果（数字必须与简历一致）」；',
    '④ 能力匹配表达：始终以「可迁移能力」建立信心——优先点出与岗位高度契合、能快速复用的经验与方法论（如"我的XX经验/方法论可快速复用到贵司的XX场景"）。若确实存在跨领域或能力缺口，只做极轻量一笔带过（不展开、不自我否定、不写"还在学/不足"），并立即用可迁移能力兜底收束，绝不让缺口成为文案重心；经验完全匹配时不提缺口。',
    '⑤【必须·最高优先级】收尾：必须以一句完整的「期待进一步交流 / 期待为贵司带来价值 / 希望有机会详聊」类收尾结束。即使前面要删减，也绝不可省略收尾句——宁可少讲一个案例也要保住收尾。',
    '',
    '【真人语气要诀】参考下面示例的口吻，但严禁使用示例中的姓名和她的任何数据，必须换成候选人自己的真实简历信息：',
    '示例1：您好，我是周彩妮，我对AIGC创作者运营岗位很感兴趣。我有7年社区和创作者运营经验，曾主导"声音鉴定"创新玩法，上线3天UV达52万+，带动直播DAU提升30%。我擅长通过活动策划和社群运营提升创作者活跃和内容产出，我的用户洞察与活动落地能力可快速复用到AIGC创作者孵化场景，期待为平台挖掘和孵化优质AIGC创作者。',
    '示例2：您好，我是周彩妮，小红书是UGC社区的标杆，我一直在关注其"种草经济"生态。我有7年内容社区运营经验，曾从0搭建发现页社区，半年内UV提升250%；也主导过创新玩法，上线3天UV达52万。期待能将社区增长和创作者运营经验带到小红书。',
    '示例3：您好，我是周彩妮，看到途游正在拓展新品类，创作者运营需要从0搭建生态。我在喜马拉雅从0搭建过新主播成长体系，将培养周期从3个月缩短至1个月，新主播7日留存提升40%；也搭建过官方MCN，深度连接50+核心主播。我相信这些经验能帮助新项目快速构建活跃的创作者生态，期待交流。',
    '',
    '【真实性铁律 · 违反即不合格】只能使用简历里明确写过的事实（公司/项目/工具/技能/数字/年限）；数字必须与简历完全一致，不得编造或夸大；"贵司正在…"仅基于JD推断，不得脑补公司未公开动向；姓名必须用简历真实姓名。',
    '整体风格：像候选人与HR的首次真实沟通，专业但自然，不是培训稿、不是自我介绍；纯文本输出，不要markdown、不要引号包裹、不要落款。',
    '',
    '输出前自检：必须严格≤150字（超过会被直接截断、无二次机会），务必一次写达标——优先砍修饰词与次要细节、保留硬数据与收尾，确认是单段、结尾含"期待/希望/盼"等收尾词、收尾是完整句子后再输出。'
  ].join('\n');

  const kwLine = (job.keywords && job.keywords.length) ? `\n【岗位核心能力关键词】${job.keywords.join('、')}` : '';
  const nameLine = userName ? `\n【我的姓名/称呼】${userName}` : '';
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `【目标岗位】${job.title}｜${job.company}${kwLine}${nameLine}\n【岗位JD】\n${(job.jd || '').slice(0, 2000)}\n\n【我的完整简历】\n${resumeText.slice(0, 2500)}` }
  ];
  let text = (await callDeepSeek(messages, apiKey, false)).trim();

  // 超长时不硬剪：让 AI 自己压缩重写（保单段、保完整收尾），最多2轮
  for (let round = 0; round < 2 && plainLen(text) > 162; round++) {
    const over = plainLen(text) - 160;
    const compressMsgs = [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `上面这版共${plainLen(text)}字（不含换行），超出160字上限约${over}字。请压缩重写：保持单段不分段，开头的「您好，我是XX」问候必须原样保留，职业定位与案例核心数据保留，优先删减修饰词和次要细节，收尾必须是完整句子，且必须保留一句「期待进一步交流」式收尾（即使要再砍案例也要保住收尾）。直接输出压缩后的全文，不要任何解释。` }
    ];
    text = (await callDeepSeek(compressMsgs, apiKey, false)).trim();
  }

  // 最终兜底：仍超长则在句子边界优雅截断（绝不出现半句+省略号）
  if (plainLen(text) > 160) {
    text = truncateAtSentence(text, 158);
  }
  // 兜底补收尾：确保结尾有「期待/希望…」式收尾，避免文案戛然而止
  text = ensureClosing(text);
  return text;
}

// ============================================================
// 采集调度：逐个打开详情页补采 JD
// ============================================================
let collectAborted = false;

async function runDetailCollection(pendingJobs, notifyTabId) {
  collectAborted = false;
  const results = [];

  for (let i = 0; i < pendingJobs.length; i++) {
    if (collectAborted) break;
    const job = pendingJobs[i];
    // 标记当前待采详情的岗位
    await sSet({ detailTask: { url: job.url, jobId: job.id, title: job.title, ts: Date.now() } });

    let tab;
    try {
      tab = await chrome.tabs.create({ url: job.url, active: false });
    } catch (e) { continue; }

    // 等待详情页内容脚本回报（最多 20 秒）
    const detail = await waitDetailResult(job.id, 20000);
    try { await chrome.tabs.remove(tab.id); } catch (e) {}

    if (detail && detail.risk) {
      // 熔断
      await sSet({ collectStatus: { state: 'risk', msg: '检测到安全验证，已熔断停止。请手动打开BOSS完成验证后再试。' } });
      notify(notifyTabId, { type: 'COLLECT_RISK' });
      return { results };
    }
    if (detail) {
      const wasHunter = job.isHeadhunter; // 列表级已判定猎头则保留（详情级与列表级取"或"）
      Object.assign(job, detail);
      job.isHeadhunter = job.isHeadhunter || wasHunter;
      results.push(job);
      notify(notifyTabId, { type: 'COLLECT_PROGRESS', done: results.length, total: pendingJobs.length, job });
    }
    // 真人节奏：岗位详情之间随机停 1.5~3.5 秒（平衡档，原 3~8 秒）。
    // 这是风控最易观测的频次指标，若日后出现验证码，优先把这里调回 3000~8000。
    const gap = rand(1500, 3500);
    await sleep(gap);
  }
  await sSet({ detailTask: null });
  return { results };
}

function waitDetailResult(jobId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    function listener(msg, sender) {
      if (msg && msg.type === 'DETAIL_RESULT' && msg.jobId === jobId) {
        cleanup();
        resolve(msg.data);
      }
      if (msg && msg.type === 'DETAIL_RISK' && msg.jobId === jobId) {
        cleanup();
        resolve({ risk: true });
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

function notify(tabId, msg) {
  if (tabId) { try { chrome.tabs.sendMessage(tabId, msg); } catch (e) {} }
}

// ============================================================
// 投递调度：单阶段（由 background 直接驱动）
// 架构（2026-08-01 纠正，取代 1705 的「直接导航 redirect-url」方案）：
// 「立即沟通」按钮点击 = BOSS 发起【建会话】后端调用 + 在详情页弹出聊天小窗，按钮随之变为
// 「继续沟通」；「继续沟通」的 redirect-url 才指向真正可对话的会话页 /web/geek/chat?...。
// 关键修正：对首次沟通的岗位，绝不能像旧版那样直接 chrome.tabs.update(redirect-url) 跳到聊天页——
// 那会跳过「建会话」后端调用，导致必报「该BOSS不在聊天列表，无法沟通」。正确做法：
//   1) 详情页受信任点击（chrome.debugger）「立即沟通」→ BOSS 建会话、按钮变「继续沟通」；
//   2) 读「继续沟通」的 redirect-url → 导航到会话页；
//   3) 会话页 .chat-conversation [contenteditable] 输入框逐字打字并发送（图片模式先发图）。
// 受信任点击仅用于第 1 步（程序化 click 的 isTrusted=false 会被 BOSS 拦截），发完即 detach。
// 投放标签页以 active 打开（前台），确保小窗/聊天页正常渲染；结束归还焦点并关闭。
// ============================================================

/** 在目标标签页内执行一个注入函数（通过 jhDispatch 按名字分派，确保所有 jh* 互相可见、self-contained）。 */
async function inject(tabId, name, args) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: jhDispatch, args: [{ name, args: args || [] }] });
    return r && r[0] ? r[0].result : null;
  } catch (e) { return null; }
}

/** 在目标标签页的 MAIN world 执行注入函数（图片注入需与 BOSS 的 Vue 同 realm）。 */
async function injectMainWorld(tabId, func, args) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: args || [] });
    return r && r[0] ? r[0].result : null;
  } catch (e) { return null; }
}

// ============================================================
// 调试器受信任点击：绕过 BOSS 的 isTrusted 拦截。
// 普通 content script 的 el.click() / dispatchEvent 产生的事件 isTrusted=false，BOSS 会拦截；
// 而 chrome.debugger 的 Input.dispatchMouseEvent 在协议层合成真实输入事件（isTrusted=true），
// 等价于真人点击——可触发「立即沟通」按钮的完整处理逻辑（含首次沟通时向后端建会话这一步）。
// 仅用于「导航/列表兜底都失败」的首次沟通场景，发完即 detach，调试条仅短暂出现。
// ============================================================
async function debuggerTrustedClick(tabId, getRectName, getRectArgs) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
  } catch (e) {
    return { ok: false, reason: '调试器附加失败：' + ((e && e.message) ? e.message : String(e)) + '（请确认扩展已拥有调试权限）' };
  }
  try {
    const rect = await inject(tabId, getRectName, getRectArgs || []);
    if (!rect || typeof rect.x !== 'number') return { ok: false, reason: '未取到目标按钮坐标' };
    const mk = (type) => ({ type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 0 });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', mk('mousePressed'));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', mk('mouseReleased'));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: '调试器点击失败：' + ((e && e.message) ? e.message : String(e)) };
  } finally {
    if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} }
  }
}

/**
 * 首次沟通救援：会话尚未建立时，回到详情页用调试器受信任点击「立即沟通」，
 * 触发 BOSS 建会话并跳转聊天页。返回 {ok, risk, reason}。
 */
async function debuggerRescueConversation(tab, job, deadline, done) {
  try {
    // 回到详情页才能点到「立即沟通」按钮（建立首次会话的关键动作）
    await chrome.tabs.update(tab.id, { url: job.url });
    // 等待「立即沟通」按钮真正渲染（不只等 body，避免点到占位元素）
    let btnReady = false;
    for (let i = 0; i < 30; i++) {
      await sleep(rand(300, 600));
      if (Date.now() > deadline) break;
      const rect = await inject(tab.id, 'jhGetChatBtnRect', []);
      if (rect && typeof rect.x === 'number') { btnReady = true; break; }
    }
    if (!btnReady) return { ok: false, reason: '回到详情页后未找到「立即沟通」按钮' };

    // 最多两次受信任点击：BOSS 偶尔需真实手势才建会话
    for (let attempt = 1; attempt <= 2; attempt++) {
      const dres = await debuggerTrustedClick(tab.id, 'jhGetChatBtnRect', []);
      if (!dres || !dres.ok) {
        if (attempt === 1) continue; // 第一次执行异常，重试一次
        return { ok: false, reason: (dres && dres.reason) ? dres.reason : '调试器救援未执行' };
      }
      // 受信任点击触发 BOSS 建会话并跳聊天页，等待输入框出现
      for (let i = 0; i < 30; i++) {
        await sleep(rand(600, 1100));
        const r = await inject(tab.id, 'jhCheckChat', []);
        if (r && r.risk) return { ok: false, risk: true };
        if (r && r.input) return { ok: true };
        if (Date.now() > deadline) break;
      }
      // 第一次点击后仍未打开 → 回详情页重试第二次
      if (attempt === 1) {
        await chrome.tabs.update(tab.id, { url: job.url });
        for (let i = 0; i < 20; i++) {
          await sleep(rand(300, 600));
          if (Date.now() > deadline) break;
          const rect = await inject(tab.id, 'jhGetChatBtnRect', []);
          if (rect && typeof rect.x === 'number') break;
        }
      }
    }
    return { ok: false, reason: '受信任点击后仍未打开会话（可能需先手动建立会话）' };
  } catch (e) {
    return { ok: false, reason: '救援异常：' + ((e && e.message) ? e.message : String(e)) };
  }
}

// MAIN world 下的简历图注入：调用 pageworld.js 暴露的 window.__jhPageWorld.injectResumeImage
// （pageworld.js 以 world:"MAIN" 运行，与 BOSS 的 Vue 同 realm，File/DataTransfer 能被上传处理器读取）。
// 注意：注入函数必须 self-contained（single function 序列化），不能依赖 jhDispatch 内的其它函数。
function jhInjectResumeImageMain(dataUrl, fileName) {
  try {
    if (!window.__jhPageWorld || !window.__jhPageWorld.injectResumeImage) {
      return { ok: false, reason: 'pageworld-not-ready' };
    }
    return window.__jhPageWorld.injectResumeImage(dataUrl, fileName);
  } catch (e) {
    return { ok: false, reason: String((e && e.message) ? e.message : e) };
  }
}

// ---- 所有注入函数打包进 jhDispatch ----
// 关键：chrome.scripting.executeScript({func}) 只会序列化【单个】函数，其内部调用的其它 jh*
// 函数在注入后的 isolated world 里并不可见 → ReferenceError。这是之前所有版本（1632 起）
// 投递在「定位输入框」环节必崩、表现成"还是不行"的真正根因。
// 因此把所有函数收敛到 jhDispatch 内部，由 inject() 通过 {name,args} 分派调用，确保互相可见、self-contained。

function jhDispatch(payload) {
  const { name, args } = payload || {};

  function jhReady() {
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') return false;
    return !!document.body;
  }

  function jhRiskCheck() {
    const hints = ['.verify-slider', '.geetest_panel', '.captcha-box', '#captcha', '.security-check-wrap'];
    if (hints.some((s) => document.querySelector(s))) return true;
    if (/验证|安全检查/.test(document.title)) return true;
    if (/safe\/verify|security-check|captcha/.test(location.href)) return true;
    return false;
  }

  // 读取「立即沟通」跳转地址：优先用按钮自带的 redirect-url，直接导航到聊天页。
  // 诊断(detail-diag-v1, 2026-07-29)实测确认：点击「立即沟通」是整页跳转到 /web/geek/chat
  // （而非原地弹小窗），聊天页输入框为 .chat-conversation [contenteditable]。
  // 用「导航到 redirect-url」等价于点击，但完全不受 BOSS 的 isTrusted 拦截——
  // 这正是之前所有「element.click()/真实鼠标事件序列」方案失败（点诊断跳首页、投递文案打不进）的根因。
  function jhGetChatUrl() {
    // 返回当前「沟通」按钮状态：text = '立即沟通'(首次，需建会话) | '继续沟通'(已建会话)
    const nodes = Array.from(document.querySelectorAll('a, button')).filter(e => !e.closest('#jh-panel, #jh-fab'));
    let btn = null, text = '';
    // 1) 精确优先匹配「立即沟通」（排除「继续沟通」，避免误导航到别的会话）
    for (const e of nodes) {
      const t = (e.textContent || '').trim();
      if (t === '立即沟通') { btn = e; text = t; break; }
    }
    // 2) 次选「继续沟通」（会话已存在，可直接进会话）
    if (!btn) {
      for (const e of nodes) {
        const t = (e.textContent || '').trim();
        if (t === '继续沟通') { btn = e; text = t; break; }
      }
    }
    // 3) 再退一步：文本含沟通语义（BOSS 改版导致文本变化时仍可命中）
    if (!btn) {
      for (const e of nodes) {
        const t = (e.textContent || '').trim();
        if (t.includes('立即沟通') || t.includes('继续沟通') || t.includes('招呼') || t.includes('开始沟通')) { btn = e; text = t; break; }
      }
    }
    // 4) 兜底：带 redirect-url 且指向聊天页的 a
    if (!btn) {
      const links = Array.from(document.querySelectorAll('a[redirect-url]')).filter(e => !e.closest('#jh-panel, #jh-fab'));
      for (const e of links) {
        const ru = e.getAttribute('redirect-url') || '';
        if (ru.includes('/web/geek/chat')) { btn = e; text = (e.textContent || '').trim() || '继续沟通'; break; }
      }
    }
    if (!btn) return { ok: false, reason: '未找到「立即沟通 / 继续沟通」按钮' };
    // 5) 优先用按钮自带的 redirect-url（BOSS 自己生成的合法跳转地址，带 securityId），直接导航过去
    //    校验完整性：必须含 jobId + securityId 才足以打开对应会话；
    //    不完整（占位/页面未加载完）则视为「未就绪」，交由上层重试，避免拿到错误 URL 跳到空会话。
    const ru = (btn.getAttribute('redirect-url') || btn.getAttribute('data-redirect-url') || '').trim();
    if (ru && ru.includes('/web/geek/chat')) {
      const hasJob = /[?&]jobId=/.test(ru);
      const hasSec = /[?&]securityId=/.test(ru);
      if (hasJob && hasSec) {
        try { return { ok: true, url: new URL(ru, location.origin).href, text }; } catch (e) {}
      }
      return { ok: false, reason: 'redirect-url 未就绪（缺 jobId/securityId，等待页面加载）', text };
    }
    // 6) 没有 redirect-url 时，退回真实鼠标事件序列点击（可能受 isTrusted 拦截）
    return { ok: true, needClick: true, text };
  }

  // 取「立即沟通」按钮在视口内的中心点坐标（供 chrome.debugger 受信任点击用）。
  // 与 jhGetChatUrl 同定位逻辑，但返回 {x,y}（getBoundingClientRect，视口相对）。
  function jhGetChatBtnRect() {
    const nodes = Array.from(document.querySelectorAll('a, button')).filter(e => !e.closest('#jh-panel, #jh-fab'));
    let btn = null;
    for (const e of nodes) {
      const t = (e.textContent || '').trim();
      if (t === '立即沟通') { btn = e; break; }
    }
    if (!btn) {
      for (const e of nodes) {
        const t = (e.textContent || '').trim();
        if (t === '继续沟通') { btn = e; break; }
      }
    }
    if (!btn) {
      for (const e of nodes) {
        const t = (e.textContent || '').trim();
        if (t.includes('立即沟通') || t.includes('继续沟通') || t.includes('招呼') || t.includes('开始沟通')) { btn = e; break; }
      }
    }
    if (!btn) return null;
    try {
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    } catch (e) { return null; }
  }

  // 检查聊天页是否已就绪（输入框出现、且未触发风控）。供 background 轮询调用。
  function jhCheckChat() {
    return { risk: jhRiskCheck(), input: !!jhResolveInput() };
  }

  function jhFindAndClickContact() {
    const sels = ['a.btn-startchat', '.btn-startchat', 'a.op-btn-chat', '.job-op .btn'];
    let btn = null;
    for (const s of sels) {
      const e = document.querySelector(s);
      if (e && !e.closest('#jh-panel, #jh-fab')) { btn = e; break; }
    }
    if (!btn) {
      const txtCands = ['立即沟通', '打招呼', '开始沟通'];
      const nodes = Array.from(document.querySelectorAll('a, button')).filter(e => !e.closest('#jh-panel, #jh-fab'));
      for (const n of nodes) {
        const t = (n.textContent || '').trim();
        if (txtCands.some(c => t.includes(c))) { btn = n; break; }
      }
    }
    if (!btn) return { status: 'noBtn' };
    const txt = (btn.textContent || '').trim();
    if (txt.includes('继续沟通')) return { status: 'skip' };
    try {
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      const cx = Math.max(1, Math.round(r.left + r.width / 2));
      const cy = Math.max(1, Math.round(r.top + r.height / 2));
      const mk = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1, composed: true });
      btn.dispatchEvent(mk('mousedown'));
      btn.dispatchEvent(mk('mouseup'));
      btn.dispatchEvent(mk('click'));
    } catch (e) {
      try { btn.click(); } catch (e2) {}
    }
    return { status: 'ok' };
  }

  // ---- 聊天输入框解析：会话输入框是 contenteditable（chat-diag-v5 实测：开会话后 contenteditable=1），
  // 而「联系人搜索框」是 <input> 且位于左侧/顶部搜索区，两者绝不能混淆。
  // 因此严格【优先在 .chat-conversation 内取 contenteditable】，从根本上排除搜索框；
  // 并且【绝不返回 <input>/<textarea>】，避免把文案误打进联系人搜索框。
  function jhResolveInput() {
    // 1) 会话主区 .chat-conversation 内的 contenteditable —— 这就是会话输入框（已验证）
    const conv = document.querySelector('.chat-conversation');
    if (conv) {
      const ed = conv.querySelector('[contenteditable]:not([contenteditable="false"])');
      if (ed && !ed.closest('#jh-panel, #jh-fab')) return ed;
    }
    // 2) 其它聊天语义容器内的 contenteditable（兜底）
    const scopes = ['.message-controls', '.chat-editor', '.chat-im', '.chat-wrap', '.dialog-wrap'];
    for (const s of scopes) {
      const box = document.querySelector(s);
      if (!box) continue;
      const ed = box.querySelector('[contenteditable]:not([contenteditable="false"])');
      if (ed && !ed.closest('#jh-panel, #jh-fab')) return ed;
    }
    // 3) 全局兜底：任意 contenteditable，祖先带聊天语义且【不在搜索容器里】
    const all = Array.from(document.querySelectorAll('[contenteditable]:not([contenteditable="false"])'))
      .filter(e => !e.closest('#jh-panel, #jh-fab'));
    for (const e of all) {
      let n = e, hit = false, inSearch = false;
      while (n && n !== document.body) {
        const c = (n.getAttribute && n.getAttribute('class')) || '';
        if (/search|搜索/i.test(c)) { inSearch = true; break; }
        if (/chat|message|im|reply|editor|dialog|conversation|chatbox|msg/i.test(c)) hit = true;
        n = n.parentElement;
      }
      if (hit && !inSearch) return e;
    }
    // 4) 重要：会话输入框一定是 contenteditable，绝不返回 <input>/<textarea>
    //    （联系人搜索框就是 <input>，返回它会把文案打进搜索框，必须排除）
    return null;
  }

  function jhFindInput() {
    const el = jhResolveInput();
    if (el) { window.__jhInput = el; return { found: true, tag: el.tagName }; }
    window.__jhInput = null;
    return { found: false };
  }

  function jhTypeChunk(chunk) {
    let el = window.__jhInput;
    if (!el || !el.isConnected) {
      el = jhResolveInput();
      if (!el) return { ok: false };
    }
    window.__jhInput = el;
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        let cur = el.value || '';
        cur += chunk;
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, cur);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, chunk);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return { ok: true };
    } catch (e) { return { ok: false }; }
  }

  function jhTypeFull(text) {
    let el = window.__jhInput;
    if (!el || !el.isConnected) {
      el = jhResolveInput();
      if (!el) return { ok: false };
    }
    window.__jhInput = el;
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.innerHTML = '';
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
      return { ok: true };
    } catch (e) { return { ok: false }; }
  }

  function jhGetInputText() {
    let el = window.__jhInput;
    if (!el || !el.isConnected) {
      el = jhResolveInput();
    }
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.textContent || '';
  }

  function jhSend() {
    let el = window.__jhInput;
    if (!el || !el.isConnected) el = jhResolveInput();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    if (el && el.isConnected) {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    const sendSels = ['.btn-send', '.chat-op .btn-send', 'button[type="send"]', '[class*="btn-send"]', '[class*="send-btn"]', 'button[class*="send"]'];
    for (const s of sendSels) {
      const b = document.querySelector(s);
      if (b && !b.closest('#jh-panel, #jh-fab')) { b.click(); break; }
    }
    return { ok: true };
  }

  function jhVerifySent(snippet) {
    const t = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, '');
    return { sent: t.includes(snippet) };
  }

  // 图片发送：选中简历图后聊天区出现预览+发送按钮。优先点图片专用按钮，兜底点带"发送"文本的按钮；
  // 若确认存在图片预览，再兜底 .btn-send（BOSS 图片发送按钮常复用此类名）。
  function jhSendImage() {
    const conv = document.querySelector('.chat-conversation');
    if (!conv) return { ok: false, reason: 'no-conv' };
    const specific = ['.btn-send-img', '.chat-img-preview .btn-send', '.img-preview .btn-send',
      '[class*="img-preview"] [class*="btn-send"]', 'button.btn-send-img'];
    for (let s = 0; s < specific.length; s++) {
      const b = conv.querySelector(specific[s]);
      if (b && b.offsetParent !== null) { b.click(); return { ok: true, clicked: specific[s] }; }
    }
    const txtBtns = Array.prototype.slice.call(conv.querySelectorAll('button, [role=button]'))
      .filter(function (e) { return e.offsetParent !== null && /发送/.test(e.textContent || '') && !/不发送|取消/.test(e.textContent || ''); });
    if (txtBtns[0]) { txtBtns[0].click(); return { ok: true, clicked: 'text-发送' }; }
    if (conv.querySelector('.message-content img, .img-preview, [class*="preview"] img')) {
      const bs = conv.querySelector('.btn-send');
      if (bs && bs.offsetParent !== null) { bs.click(); return { ok: true, clicked: '.btn-send(preview)' }; }
    }
    return { ok: false, reason: 'no-send-btn' };
  }

  // 统计「我发出的」消息里的图片数（用于校验图片是否真的发出）
  function jhCountMyImgs() {
    const conv = document.querySelector('.chat-conversation');
    if (!conv) return { count: 0 };
    return { count: conv.querySelectorAll('.message-item.item-myself img').length };
  }

  // 左侧会话列表兜底：URL 自动打开失败时，按「岗位名(+公司/HR名)」在已有会话里精确匹配并点开。
  // 匹配不到就返回 no-match（绝不点错会话，避免发错人）。
  function jhOpenFromList(title, company, hrName) {
    const listSels = ['[class*="conversation-list"] li', '[class*="friend-list"] li', '.geek-chat-index li'];
    let items = [];
    for (const s of listSels) {
      const els = Array.from(document.querySelectorAll(s)).filter(e => !e.closest('#jh-panel, #jh-fab'));
      if (els.length) { items = els; break; }
    }
    if (!items.length) return { ok: false, reason: 'no-list' };
    const norm = (x) => (x || '').trim().replace(/\s+/g, '');
    const t = norm(title), c = norm(company), h = norm(hrName);
    let hit = null;
    if (t) {
      // 强匹配：岗位名 + 公司名/HR名 同时命中，最大限度避免同名岗位误点
      for (const it of items) {
        const txt = norm(it.textContent);
        if (txt.includes(t) && ((c && txt.includes(c)) || (h && txt.includes(h)))) { hit = it; break; }
      }
      // 退而求其次：仅岗位名命中（岗位名≥4字时才较可靠）
      if (!hit && t.length >= 4) {
        for (const it of items) {
          if (norm(it.textContent).includes(t)) { hit = it; break; }
        }
      }
    }
    if (!hit) return { ok: false, reason: 'no-match', count: items.length };
    const targets = [hit, hit.querySelector('.friend-content'), hit.querySelector('.title-box'), hit.querySelector('.name-box')].filter(Boolean);
    for (const tg of targets) {
      try { tg.click(); return { ok: true }; } catch (e) {}
    }
    return { ok: false, reason: 'click-failed' };
  }

  // 抓取聊天页当前状态，便于失败时定位（区分「会话未打开 / 找不到联系人 / 输入框缺失」）
  function jhCaptureChatState() {
    const conv = document.querySelector('.chat-conversation');
    const listSels = ['[class*="conversation-list"] li', '[class*="friend-list"] li', '.geek-chat-index li'];
    let listCount = 0;
    for (const s of listSels) {
      const n = document.querySelectorAll(s).length;
      if (n) { listCount = n; break; }
    }
    const body = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, '');
    // 命中「首次沟通/会话未建立」的多种 BOSS 文案：
    // 「找不到联系人」「联系人列表」「该BOSS不在聊天列表，无法沟通」「无法沟通」等
    const notFound = /找不到联系人|联系人列表|暂无会话|没有可对话|去聊聊|不在聊天列表|无法沟通|尚未.*(会话|沟通)/.test(body);
    let inputFound = false;
    if (conv) {
      const ed = conv.querySelector('[contenteditable]:not([contenteditable="false"])');
      inputFound = !!ed;
    }
    return {
      hasConv: !!conv,
      inputFound,
      listCount,
      notFound,
      snippet: body.slice(0, 160)
    };
  }

  const map = {
    jhReady, jhGetChatUrl, jhCheckChat, jhFindAndClickContact,
    jhResolveInput, jhFindInput, jhTypeChunk, jhTypeFull, jhGetInputText, jhSend, jhVerifySent,
    jhSendImage, jhCountMyImgs, jhOpenFromList, jhCaptureChatState, jhGetChatBtnRect
  };
  const fn = map[name];
  return fn ? fn.apply(null, args || []) : null;
}

// ---- 单阶段投递主流程（由 background 驱动；投递标签短暂切到前台以保证小窗渲染）----
async function runDelivery(job, greeting, notifyTabId, opts = {}) {
  // 清除可能残留的 deliveryTask，避免详情页 content script 误触发旧的「页面内」投递流程
  await sSet({ deliveryTask: null });

  const imageMode = !!(opts && opts.image); // 图片投递：先发简历图再发文案
  let resume = {};
  if (imageMode) { const rr = await sGet(['resume']); resume = rr.resume || {}; }
  let imageSent = false, imageNote = '';

  // 记录当前前台标签页，投递结束后把焦点还回去（不长期占用用户页面）
  let returnTabId = null;
  try {
    const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (cur) returnTabId = cur.id;
  } catch (e) {}

  let tab;
  try {
    // 关键：以 active 打开。后台/被遮挡的标签页会被 Chrome 冻结且 visibilityState=hidden，
    // 导致 BOSS 聊天小窗不渲染、输入/发送超时；前台打开才能稳定复现「手动打开即可打入」的效果。
    tab = await chrome.tabs.create({ url: job.url, active: true });
  } catch (e) {
    return { ok: false, stage: 'contact', reason: '无法打开岗位详情页' };
  }

  const restoreFocus = async () => {
    try {
      if (returnTabId && returnTabId !== tab.id) await chrome.tabs.update(returnTabId, { active: true });
    } catch (e) {}
  };
  const closeTab = async () => { try { await chrome.tabs.remove(tab.id); } catch (e) {} };
  const done = async (result) => { await restoreFocus(); await closeTab(); return result; };

  const deadline = Date.now() + 75000; // 整体软超时保护，防止意外卡死

  try {
    // 1) 等页面就绪（前台加载快）
    let ready = false;
    for (let i = 0; i < 20; i++) {
      if (await inject(tab.id, 'jhReady', [])) { ready = true; break; }
      await sleep(rand(300, 600));
    }
    if (!ready) return done({ ok: false, stage: 'contact', reason: '详情页加载超时' });

    // 2) 风控预检
    if (await inject(tab.id, 'jhRiskCheck', [])) {
      return done({ ok: false, stage: 'risk', reason: '检测到安全验证，已停止' });
    }

    await sleep(rand(800, 1800)); // 模拟真人阅读 JD（提速：压缩停顿但保留真人感，不增风控）

    // 3) 读取「立即沟通 / 继续沟通」按钮状态：
    //    - 按钮是「立即沟通」→ 该 HR 尚无会话（首次沟通），必须先【受信任点击】触发 BOSS 建会话，
    //      按钮会变成「继续沟通」；之后才能进入会话。
    //    - 按钮是「继续沟通」→ 会话已存在，直接取其 redirect-url 导航即可。
    //    注意：绝不能像旧版那样对「立即沟通」直接导航 redirect-url —— 那会跳过建会话的后端调用，
    //    导致首次沟通必报「该BOSS不在聊天列表，无法沟通」。必须先点一次「立即沟通」建会话。
    let chat = null;
    for (let i = 0; i < 15; i++) {
      const r = await inject(tab.id, 'jhGetChatUrl', []);
      if (r && r.ok) { chat = r; break; }
      await sleep(rand(500, 1000));
      if (Date.now() > deadline) break;
    }
    if (!chat) return done({ ok: false, stage: 'contact', reason: '未找到「立即沟通 / 继续沟通」按钮' });

    // 首次沟通：受信任点击「立即沟通」建会话（仅这一步需要 debugger 受信任点击，
    // 因为 BOSS 会拦截 isTrusted=false 的程序化点击；建完会话即 detach，调试条仅短暂出现）。
    if (chat.text === '立即沟通') {
      const dres = await debuggerTrustedClick(tab.id, 'jhGetChatBtnRect', []);
      if (!dres || !dres.ok) {
        return done({ ok: false, stage: 'contact', reason: '创建会话失败：' + ((dres && dres.reason) ? dres.reason : '未知') + '（请确认扩展已拥有调试权限，并在 chrome://extensions 重载过本扩展）' });
      }
      // 等按钮变为「继续沟通」= 会话已建立（BOSS 会同时弹出聊天小窗，无需手动关闭，下一步导航离开即消失）
      let created = false;
      for (let i = 0; i < 20; i++) {
        await sleep(rand(500, 900));
        const c = await inject(tab.id, 'jhGetChatUrl', []);
        if (c && c.ok && c.text === '继续沟通') { created = true; chat = c; break; }
        if (Date.now() > deadline) break;
      }
      if (!created) {
        return done({ ok: false, stage: 'contact', reason: '受信任点击「立即沟通」后对话未建立（按钮未变为「继续沟通」）。可能 BOSS 拦截或账号风控，建议手动点一次「立即沟通」后再试本岗位。' });
      }
    }

    // 现在按钮是「继续沟通」，其 redirect-url 指向该岗位 HR 的会话。导航过去（等价于再点一次「继续沟通」）。
    if (!chat.url) {
      return done({ ok: false, stage: 'contact', reason: '未取到「继续沟通」跳转地址（redirect-url 未就绪）' });
    }
    await chrome.tabs.update(tab.id, { url: chat.url });

    // 4) 等会话页加载并出现可输入的消息框（输入框严格限定在聊天容器内，搜索框永不被选中）。
    let inputOk = false;
    for (let i = 0; i < 24; i++) {
      await sleep(rand(400, 800));
      const r = await inject(tab.id, 'jhCheckChat', []);
      if (r && r.risk) return done({ ok: false, stage: 'risk', reason: '检测到安全验证，已停止' });
      if (r && r.input) { inputOk = true; break; }
      if (Date.now() > deadline) break;
    }

    if (!inputOk) {
      const st = await inject(tab.id, 'jhCaptureChatState', []);
      let detail = '';
      if (st) {
        detail = `（聊天页状态：会话区=${st.hasConv ? '有' : '无'} 输入框=${st.inputFound ? '有' : '无'} 左侧会话数=${st.listCount} 首次沟通未建会话=${st.notFound ? '是' : '否'}）`;
      }
      return done({ ok: false, stage: 'contact', reason: '进入会话页后找不到可输入的消息框' + detail });
    }

    // 4.5) 图片投递（先于文案）：注入简历图 → 等预览 → 点发送 → 校验
    if (imageMode && resume.imageDataUrl) {
      let injected = false;
      for (let i = 0; i < 15; i++) {
        const r = await injectMainWorld(tab.id, jhInjectResumeImageMain, [resume.imageDataUrl, resume.imageName || 'resume.png']);
        if (r && r.ok) { injected = true; break; }
        await sleep(rand(400, 800));
        if (Date.now() > deadline) break;
      }
      if (injected) {
        await sleep(rand(1000, 1800)); // 等图片预览渲染
        const before = await inject(tab.id, 'jhCountMyImgs', []);
        const clickRes = await inject(tab.id, 'jhSendImage', []);
        await sleep(rand(1200, 2200));
        const after = await inject(tab.id, 'jhCountMyImgs', []);
        const base = (before && before.count) || 0;
        const now = (after && after.count) || 0;
        imageSent = now > base || !!(clickRes && clickRes.ok && now > 0);
        imageNote = imageSent ? '已先发送简历图' : '简历图已选入但发送按钮未命中（请运行诊断反馈）';
      } else {
        imageNote = '简历图注入失败（pageworld 未就绪）';
      }
    }

    // 5) 逐字分块打字（标签处于前台，不受节流/冻结影响）
    //    段落紧凑：AI 偶尔输出「段落 + 空行 + 段落」(即 \n\n\n)，BOSS textarea 会渲染成两空行。
    //    用户期望段间仅一个换行；归一化：把任何 [空白+\n] 出现 ≥2 次的连续块压成单个 \n。
    greeting = (greeting || '').replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n');
    const chars = Array.from(greeting);
    let i = 0;
    while (i < chars.length) {
      const step = rand(3, 5); // 提速：3-5 字/块，块数减半，节奏更似真人连打（前台无节流，不增风控）
      const chunk = chars.slice(i, i + step).join('');
      const r = await inject(tab.id, 'jhTypeChunk', [chunk]);
      if (!r || !r.ok) await inject(tab.id, 'jhFindInput', []);
      i += step;
      await sleep(rand(40, 130));
      if (Date.now() > deadline) break;
    }

    // 兜底：若分块后输入框文本不完整，一次性补全
    const snippet = (greeting || '').replace(/\s+/g, '').slice(0, 10);
    const curText = await inject(tab.id, 'jhGetInputText', []);
    if (snippet && (!curText || !curText.replace(/\s+/g, '').includes(snippet))) {
      await inject(tab.id, 'jhTypeFull', [greeting || '']);
    }

    await sleep(rand(300, 800)); // 提速：发送前停顿压缩，仍保留"想一下"的拟人感，不增风控

    // 6) 发送（回车或发送按钮）
    await inject(tab.id, 'jhSend', []);

    // 7) 校验是否真的发出（消息区出现文案片段才算成功）
    let sent = false;
    for (let k = 0; k < 16; k++) {
      const r = await inject(tab.id, 'jhVerifySent', [snippet]);
      if (r && r.sent) { sent = true; break; }
      await sleep(450);
      if (Date.now() > deadline) break;
    }
    if (sent) return done({ ok: true, reason: '打招呼文案已在聊天页发送', imageSent, imageNote });
    return done({ ok: false, stage: 'contact', reason: '文案已输入但未能成功发送（发送方式可能已变化）', imageSent, imageNote });
  } catch (e) {
    return done({ ok: false, stage: 'contact', reason: '投递异常：' + (e && e.message ? e.message : String(e)) });
  }
}

// ============================================================
// 消息路由
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'ANALYZE_MATCH': {
          const { config = {} } = await sGet(['config']);
          if (!config.apiKey) return sendResponse({ error: '请先在「采集配置」中填写 DeepSeek API Key' });
          const result = await analyzeMatch(msg.job, msg.resumeText, config.apiKey);
          return sendResponse({ ok: true, result });
        }
        case 'GEN_GREETING': {
          const { config = {} } = await sGet(['config']);
          if (!config.apiKey) return sendResponse({ error: '请先填写 DeepSeek API Key' });
          const text = await genGreeting(msg.job, msg.resumeText, config.apiKey, msg.userName || '');
          return sendResponse({ ok: true, text });
        }
        case 'COLLECT_DETAILS': {
          const results = await runDetailCollection(msg.jobs, sender.tab && sender.tab.id);
          return sendResponse({ ok: true, results });
        }
        case 'COLLECT_ABORT': {
          collectAborted = true;
          return sendResponse({ ok: true });
        }
        case 'DELIVER_ONE': {
          const result = await runDelivery(msg.job, msg.greeting, sender.tab && sender.tab.id, { image: !!msg.image });
          return sendResponse(result);
        }
        default:
          return sendResponse({});
      }
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true; // 异步响应
});
