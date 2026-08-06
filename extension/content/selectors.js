// ============================================================
// selectors.js — BOSS直聘页面选择器集中管理
// BOSS 前端改版时只需要维护这一个文件。
// 每项都是数组，按顺序尝试，取第一个命中的。
// ============================================================
const JH_SELECTORS = {
  // ---------- 搜索/列表页 ----------
  jobCard: [
    '.job-card-box',                          // 2026 新版列表页（/web/geek/job，注意不带 s）
    'ul.job-list-box > li.job-card-wrapper',
    'ul.job-list-box > li',
    '.job-list .job-primary'
  ],
  jobCardLink: ['a.job-name[href*="job_detail"]', 'a.job-card-left', 'a[href*="job_detail"]', 'a'],
  // 注意：绝不能用 .job-title 容器（它同时包含岗位名和薪资，会拼成"岗位名-K·薪"）
  jobCardTitle: ['a.job-name', '.job-name', '.job-title .job-name'],
  jobCardSalary: ['.job-salary', '.salary', '.job-limit .red', '.red'],
  // 公司名候选选择器：顺序即优先级。
  // 新版卡片公司名在 .boss-name（诊断报告实测命中）；/gongsi/ 链接是旧版最可靠锚点。
  // 注意：所有候选都会经过 collector.js 的 isValidCompany() 验证，防止误抓岗位标题/薪资。
  jobCardCompany: [
    '.boss-name',
    'a[href*="/gongsi/"]',
    'h3.company-name a', '.company-name a', 'h3.company-name', '.company-name',
    '.comp-name', '[class*="company-name"] a', '[class*="company-name"]',
    '[class*="comp"] a'
  ],
  jobCardCity: ['.company-location', '.job-area', '.job-area-wrapper .job-area', '[class*="job-area"]'],
  jobCardHr: ['.info-public', '.job-card-footer .info-public', '.job-info .info-public', '[class*="info-public"]'],
  // 列表卡片上的猎头角标（新版卡片左上角 <img alt="猎头">，识别猎头最可靠的信号）
  jobCardHunterIcon: ['img.job-tag-icon[alt*="猎头"]', 'img[alt*="猎头"]'],

  // ---------- 岗位详情页 ----------
  detailJdText: ['.job-sec-text', '.job-detail-section .text', '.detail-content .job-sec-text'],
  detailSalary: ['.job-primary .salary', '.info-primary .salary', '.salary'],
  detailBossName: ['.job-boss-info .name', '.detail-op .job-boss-info h2', '.boss-info-attr'],
  // 招聘者头衔行（含"XX女士·猎头顾问·公司名"），判断猎头的最可靠来源
  detailBossTitle: ['.job-boss-info', '.detail-op .job-boss-info', '.boss-info-attr'],
  detailBossActive: ['.boss-active-time', '.job-boss-info .boss-online-tag', '.boss-online-tag'],
  detailCompany: [
    '.company-info .name', '.sider-company .company-info a[href*="gongsi"]',
    '.sider-company .company-info a', '.business-info .name',
    'a[ka="job-detail-company"]', 'a[href*="/gongsi/"]', '.company-info'
  ],
  detailChatBtn: ['a.btn-startchat', '.btn-startchat', 'a.op-btn-chat', '.job-op .btn'],
  // 详情页判断猎头/人力资源代招的公司名与标签
  detailBrand: ['.sider-company .company-info', '.sider-company', '.company-info'],

  // ---------- 聊天页 (/web/geek/chat) ----------
  // 2026新版（v5514）已由诊断报告实测确认：
  //   会话项 = .user-list ul li / [role="listitem"]；HR姓名 = .name-box .name-text；
  //   公司名 = .name-box 里第2个无类名 span（代码里用 name-text 的兄弟节点提取）；
  //   输入框 = 普通 textarea（页面唯一，非 contenteditable）；发送按钮不存在 → 回车发送；
  //   图片上传 = input[type="file"][accept*="image"]（页面2个，JH.$ 已自动排除插件自身的 #jh-file）。
  chatConvList: [
    '.user-list ul li', '[role="listitem"]', '.chat-user-list li', '[class*="user-list"] li',
    '[class*="conversation-list"] li', '[class*="friend-list"] li', '.geek-chat-index li'
  ],
  chatConvName: ['.name-box .name-text', '.name-text', '.name-box .name', '.title-box .name', '.name'],
  chatConvCompany: ['.name-box .company', '.title-box .base-info', '.company'],
  // 输入框形态（2026-07-29 诊断 v4 实测确认）：打开会话后整页 textarea=0、contenteditable=1，
  // 且这唯一一个 contenteditable 位于 `.chat-conversation > ... > .chat-im.chat-editor` 容器内
  // （与发图片按钮 .btn-sendimg 同属 .chat-editor）。故以聊天主区内的 [contenteditable] 为首选，
  // 前面 textarea 类仅作兼容兜底。真正定位还靠 deliver.js 的 findChatInput 三级兜底。
  chatInput: [
    '.chat-conversation [contenteditable]',
    '.chat-editor [contenteditable]',
    '[contenteditable]:not([contenteditable="false"])',
    'textarea', 'input:not([type="file"])'
  ],
  chatSendBtn: [
    '.btn-send', '.chat-op .btn-send', 'button[type="send"]',
    '[class*="btn-send"]', '[class*="send-btn"]', 'button[class*="send"]'
  ],
  // 图片上传控件（2026-07-29 诊断 v4 实测）：
  //   · 聊天工具栏发图片按钮 = .chat-conversation 容器内的 .btn-sendimg > input[type=file]（file#0）
  //   · 上传简历弹窗的 file input 在 .upload-resume-dialog / v-transfer-dom 内（file#1/2），
  //     不在 .chat-conversation 内，必须排除，否则图片会被塞进简历弹窗而非发给 HR。
  // 因此以 `.chat-conversation input[type="file"]` 为唯一首选（精确命中发图片、天然排除简历弹窗）。
  chatImageInput: [
    '.chat-conversation input[type="file"]',
    '.chat-editor input[type="file"]',
    '.btn-sendimg input[type="file"]',
    'input[type="file"]'
  ],

  // ---------- 风控/验证码检测 ----------
  captchaHints: ['.verify-slider', '.geetest_panel', '.captcha-box', '#captcha', '.security-check-wrap']
};

// 风控 URL 特征
const JH_RISK_URL_PATTERNS = ['safe/verify', 'security-check', 'captcha'];

// 常用城市编码表（BOSS直聘 city code）
const JH_CITY_CODES = {
  '北京': '101010100', '上海': '101020100', '广州': '101280100', '深圳': '101280600',
  '杭州': '101210100', '成都': '101270100', '武汉': '101200100', '南京': '101190100',
  '西安': '101110100', '苏州': '101190400', '天津': '101030100', '重庆': '101040100',
  '长沙': '101250100', '郑州': '101180100', '青岛': '101120200', '合肥': '101220100',
  '佛山': '101280800', '东莞': '101281600', '宁波': '101210400', '厦门': '101230200',
  '济南': '101120100', '福州': '101230100', '昆明': '101290100', '沈阳': '101070100',
  '大连': '101070200', '哈尔滨': '101050100', '无锡': '101190200', '珠海': '101280700'
};

// 猎头/代招识别关键词（用于公司名/公司简介文本，"XX人力资源有限公司"这类）
const JH_HEADHUNTER_WORDS = ['猎头', '人力资源', '人才服务', '劳务派遣', '代招', '猎聘', 'RPO', '人才科技', '人力科技'];

// 猎头识别关键词（用于招聘者头衔，如"王女士·猎头顾问"。刻意收窄，避免误伤企业内部"人力资源经理"）
const JH_HUNTER_TITLE_WORDS = ['猎头', 'RPO', '寻访', '猎首'];

// HR 活跃度：视为「7日内不活跃」的文案特征
const JH_INACTIVE_WORDS = ['本月活跃', '2月内活跃', '3月内活跃', '半年前活跃', '近半年活跃', '一年前活跃'];
