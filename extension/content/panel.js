// ============================================================
// panel.js — 面板 UI 与主逻辑
// 四大模块：我的简历 / 采集配置 / 岗位管理 / 投递记录
// ============================================================

// 注意：BOSS 有反调试机制（F12/右键检查会被踢出登录），排查选择器问题请用面板「诊断」按钮
const JHPanel = {
  el: null,
  fab: null,
  collecting: false,
  analyzing: false,
  delivering: false,
  deliverQueue: [],

  // ==========================================================
  // 初始化
  // ==========================================================
  async init() {
    this._flashId = null; // 采集即时显示时新卡片的高亮标记
    if (document.getElementById('jh-panel')) return;
    this.render();
    this.bindEvents();
    await this.restoreTab(); // 恢复上次停留的 Tab（导航重载后停在原页面）
    await this.loadAll();
  },

  render() {
    // 悬浮球（面板收起时显示）
    this.fab = document.createElement('div');
    this.fab.id = 'jh-fab';
    this.fab.textContent = 'JH';
    this.fab.title = 'JobHunter 求职助手';
    document.body.appendChild(this.fab);

    this.el = document.createElement('div');
    this.el.id = 'jh-panel';
    this.el.innerHTML = `
    <div class="jh-header">
      <div class="jh-title">JobHunter<small>智能求职助手</small></div>
      <div class="jh-collapse" title="收起面板">^</div>
    </div>
      <div class="jh-tabs">
        <div class="jh-tab jh-active" data-tab="resume">我的简历</div>
        <div class="jh-tab" data-tab="config">采集配置</div>
        <div class="jh-tab" data-tab="jobs">岗位管理</div>
        <div class="jh-tab" data-tab="logs">投递记录</div>
      </div>
      <div class="jh-body">
        <div class="jh-status" id="jh-status"></div>

        <!-- ① 我的简历 -->
        <div class="jh-section jh-active" data-sec="resume">
          <label class="jh-label">姓名 / 称呼（打招呼文案开头使用）</label>
          <input class="jh-input" id="jh-name" placeholder="如：张三 或 张女士，文案将以「您好，我是张三」开头" />
          <label class="jh-label">简历图片（投递时发送给招聘方）</label>
          <div class="jh-upload" id="jh-upload">
            <div id="jh-upload-hint">点击上传简历图片<br><small style="color:#94a3b8">支持 PNG / JPG，建议长图</small></div>
            <img id="jh-resume-img" style="display:none" />
          </div>
          <input type="file" id="jh-file" accept="image/*" style="display:none" />
          <label class="jh-label">简历文字版（用于 AI 匹配分析与文案生成）</label>
          <textarea class="jh-textarea" id="jh-resume-text" rows="9" placeholder="粘贴你的简历全文：个人信息、工作经历、项目经验、技能等。越完整，匹配分析和打招呼文案越精准。"></textarea>
          <button class="jh-btn jh-btn-primary jh-btn-block" id="jh-save-resume">保存简历</button>
        </div>

        <!-- ② 采集配置 -->
        <div class="jh-section" data-sec="config">
          <label class="jh-label">意向岗位关键词</label>
          <input class="jh-input" id="jh-kw" placeholder="如：产品经理" />
          <label class="jh-label">意向城市</label>
          <input class="jh-input" id="jh-cities" placeholder="如：深圳,广州,杭州" />
          <label class="jh-label">期望薪资</label>
          <div class="jh-salary-row">
            <input class="jh-input jh-input-short" id="jh-salary" placeholder="如：15-25K" />
            <label class="jh-check jh-check-inline"><input type="checkbox" id="jh-f-salary" /> 按期望薪资过滤</label>
          </div>
          <label class="jh-label">过滤岗位关键词（命中即排除）</label>
          <input class="jh-input" id="jh-exclude" placeholder="如：外包,销售,保险" />
          <label class="jh-check"><input type="checkbox" id="jh-f-inactive" /> 过滤 7 日不活跃的 HR</label>
          <label class="jh-check"><input type="checkbox" id="jh-f-hunter" /> 过滤猎头发布的岗位（代招）</label>
          <div class="jh-row">
            <div>
              <label class="jh-label">单次采集数量</label>
              <input class="jh-input" id="jh-count" type="number" min="1" max="50" value="20" />
              <div class="jh-hint">上限 50，建议 20 以内更稳妥</div>
            </div>
            <div>
              <label class="jh-label">每日投递上限</label>
              <input class="jh-input" id="jh-daily" type="number" min="1" max="100" value="30" />
              <div class="jh-hint">保护账号，达到后当日停止投递</div>
            </div>
          </div>
          <label class="jh-label">DeepSeek API Key</label>
          <input class="jh-input" id="jh-apikey" type="password" placeholder="sk-...（仅存本地，不上传任何服务器）" />
          <button class="jh-btn jh-btn-primary jh-btn-block" id="jh-save-config">保存配置</button>
        </div>

        <!-- ③ 岗位管理 -->
        <div class="jh-section" data-sec="jobs">
          <div class="jh-toolbar">
            <button class="jh-btn jh-btn-primary jh-btn-sm" id="jh-collect">岗位采集</button>
            <button class="jh-btn jh-btn-ghost jh-btn-sm" id="jh-analyze">匹配度分析</button>
            <button class="jh-btn jh-btn-ghost jh-btn-sm" id="jh-diag" title="自动生成页面结构报告并复制：列表页查采集问题、聊天页查发图按钮结构（含图片发送按钮专项）、详情页查投递小窗">诊断</button>
            <div class="jh-spacer"></div>
            <label class="jh-check" style="margin:0"><input type="checkbox" id="jh-show-delivered" /> 显示已投递</label>
          </div>
          <div class="jh-toolbar">
            <button class="jh-btn jh-btn-primary jh-btn-sm" id="jh-deliver">文字投递</button>
            <button class="jh-btn jh-btn-accent jh-btn-sm" id="jh-deliver-img" title="先发简历图、再发打招呼文案（仅一次唤醒会话框）">图片投递</button>
            <button class="jh-btn jh-btn-danger jh-btn-sm" id="jh-del">删除选中</button>
          </div>
          <div class="jh-toolbar">
            <label class="jh-check" style="margin:0"><input type="checkbox" id="jh-selall" /> 全选</label>
            <label class="jh-check" style="margin:0 0 0 12px" title="勾选后批量投递不再逐个确认：生成文案后自动发送并自动进入下一岗（带随机间隔与风控保护）"><input type="checkbox" id="jh-auto-loop" /> 自动投递</label>
            <div class="jh-spacer"></div>
            <span class="jh-hint" id="jh-jobcount"></span>
          </div>
          <div id="jh-joblist"><div class="jh-empty">暂无岗位，点击「岗位采集」开始</div></div>
        </div>

        <!-- ④ 投递记录 -->
        <div class="jh-section" data-sec="logs">
          <!-- 上半：今日速览 -->
          <div class="jh-ovw-title">今日速览</div>
          <div class="jh-today">
            <div class="jh-today-card"><b id="jh-t-found">0</b><span>新发现</span></div>
            <div class="jh-today-card"><b id="jh-t-filtered">0</b><span>已过滤</span></div>
            <div class="jh-today-card"><b id="jh-t-match">0</b><span>高匹配</span></div>
            <div class="jh-today-card"><b id="jh-t-delivered">0</b><span>已投递</span></div>
          </div>
          <!-- 下半：进度概览 -->
          <div class="jh-ovw-title">进度概览</div>
          <div class="jh-progress">
            <div class="jh-ring">
              <svg viewBox="0 0 120 120" width="104" height="104">
                <circle class="jh-ring-bg" cx="60" cy="60" r="52" />
                <circle class="jh-ring-fg" id="jh-ring-fg" cx="60" cy="60" r="52" />
              </svg>
              <div class="jh-ring-center"><b id="jh-ring-num">0</b><span>累计投递</span></div>
            </div>
          </div>
          <div id="jh-loglist"><div class="jh-empty">暂无投递记录</div></div>
        </div>
      </div>
      <div class="jh-footer">&copy; 周周周晏宁</div>
    </div>`;
    document.body.appendChild(this.el);
  },

  // ==========================================================
  // 事件绑定
  // ==========================================================
  bindEvents() {
    // 展开/收起
    this.fab.addEventListener('click', () => this.open());
    this.el.querySelector('.jh-collapse').addEventListener('click', () => this.close());

    // Tab 切换（记忆当前页，导航重载后面板恢复停留在此页）
    this.el.querySelectorAll('.jh-tab').forEach((tab) => {
      tab.addEventListener('click', () => this.activateTab(tab));
    });

    // 简历上传
    const upload = this.el.querySelector('#jh-upload');
    const file = this.el.querySelector('#jh-file');
    upload.addEventListener('click', () => file.click());
    file.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) return this.status('图片超过4MB，请压缩后上传', 'warn');
      const reader = new FileReader();
      reader.onload = () => {
        const img = this.el.querySelector('#jh-resume-img');
        img.src = reader.result;
        img.style.display = 'block';
        this.el.querySelector('#jh-upload-hint').style.display = 'none';
        this._pendingImage = { dataUrl: reader.result, name: f.name };
      };
      reader.readAsDataURL(f);
    });

    this.el.querySelector('#jh-save-resume').addEventListener('click', () => this.saveResume());
    this.el.querySelector('#jh-save-config').addEventListener('click', () => this.saveConfig());
    this.el.querySelector('#jh-collect').addEventListener('click', () => this.startCollect());
    this.el.querySelector('#jh-diag').addEventListener('click', () => this.runDiagnostics());
    this.el.querySelector('#jh-analyze').addEventListener('click', () => this.startAnalyze());
    this.el.querySelector('#jh-del').addEventListener('click', () => this.deleteSelected());
    this.el.querySelector('#jh-deliver').addEventListener('click', () => this.startDeliver());
    this.el.querySelector('#jh-deliver-img').addEventListener('click', () => this.startDeliver(true));
    this.el.querySelector('#jh-selall').addEventListener('change', (e) => {
      // 已投递岗位复选框为 disabled，全选不勾选它们
      this.el.querySelectorAll('#jh-joblist input[type="checkbox"]:not([disabled])').forEach((c) => (c.checked = e.target.checked));
      this.updateJobCount();
    });
    // 单个岗位勾选变化（change 冒泡到列表容器）→ 实时刷新「已选 N 个」
    this.el.querySelector('#jh-joblist').addEventListener('change', (e) => {
      if (e.target.matches('input[type="checkbox"]')) this.updateJobCount();
    });
    // 「显示已投递」开关：勾选后即时重渲染（仅展示已投递岗位）并记忆偏好
    this.el.querySelector('#jh-show-delivered').addEventListener('change', async (e) => {
      await JH.set({ showDelivered: e.target.checked });
      this.renderJobs(this._jobs || []);
    });
    // 「自动循环投递」开关：勾选后批量投递自动发送并自动续投（偏好持久化）
    this.el.querySelector('#jh-auto-loop').addEventListener('change', async (e) => {
      await JH.set({ autoLoop: e.target.checked });
      if (!e.target.checked && this.clearAutoTimer) this.clearAutoTimer();
      this.status(e.target.checked ? '已开启自动循环投递：生成文案后将自动发送并进入下一岗' : '已关闭自动循环投递：恢复逐条确认', 'info', 4000);
    });

    // 面板展开时，点击面板及悬浮球以外的任意处自动收起（遮罩卡片属面板内，不会误关）
    document.addEventListener('click', (e) => {
      if (!this.el.classList.contains('jh-open')) return;            // 已收起则不处理
      if (this.el.contains(e.target) || this.fab.contains(e.target)) return; // 面板内 / 悬浮球内忽略
      this.close();
    });
  },

  open() {
    this.el.classList.add('jh-open');
    this.fab.classList.add('jh-hidden');
  },
  close() {
    this.el.classList.remove('jh-open');
    this.fab.classList.remove('jh-hidden');
  },
  toggle() {
    this.el.classList.contains('jh-open') ? this.close() : this.open();
  },

  /** 切换到指定 Tab，并记忆当前页（用于导航重载后恢复停留页面） */
  activateTab(tab) {
    if (!tab || !tab.dataset) return;
    this.el.querySelectorAll('.jh-tab').forEach((t) => t.classList.remove('jh-active'));
    this.el.querySelectorAll('.jh-section').forEach((s) => s.classList.remove('jh-active'));
    tab.classList.add('jh-active');
    const sec = this.el.querySelector(`[data-sec="${tab.dataset.tab}"]`);
    if (sec) sec.classList.add('jh-active');
    // 记忆当前停留的页面，导航后 content script 重载时恢复
    JH.set({ activeTab: tab.dataset.tab });
    // 切到「投递记录」时重算今日速览 / 进度概览（数据可能在其他标签期间变化）
    if (tab.dataset.tab === 'logs') this.refreshLogsTab();
  },

  /** content script 重新加载后，恢复上次停留的 Tab（默认「我的简历」兜底） */
  async restoreTab() {
    const { activeTab } = await JH.get(['activeTab']);
    if (!activeTab) return;
    const tab = this.el.querySelector(`.jh-tab[data-tab="${activeTab}"]`);
    if (tab) this.activateTab(tab);
  },

  status(msg, type = 'info', autoHide = 5000) {
    const bar = this.el.querySelector('#jh-status');
    bar.className = `jh-status jh-show jh-status-${type}`;
    bar.innerHTML = msg;
    clearTimeout(this._statusTimer);
    if (autoHide) this._statusTimer = setTimeout(() => bar.classList.remove('jh-show'), autoHide);
  },

  // ==========================================================
  // 数据加载与保存
  // ==========================================================
  async loadAll() {
    const { resume = {}, config = {}, jobs = [], logs = [], stats = {} } = await JH.get(['resume', 'config', 'jobs', 'logs', 'stats']);
    // 简历
    if (resume.imageDataUrl) {
      const img = this.el.querySelector('#jh-resume-img');
      img.src = resume.imageDataUrl;
      img.style.display = 'block';
      this.el.querySelector('#jh-upload-hint').style.display = 'none';
    }
    if (resume.text) this.el.querySelector('#jh-resume-text').value = resume.text;
    if (resume.name) this.el.querySelector('#jh-name').value = resume.name;
    // 配置
    if (config.jobKeywords) this.el.querySelector('#jh-kw').value = config.jobKeywords;
    if (config.salaryRange) this.el.querySelector('#jh-salary').value = config.salaryRange;
    if (config.cities) this.el.querySelector('#jh-cities').value = config.cities;
    if (config.excludeKeywords) this.el.querySelector('#jh-exclude').value = config.excludeKeywords;
    this.el.querySelector('#jh-f-inactive').checked = !!config.filterInactiveHR;
    this.el.querySelector('#jh-f-hunter').checked = !!config.filterHeadhunter;
    this.el.querySelector('#jh-f-salary').checked = config.filterSalary !== false; // 默认开
    if (config.collectCount) this.el.querySelector('#jh-count').value = config.collectCount;
    if (config.dailyLimit) this.el.querySelector('#jh-daily').value = config.dailyLimit;
    if (config.apiKey) this.el.querySelector('#jh-apikey').value = config.apiKey;
    // 旧数据清洗：修正历史采集中"公司名误存为岗位名"和"薪资乱码（加密字体导致缺数字）"的脏数据
    let dirty = false;
    for (const j of jobs) {
      if (j.company && !JHCollector.isValidCompany(j.company, j.title)) {
        j.company = '';
        dirty = true;
      }
      const cleanSalary = JHCollector.sanitizeSalary(j.salary);
      if (j.salary !== cleanSalary) {
        j.salary = cleanSalary;
        dirty = true;
      }
    }
    if (dirty) await JH.set({ jobs });

    // 简历图功能暂不可用：凡是已发过打招呼文案的岗位（旧「待补发」状态）一律视为已投递，
    // 不再保留「待补发」、也不再自动补发——发过文案即视为完成。
    let normalized = false;
    for (const j of jobs) {
      if (j.status === 'partial') {
        j.status = 'delivered';
        delete j.pending;
        delete j.greeting;
        delete j.resendTries;
        normalized = true;
      }
    }
    if (normalized) await JH.set({ jobs });

    // 恢复「自动循环投递」偏好
    const { autoLoop = false } = await JH.get(['autoLoop']);
    this.el.querySelector('#jh-auto-loop').checked = !!autoLoop;

    // 恢复「显示已投递」偏好（默认不勾选，仅看未投递）
    const { showDelivered = false } = await JH.get(['showDelivered']);
    this.el.querySelector('#jh-show-delivered').checked = !!showDelivered;

    // 岗位 + 日志
    this.renderJobs(jobs);
    await this.renderLogs(logs, stats);
  },

  async saveResume() {
    const { resume = {} } = await JH.get(['resume']);
    const next = {
      imageDataUrl: this._pendingImage ? this._pendingImage.dataUrl : resume.imageDataUrl,
      imageName: this._pendingImage ? this._pendingImage.name : resume.imageName,
      name: this.el.querySelector('#jh-name').value.trim(),
      text: this.el.querySelector('#jh-resume-text').value.trim()
    };
    if (!next.text) return this.status('请粘贴简历文字版（AI分析必需）', 'warn');
    await JH.set({ resume: next });
    this.status('简历已保存 ✓', 'ok');
  },

  async saveConfig() {
    const count = Math.min(50, Math.max(1, parseInt(this.el.querySelector('#jh-count').value) || 20));
    const config = {
      jobKeywords: this.el.querySelector('#jh-kw').value.trim(),
      salaryRange: this.el.querySelector('#jh-salary').value.trim(),
      cities: this.el.querySelector('#jh-cities').value.trim(),
      excludeKeywords: this.el.querySelector('#jh-exclude').value.trim(),
      filterInactiveHR: this.el.querySelector('#jh-f-inactive').checked,
      filterHeadhunter: this.el.querySelector('#jh-f-hunter').checked,
      filterSalary: this.el.querySelector('#jh-f-salary').checked,
      collectCount: count,
      dailyLimit: Math.max(1, parseInt(this.el.querySelector('#jh-daily').value) || 30),
      apiKey: this.el.querySelector('#jh-apikey').value.trim()
    };
    if (!config.jobKeywords) return this.status('请填写意向岗位关键词', 'warn');
    this.el.querySelector('#jh-count').value = count;
    await JH.set({ config });
    // 改期望薪资/开关后：本地重算所有存量岗位的薪资标记（符合的自动恢复，无需重新抓网页）
    const { jobs: allJobs = [] } = await JH.get(['jobs']);
    let recalculated = false;
    for (const j of allJobs) {
      const ex = JHCollector.isSalaryExcluded(j.salary, config.salaryRange, config.filterSalary);
      if (!!j.salaryExcluded !== ex) { j.salaryExcluded = ex; recalculated = true; }
    }
    if (recalculated) await JH.set({ jobs: allJobs });
    this.renderJobs(allJobs);
    this.status('配置已保存 ✓' + (recalculated ? '，薪资过滤已更新' : ''), 'ok');
  },

  // ==========================================================
  // 岗位采集
  // ==========================================================
  /**
   * 跳转到目标搜索页；带防死循环保护。
   * 若 BOSS 在导航后改写/丢弃了 query、city 参数，searchMatches() 会永远为假，
   * 形成「跳转 → 自动采集 → 判定不匹配 → 再跳转」的无限刷新。
   * 故记录本次跳转目标：同一 URL 在 60 秒内只跳一次；若已经跳过来了但 URL 参数
   * 被站点改写，就认定「已落地」，改为就地采集并提示，绝不再刷新。
   * 跳转成功落地采集时由调用方清空 collectNav（见 collectSingle / 多城市分支）。
   * @returns {boolean} true = 已发起跳转（调用方应立即 return）
   */
  async gotoSearch(url, tipText) {
    const { collectNav } = await JH.get(['collectNav']);
    const now = Date.now();
    if (collectNav && collectNav.url === url && now - collectNav.ts < 60000) {
      this.status('已跳转到目标搜索页，但页面地址参数被站点改写，改为采集当前页面。若结果与配置不符，请在 BOSS 搜索框手动搜索后再点采集', 'warn', 0);
      return false;
    }
    await JH.set({ collectNav: { url, ts: now }, autoCollect: true });
    this.status(tipText, 'info');
    location.href = url;
    return true;
  },

  async startCollect() {
    if (this.collecting) return this.status('采集进行中…', 'info');
    const { config = {}, jobs = [], deliveredIds = {} } = await JH.get(['config', 'jobs', 'deliveredIds']);
    if (!config.jobKeywords) {
      // 清掉可能残留的自动续跑标记，避免它在时间窗内被后续页面加载重复触发
      await JH.set({ autoCollect: false, collectNav: null });
      return this.status('请先在「采集配置」中填写意向岗位并保存', 'warn');
    }

    const cities = (config.cities || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const maxCount = config.collectCount || 20;

    // 单城市 / 无城市：保持原逻辑（向后兼容）
    if (cities.length <= 1) {
      const city = cities[0] || '';
      // 只有「当前页正是按本次配置搜出来的结果页」才就地采集；
      // 否则（推荐页 / 详情页 / 上一次条件的搜索页）一律重新搜索，保证配置改动即时生效。
      if (!JHCollector.searchMatches(config.jobKeywords, city)) {
        const url = JHCollector.buildSearchUrl(config.jobKeywords, city);
        await JH.set({ collectCtx: null });
        const tip = `正在按当前配置重新搜索：${config.jobKeywords} · ${JHCollector.cityLabel(city)}…`;
        if (await this.gotoSearch(url, tip)) return;
      }
      return this.collectSingle(city, config, jobs, deliveredIds, maxCount);
    }

    // ---- 多城市遍历：跨城市累积采集，最后统一进详情页补采 ----
    // 页面跳转会重载 content script，故用 storage 里的 collectCtx 跨城市传递状态
    let ctx = (await JH.get('collectCtx') || {}).collectCtx;

    // 采集配置已变更（关键词或城市列表不同于上下文里锁定的那份）→ 丢弃遗留上下文重新开始，
    // 否则会带着上一次的旧条件继续遍历，用户改的配置不生效。
    if (ctx && (ctx.jobKeywords !== config.jobKeywords ||
                (ctx.cities || []).join(',') !== cities.join(','))) {
      ctx = null;
      await JH.set({ collectCtx: null });
    }

    // 首次启动：初始化上下文，跳到第一个城市
    if (!ctx) {
      ctx = {
        cities,
        idx: 0,
        jobKeywords: config.jobKeywords,
        maxCount,
        collectedIds: jobs.map((j) => j.id), // 已有岗位也计入去重
        listJobs: [],
        scanned: 0,      // 跨城市累计：本次扫描到的有效岗位卡片数
        duplicate: 0,    // 已采集/已投递（重复）被跳过
        filteredList: 0  // 列表级被过滤项挡掉（关键词/猎头/基础筛选）
      };
      await JH.set({ collectCtx: ctx }); // 多城市采集上下文
      const url = JHCollector.buildSearchUrl(config.jobKeywords, cities[0]);
      if (await this.gotoSearch(url, `开始多城市采集（共 ${cities.length} 城）：${cities[0]}`)) return;
    }

    // 当前页不是「本城市 + 本关键词」的搜索结果页 → 先跳过去
    const curCity = ctx.cities[ctx.idx] || '';
    if (!JHCollector.searchMatches(ctx.jobKeywords, curCity)) {
      const url = JHCollector.buildSearchUrl(ctx.jobKeywords, curCity);
      if (await this.gotoSearch(url, `正在前往「${JHCollector.cityLabel(curCity)}」搜索页…`)) return;
    }

    // 城市校验：BOSS 可能忽略 URL 的 ?city= 而按自身存储城市渲染，
    // 故落地后抽样实际渲染城市，不符则自动切到目标城市再采（避免“搜深圳却采到上海”）。
    const alreadyTried = !!(ctx.cityFixAttempts && ctx.cityFixAttempts[ctx.idx]);
    const cityCheck = await JHCollector.ensureTargetCity(curCity, alreadyTried);
    if (cityCheck.navigated) {
      const nextUrl = JHCollector.buildSearchUrl(ctx.jobKeywords, curCity);
      ctx.cityFixAttempts = Object.assign({}, ctx.cityFixAttempts, { [ctx.idx]: 1 });
      await JH.set({ collectCtx: ctx, autoCollect: true, collectNav: { url: nextUrl, ts: Date.now() } });
      this.status(`正在切换至「${JHCollector.cityLabel(curCity)}」重新采集…`, 'info', 0);
      return;
    }
    if (!cityCheck.ok) {
      this.status(`⚠️ 页面实际城市与配置不符（期望 ${curCity}），已尽力切换失败，将按实际渲染城市采集`, 'warn', 6000);
    }

    this.collecting = true;
    await JH.set({ collectNav: null }); // 已成功落到目标搜索页，重置跳转计数
    const btn = this.el.querySelector('#jh-collect');
    btn.innerHTML = '<span class="jh-spin"></span>采集中';
    btn.disabled = true;
    try {
      const existingIds = new Set(ctx.collectedIds);
      const remain = Math.max(0, ctx.maxCount - ctx.listJobs.length); // 总上限按剩余配额分摊到各城市
      this.status(`多城市采集（${ctx.idx + 1}/${ctx.cities.length}）：${ctx.cities[ctx.idx]}`, 'info', 0);

      const listRes = await JHCollector.collectFromListPage(config, existingIds, deliveredIds, remain, (job, reasons) => this.recordFiltered(job, reasons));
      if (listRes.risk) {
        await JH.set({ collectCtx: null, autoCollect: false });
        this.status('⚠️ 检测到安全验证，采集已熔断。请手动完成验证后重新点击采集', 'error', 0);
        return;
      }
      // 跨城市累计列表阶段计数
      ctx.scanned += listRes.scanned || 0;
      ctx.duplicate += listRes.duplicate || 0;
      ctx.filteredList += listRes.filteredList || 0;

      // 合并当前城市结果（跨城市去重）
      let added = 0;
      for (const j of listRes.jobs) {
        if (!ctx.collectedIds.includes(j.id)) {
          ctx.listJobs.push(j);
          ctx.collectedIds.push(j.id);
          added++;
        }
      }
      ctx.idx++;

      // 还有下一城市 → 持久化并跳转（关键词以 ctx 里锁定的那份为准）
      // collectNav 同时写入：万一 autoCollect 因写入与导航竞争而丢失，落地页仍可凭它兜底续跑
      if (ctx.idx < ctx.cities.length) {
        const nextUrl = JHCollector.buildSearchUrl(ctx.jobKeywords, ctx.cities[ctx.idx]);
        await JH.set({ collectCtx: ctx, autoCollect: true, collectNav: { url: nextUrl, ts: Date.now() } });
        this.status(`已采「${ctx.cities[ctx.idx - 1]}」+${added} 个，前往 ${ctx.cities[ctx.idx]}…`, 'info');
        location.href = nextUrl;
        return;
      }

      // 全部城市采完 → 统一进详情页补采
      await JH.set({ collectCtx: null, autoCollect: false, collectNav: null });
      this.status(`列表采集完成（共 ${ctx.listJobs.length} 个，跨 ${ctx.cities.length} 城），正在补采 JD…`, 'info', 0);
      await this.enrichAndSave(ctx.listJobs, config, jobs, deliveredIds, { scanned: ctx.scanned, duplicate: ctx.duplicate, filteredList: ctx.filteredList });
    } catch (e) {
      this.status('采集出错：' + (e.message || e), 'error');
    } finally {
      this.collecting = false;
      btn.innerHTML = '岗位采集';
      btn.disabled = false;
    }
  },

  /** 单城市采集（原逻辑，向后兼容 cities.length<=1） */
  async collectSingle(city, config, jobs, deliveredIds, maxCount) {
    this.collecting = true;
    await JH.set({ collectNav: null });
    const btn = this.el.querySelector('#jh-collect');
    btn.innerHTML = '<span class="jh-spin"></span>采集中';
    btn.disabled = true;
    this.status(`正在采集「${config.jobKeywords} · ${JHCollector.cityLabel(city)}」搜索结果…请勿关闭本页`, 'info', 0);
    // 城市校验（单城场景）：同多城逻辑，避免 BOSS 忽略 ?city= 渲染错城市
    const singleUrl = JHCollector.buildSearchUrl(config.jobKeywords, city);
    const { cityFixTried } = await JH.get('cityFixTried');
    const singleTried = cityFixTried === singleUrl;
    const sc = await JHCollector.ensureTargetCity(city, singleTried);
    if (sc.navigated) {
      await JH.set({ cityFixTried: singleUrl, autoCollect: true, collectNav: { url: singleUrl, ts: Date.now() } });
      this.status(`正在切换至「${JHCollector.cityLabel(city)}」重新采集…`, 'info', 0);
      return;
    }
    if (!sc.ok) this.status(`⚠️ 页面实际城市与配置不符（期望 ${city}），将按实际渲染城市采集`, 'warn', 6000);
    try {
      const existingIds = new Set(jobs.map((j) => j.id));
      const listRes = await JHCollector.collectFromListPage(config, existingIds, deliveredIds, maxCount, (job, reasons) => this.recordFiltered(job, reasons));
      if (listRes.risk) {
        this.status('⚠️ 检测到安全验证，采集已熔断。请手动完成验证后再试', 'error', 0);
        return;
      }
      await this.enrichAndSave(listRes.jobs, config, jobs, deliveredIds, { scanned: listRes.scanned || 0, duplicate: listRes.duplicate || 0, filteredList: listRes.filteredList || 0 });
      await JH.set({ cityFixTried: null });
    } catch (e) {
      this.status('采集出错：' + (e.message || e), 'error');
    } finally {
      this.collecting = false;
      btn.innerHTML = '岗位采集';
      btn.disabled = false;
    }
  },

  /** 列表岗位 → 后台逐个详情补采 → 详情级过滤 → 合并存入 jobs */
  // ==========================================================
  // 记录被过滤掉的岗位（不进主岗位列表，仅用于「今日速览-已过滤」统计）
  // 维度 key：salary(薪资) / keyword(关键词) / headhunter(猎头代招) / inactiveHR(7日不活跃HR)
  // ==========================================================
  async recordFiltered(job, reasons) {
    if (!job || !job.id || !reasons || !reasons.length) return;
    const { filteredJobs = [] } = await JH.get(['filteredJobs']);
    if (filteredJobs.some((f) => f.id === job.id)) return; // 按 id 去重
    filteredJobs.push({
      id: job.id,
      title: job.title || '',
      company: job.company || '',
      cityName: job.cityName || '',
      reasons: reasons.slice(),
      filteredAtTs: Date.now(),
    });
    // 控制体积：超过 800 条时丢弃最旧的
    const trimmed = filteredJobs.length > 800 ? filteredJobs.slice(filteredJobs.length - 800) : filteredJobs;
    await JH.set({ filteredJobs: trimmed });
  },

  async enrichAndSave(listJobs, config, jobs, deliveredIds, listStats = { scanned: 0, duplicate: 0, filteredList: 0 }) {
    const scannedN = listStats.scanned || 0;
    const duplicateN = listStats.duplicate || 0;
    const filteredListN = listStats.filteredList || 0;
    if (!listJobs.length) {
      this.status(`本次扫描 ${scannedN} 个 · 新增 0 · 过滤 ${filteredListN} · 重复 ${duplicateN}`, 'warn', 8000);
      return 0;
    }
    this.status(`列表采集完成 ${listJobs.length} 个，正在逐个进详情页补采 JD（每个3~8秒）…`, 'info', 0);

    const { jobs: latestJobs = [] } = await JH.get(['jobs']);
    const { config: live = {} } = await JH.get(['config']);

    // 以内存数组为唯一数据源，边补采边写入，避免并发存储读写互相覆盖
    const liveJobs = [...latestJobs];
    const handledIds = new Set(liveJobs.map((j) => j.id));
    let kept = 0, filtered = 0, risk = false;

    // 详情筛选的 reason → 过滤维度 key（用于「已过滤」统计记录）
    const reasonToDim = (reason) => {
      if (!reason) return null;
      if (reason.includes('猎头')) return 'headhunter';
      if (reason.includes('HR') || reason.includes('不活跃')) return 'inactiveHR';
      if (reason.includes('过滤词') || reason.includes('JD')) return 'keyword';
      return null;
    };

    // 详情补采每完成一个岗位，background 会通过 COLLECT_PROGRESS 推送；
    // 通过详情筛选的岗位立即落库+渲染（不通过的不进面板，故无「先显示后移除」）。
    const onProgress = (msg) => {
      if (risk) return;
      if (msg.type === 'COLLECT_RISK') { risk = true; return; }
      if (msg.type !== 'COLLECT_PROGRESS') return;
      const job = msg.job;
      if (!job || !job.id || handledIds.has(job.id)) return;
      const check = JHCollector.passDetailFilter(job, config);
      if (!check.pass) {
        handledIds.add(job.id); filtered++;
        const dim = reasonToDim(check.reason);
        if (dim) this.recordFiltered(job, [dim]);
        return;
      }
      handledIds.add(job.id);
      job.salaryExcluded = JHCollector.isSalaryExcluded(job.salary, live.salaryRange, live.filterSalary);
      if (job.salaryExcluded) this.recordFiltered(job, ['salary']);
      liveJobs.push(job);
      kept++;
      JH.set({ jobs: liveJobs });
      this._flashId = job.id;            // 新增卡片高亮一次
      this.renderJobs(liveJobs);
      const done = msg.done || kept, total = msg.total || listJobs.length;
      this.status(`详情补采中 ${done}/${total} · 已通过 ${kept}${filtered ? ` · 过滤 ${filtered}` : ''}`, 'info', 0);
    };
    chrome.runtime.onMessage.addListener(onProgress);

    try {
      const resp = await JH.send({ type: 'COLLECT_DETAILS', jobs: listJobs });
      const enriched = (resp && resp.results) || [];

      // 兜底对账：若个别 COLLECT_PROGRESS 消息丢失，用最终 results 补齐通过但未显示的岗位
      for (const job of enriched) {
        if (!job || !job.id || handledIds.has(job.id)) continue;
        const check = JHCollector.passDetailFilter(job, config);
        if (!check.pass) { handledIds.add(job.id); filtered++; const dim = reasonToDim(check.reason); if (dim) this.recordFiltered(job, [dim]); continue; }
        handledIds.add(job.id);
        job.salaryExcluded = JHCollector.isSalaryExcluded(job.salary, live.salaryRange, live.filterSalary);
        if (job.salaryExcluded) this.recordFiltered(job, ['salary']);
        liveJobs.push(job);
        kept++;
      }
      await JH.set({ jobs: liveJobs });
      this.renderJobs(liveJobs);
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
    }

    if (risk) {
      this.status('⚠️ 检测到安全验证，详情补采已中断。已采集的岗位已保留在面板，请手动完成验证后重新点击采集', 'error', 0);
      return kept;
    }
    const filteredN = filteredListN + filtered;
    this.status(`采集完成 ✓ 本次扫描 ${scannedN} 个 · 新增 ${kept} · 过滤 ${filteredN} · 重复 ${duplicateN}`, 'ok', 8000);
    return kept;
  },

  // ==========================================================
  // 选择器自诊断（BOSS 反调试导致 F12 不可用，用这个代替）
  // ==========================================================
  async runDiagnostics() {
    // 按当前页面类型出对应报告：
    //   详情页(job_detail) → 详情页选择器报告（排查投递小窗失败，最关键）
    //   聊天页(chat)       → 聊天页选择器报告
    //   列表页(job)        → 采集选择器报告
    // 注意：job_detail 包含 "job" 子串，必须先判详情页，否则会误进列表页分支静默报错。
    let report;
    if (location.href.includes('job_detail')) {
      report = await JHDeliver.buildDetailDiagnostics();
    } else if (location.href.includes('/web/geek/chat')) {
      report = await JHDeliver.buildChatDiagnostics();
    } else if (location.href.includes('/web/geek/job')) {
      report = JHCollector.buildDiagnostics();
    } else {
      return this.status('请在 BOSS 的岗位详情页（查投递小窗问题）、岗位列表页（查采集问题）或聊天页（查补发问题）点「诊断」', 'warn', 8000);
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(report);
      copied = true;
    } catch (e) {
      // 剪贴板权限兜底：用临时 textarea
      try {
        const ta = document.createElement('textarea');
        ta.value = report;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch (e2) { /* ignore */ }
    }
    if (copied) {
      this.status('诊断报告已复制到剪贴板 ✓ 直接粘贴发给开发者即可精准修复选择器', 'ok', 10000);
    } else {
      // 实在复制不了就弹层展示，让用户手动全选复制
      const mask = document.createElement('div');
      mask.className = 'jh-confirm-mask';
      mask.id = 'jh-diag-mask';
      mask.innerHTML = `
        <div class="jh-confirm-card">
          <h4>诊断报告（请全选复制）</h4>
          <textarea class="jh-textarea" style="height:220px;font-size:11px">${report.replace(/</g, '&lt;')}</textarea>
          <div class="jh-confirm-actions"><button class="jh-btn jh-btn-primary" id="jh-diag-close">关闭</button></div>
        </div>`;
      this.el.appendChild(mask);
      mask.querySelector('#jh-diag-close').addEventListener('click', (e) => { e.stopPropagation(); mask.remove(); });
    }
  },

  // ==========================================================
  // 匹配度分析
  // ==========================================================
  async startAnalyze() {
    if (this.analyzing) return;
    const { jobs = [], resume = {} } = await JH.get(['jobs', 'resume']);
    if (!resume.text) return this.status('请先在「我的简历」中保存简历文字版', 'warn');
    const targets = jobs.filter((j) => (j.score === null || j.score === undefined) && !j.salaryExcluded);
    if (!targets.length) return this.status('所有岗位均已分析过', 'info');

    this.analyzing = true;
    const btn = this.el.querySelector('#jh-analyze');
    btn.disabled = true;

    let done = 0;
    for (const job of targets) {
      btn.innerHTML = `<span class="jh-spin"></span>${done + 1}/${targets.length}`;
      const resp = await JH.send({ type: 'ANALYZE_MATCH', job, resumeText: resume.text });
      if (resp && resp.error) {
        this.status('分析失败：' + resp.error, 'error', 8000);
        break;
      }
      if (resp && resp.ok) {
        job.score = resp.result.score;
        job.scoreReason = resp.result.reason;
        job.keywords = resp.result.keywords;
        job.status = 'analyzed';
        job.analyzedAtTs = Date.now();
        // 实时保存 + 刷新
        const { jobs: cur = [] } = await JH.get(['jobs']);
        const idx = cur.findIndex((j) => j.id === job.id);
        if (idx >= 0) cur[idx] = job;
        await JH.set({ jobs: cur });
        this.renderJobs(cur);
      }
      done++;
      await JH.randSleep(500, 1500); // API 节奏
    }

    this.analyzing = false;
    btn.disabled = false;
    btn.innerHTML = '匹配度分析';
    if (done) this.status(`匹配度分析完成 ✓ 共 ${done} 个岗位`, 'ok');
  },

  // ==========================================================
  // 岗位列表渲染
  // ==========================================================
  renderJobs(jobs) {
    this._jobs = jobs; // 缓存，供「显示已投递」开关即时重渲染
    const showDelivered = this.el.querySelector('#jh-show-delivered') && this.el.querySelector('#jh-show-delivered').checked;
    const undelivered = jobs.filter((j) => j.status !== 'delivered' && !j.salaryExcluded);
    const delivered = jobs.filter((j) => j.status === 'delivered');
    const list = this.el.querySelector('#jh-joblist');

    if (!jobs.length) {
      list.innerHTML = '<div class="jh-empty">暂无岗位，点击「岗位采集」开始</div>';
      this.updateJobCount();
      return;
    }

    // 未勾选「显示已投递」：仅展示未投递岗位（平铺，不混入已投递）
    if (!showDelivered) {
      if (!undelivered.length) {
        list.innerHTML = '<div class="jh-empty">所有岗位均已投递 ✓ 勾选上方「显示已投递」可查看</div>';
        this.updateJobCount();
        return;
      }
      list.innerHTML = this.renderJobCards(undelivered);
      this.bindJobLinks(list);
      this.updateJobCount();
      return;
    }

    // 已勾选「显示已投递」：仅展示已投递岗位（不再出现「未投递 / 已投递」切换按钮）
    if (!delivered.length) {
      list.innerHTML = '<div class="jh-empty">暂无已投递岗位</div>';
      this.updateJobCount();
      return;
    }
    list.innerHTML = this.renderJobCards(delivered);
    this.bindJobLinks(list);
    this.updateJobCount();
  },

  /** 更新岗位管理副标题：总数 + 当前勾选准备投递的岗位数（实时刷新）
   *  规则：有勾选岗位 → 「共 x 个岗位 · 已选 x 个」；未勾选（含列表为空）→ 「共 x 个岗位」（已过滤统计已移至采集完成后的常驻汇总 banner） */
  updateJobCount() {
    const el = this.el.querySelector('#jh-jobcount');
    if (!el) return;
    const jobs = this._jobs || [];
    const showDelivered = this.el.querySelector('#jh-show-delivered') && this.el.querySelector('#jh-show-delivered').checked;
    const undelivered = jobs.filter((j) => j.status !== 'delivered' && !j.salaryExcluded);
    const delivered = jobs.filter((j) => j.status === 'delivered');
    const sel = this.getSelectedIds().length;
    el.textContent = showDelivered
      ? '未投递 ' + undelivered.length + ' 个 · 已投递 ' + delivered.length + ' 个'
      : '共 ' + undelivered.length + ' 个岗位' + (sel ? ' · 已选 ' + sel + ' 个' : '');
  },

  /** 渲染岗位卡片列表（不含分组标题），按匹配分降序，未分析在后 */
  renderJobCards(arr) {
    const sorted = [...arr].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return sorted.map((j) => {
      const flash = (j.id === this._flashId);
      if (flash) this._flashId = null; // 高亮一次即清除，避免后续重渲染反复闪
      let scoreCls = 'jh-score-none', scoreTxt = '未析';
      if (j.score !== null && j.score !== undefined) {
        scoreTxt = j.score;
        scoreCls = j.score >= 75 ? 'jh-score-high' : j.score >= 50 ? 'jh-score-mid' : 'jh-score-low';
      }
      const tags = [];
      if (j.status === 'delivered') tags.push(`<span class="jh-tag ${j.imageSent ? 'jh-tag-img' : 'jh-tag-ok'}">${j.imageSent ? '已图投' : '已投递'}</span>`);
      // 简历图功能暂不可用，「待补发」状态已废弃——发过文案即视为已投递
      (j.keywords || []).slice(0, 3).forEach((k) => tags.push(`<span class="jh-tag">${k}</span>`));
      // 副标题：公司名必显；薪资采集到才显示（不显示"面议"占位）；城市可选
      const subParts = [];
      if (j.company) subParts.push(j.company);
      if (j.salary) subParts.push(`<span class="jh-job-salary">${j.salary}</span>`);
      if (j.city) subParts.push(j.city);
      return `
        <div class="jh-job ${flash ? 'jh-job-flash' : ''}" data-id="${j.id}">
          <input type="checkbox" data-id="${j.id}" ${j.status === 'delivered' ? 'disabled' : ''} />
          <div class="jh-job-main">
            <div class="jh-job-title jh-job-link" data-url="${j.url || ''}" title="点击打开岗位详情页：${j.title}">${j.title}</div>
            ${subParts.length ? `<div class="jh-job-sub">${subParts.join(' · ')}</div>` : ''}
            ${tags.length ? `<div class="jh-job-meta">${tags.join('')}</div>` : ''}
          </div>
          <div class="jh-score ${scoreCls}" title="${j.scoreReason || ''}">${scoreTxt}${typeof scoreTxt === 'number' ? '<small>分</small>' : ''}</div>
        </div>`;
    }).join('');
  },

  /** 点击岗位名称 → 新标签页打开岗位详情页 */
  bindJobLinks(list) {
    list.querySelectorAll('.jh-job-link').forEach((elTitle) => {
      elTitle.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = elTitle.dataset.url;
        if (url) window.open(url, '_blank');
      });
    });
  },

  getSelectedIds() {
    // 已投递岗位复选框为 disabled，永不计入选中（避免误删/误投）
    return Array.from(this.el.querySelectorAll('#jh-joblist input[type="checkbox"]:checked:not([disabled])')).map((c) => c.dataset.id);
  },

  async deleteSelected() {
    const ids = this.getSelectedIds();
    if (!ids.length) return this.status('请先勾选要删除的岗位', 'warn');
    const { jobs = [] } = await JH.get(['jobs']);
    const next = jobs.filter((j) => !ids.includes(j.id));
    await JH.set({ jobs: next });
    this.renderJobs(next);
    this.el.querySelector('#jh-selall').checked = false;
    this.status(`已删除 ${ids.length} 个岗位`, 'ok');
  },

  // ==========================================================
  // 投递流程（逐条确认）
  // ==========================================================
  async startDeliver(imageMode = false) {
    if (this.delivering) return this.status('投递进行中…', 'info');
    this.imageMode = !!imageMode;
    const ids = this.getSelectedIds();
    if (!ids.length) return this.status('请先勾选要投递的岗位', 'warn');

    const { jobs = [], resume = {}, config = {}, deliveredIds = {} } = await JH.get(['jobs', 'resume', 'config', 'deliveredIds']);
    if (!resume.text) return this.status('请先保存简历文字版', 'warn');
    if (this.imageMode) {
      if (!resume.imageDataUrl) return this.status('图片投递需先在「我的简历」上传简历图片', 'warn');
    } else if (!resume.imageDataUrl) {
      this.status('提示：未上传简历图片，将只发送打招呼文案', 'warn', 6000);
    }
    if (!config.apiKey) return this.status('请先在「采集配置」中填写 DeepSeek API Key', 'warn');

    // 每日上限检查
    const dailyCount = await JH.getDailyCount();
    const limit = config.dailyLimit || 30;
    if (dailyCount >= limit) {
      return this.status(`今日已投递 ${dailyCount} 次，达每日上限 ${limit}（保护账号）。明天再来！`, 'warn', 0);
    }

    this.deliverQueue = ids
      .map((id) => jobs.find((j) => j.id === id))
      .filter((j) => j && j.status !== 'delivered' && !deliveredIds[j.id]);
    if (!this.deliverQueue.length) return this.status('选中岗位均已投递过', 'info');

    this.delivering = true;
    this._autoCount = 0;
    this._nextRestAt = JH.rand(4, 7);
    this._pendingGreeting = null;
    this._pendingGreetingJobId = null;
    await this.nextDeliverConfirm();
  },

  /** 弹出下一个岗位的确认卡片 */
  async nextDeliverConfirm() {
    if (!this.deliverQueue.length) {
      this.delivering = false;
      this._pendingGreeting = null;
      this._pendingGreetingJobId = null;
      const { stats = {} } = await JH.get(['stats']);
      this.status(`本轮投递结束 ✓ 累计：成功 ${stats.success || 0}｜跳过 ${stats.skip || 0}｜失败 ${stats.fail || 0}`, 'ok', 0);
      await this.refreshLogsTab();
      return;
    }

    // 每日上限实时检查
    const { config = {} } = await JH.get(['config']);
    const dailyCount = await JH.getDailyCount();
    if (dailyCount >= (config.dailyLimit || 30)) {
      this.delivering = false;
      this._pendingGreeting = null;
      this._pendingGreetingJobId = null;
      this.deliverQueue = [];
      this.status(`已达每日投递上限，剩余岗位明日再投`, 'warn', 0);
      return;
    }

    const job = this.deliverQueue[0];
    const { resume = {} } = await JH.get(['resume']);

    // 显示卡片（先出加载态，生成文案）
    this.showConfirmCard(job, null, this.autoLoop);

    // 若间隔期间已并行预生成好本岗文案，则直接复用（API 延迟已被藏进等待里，零风险提速）
    let resp;
    if (this.autoLoop && this._pendingGreeting && this._pendingGreetingJobId === job.id) {
      resp = await this._pendingGreeting;
      this._pendingGreeting = null;
      this._pendingGreetingJobId = null;
    } else {
      if (this._pendingGreeting) { this._pendingGreeting = null; this._pendingGreetingJobId = null; }
      resp = await JH.send({ type: 'GEN_GREETING', job, resumeText: resume.text, userName: resume.name || '' });
    }

    if (resp && resp.error) {
      this.removeConfirmCard();
      this.delivering = false;
      return this.status('文案生成失败：' + resp.error, 'error', 8000);
    }
    // 生成期间用户可能已「停止/跳过」，job 不再是队首则放弃本次弹卡
    if (this.deliverQueue[0] !== job) return;
    this._lastGreeting = resp.text;
    this.showConfirmCard(job, resp.text, this.autoLoop);
  },

  showConfirmCard(job, greeting, autoMode = false) {
    this.removeConfirmCard();
    const mask = document.createElement('div');
    mask.className = 'jh-confirm-mask';
    mask.id = 'jh-confirm';
    const canSend = greeting !== null;
    const countdownHtml = (autoMode && canSend)
      ? `<div class="jh-countdown" id="jh-countdown" style="font-size:12px;color:#0d9488;margin:6px 0 2px"></div>`
      : '';
    const sendLabel = autoMode ? '立即发送' : '确认发送';
    mask.innerHTML = `
      <div class="jh-confirm-card">
        <h4>${job.title}</h4>
        <div class="jh-confirm-sub">${[job.company, job.salary].filter(Boolean).join(' · ')}　剩余 ${this.deliverQueue.length} 个待投${autoMode ? ' · 自动模式' : ''}${this.imageMode ? ' · 图片投递(先图后文)' : ''}</div>
        ${greeting === null
          ? '<div class="jh-empty"><span class="jh-spin" style="border-color:#99e5dc;border-top-color:#0d9488"></span> AI 正在生成定制打招呼文案…</div>'
          : `<textarea class="jh-textarea" id="jh-greeting">${greeting}</textarea>
             <div class="jh-charcount" id="jh-charcount">${greeting.replace(/\n/g, '').length}/200</div>`}
        ${countdownHtml}
        <div class="jh-confirm-actions">
          <button class="jh-btn jh-btn-ghost" id="jh-c-skip">${autoMode ? '跳过此岗' : '跳过此岗'}</button>
          <button class="jh-btn jh-btn-danger" id="jh-c-stop">停止投递</button>
          ${canSend ? `<button class="jh-btn jh-btn-primary" id="jh-c-send">${sendLabel}</button>` : ''}
        </div>
      </div>`;
    this.el.appendChild(mask);

    if (canSend) {
      const ta = mask.querySelector('#jh-greeting');
      const cnt = mask.querySelector('#jh-charcount');
      ta.addEventListener('input', () => {
        const len = ta.value.replace(/\n/g, '').length; // 换行不计入字数
        cnt.textContent = `${len}/200`;
        cnt.classList.toggle('jh-over', len > 200);
        if (autoMode) this.startCountdown(job, ta); // 用户改了文案就重置倒计时，给足时间
      });
      mask.querySelector('#jh-c-send').addEventListener('click', () => {
        if (autoMode) this.clearAutoTimer();
        this.executeDeliver(job, ta.value.trim());
      });
      if (autoMode) this.startCountdown(job, ta);
    }

    mask.querySelector('#jh-c-skip').addEventListener('click', async (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的全局收起监听（移除小窗后 e.target 已脱离 DOM，会被误判为"点面板外"）
      if (autoMode) this.clearAutoTimer();
      await JH.appendLog({ jobId: job.id, title: job.title, company: job.company, result: 'skip', reason: '用户跳过' });
      this.deliverQueue.shift();
      this.removeConfirmCard();
      await this.nextDeliverConfirm();
    });
    mask.querySelector('#jh-c-stop').addEventListener('click', (e) => {
      e.stopPropagation(); // 阻止冒泡到 document 的全局收起监听（移除小窗后 e.target 已脱离 DOM，会被误判为"点面板外"导致面板误收起）
      if (autoMode) this.clearAutoTimer();
      this._pendingGreeting = null;
      this._pendingGreetingJobId = null;
      this.deliverQueue = [];
      this.delivering = false;
      this.removeConfirmCard();
      this.status('已停止自动投递', 'info');
    });
  },

  /** 自动模式：生成文案后倒数 N 秒（随机）再自动发送，给用户留出终止窗口，也制造拟人「思考」间隔 */
  startCountdown(job, ta) {
    this.clearAutoTimer();
    const el = this.el.querySelector('#jh-countdown');
    if (!el) return;
    const total = JH.rand(5, 10);
    let left = total;
    el.textContent = `${left} 秒后自动发送（可编辑 / 跳过 / 停止）`;
    this._autoTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        this.clearAutoTimer();
        this.executeDeliver(job, ta.value.trim());
        return;
      }
      if (el) el.textContent = `${left} 秒后自动发送（可编辑 / 跳过 / 停止）`;
    }, 1000);
  },

  clearAutoTimer() {
    if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
  },

  get autoLoop() {
    const cb = this.el && this.el.querySelector('#jh-auto-loop');
    return !!(cb && cb.checked);
  },

  removeConfirmCard() {
    this.clearAutoTimer();
    const old = document.getElementById('jh-confirm');
    if (old) old.remove();
  },

  /** 执行单个岗位投递 */
  async executeDeliver(job, greeting) {
    greeting = (greeting || '').trim();
    if (!greeting) {
      // 自动模式：文案为空（如被清空）视为跳过，避免卡死队列
      if (this.autoLoop) {
        await JH.appendLog({ jobId: job.id, title: job.title, company: job.company, result: 'skip', reason: '自动模式文案为空，已跳过' });
        this.deliverQueue.shift();
        const { jobs = [] } = await JH.get(['jobs']);
        this.renderJobs(jobs);
        await this.nextDeliverConfirm();
        return;
      }
      this.status('文案不能为空', 'warn');
      this.showConfirmCard(job, this._lastGreeting || '', false);
      return;
    }
    if (greeting.replace(/\n/g, '').length > 200) return this.status('文案超过200字，请精简', 'warn');

    this.removeConfirmCard();
    const modeDesc = this.imageMode ? '先注入并发送简历图、再打入并发送打招呼文案' : '在输入框打入并发送文案';
    this.status(`<span class="jh-spin" style="border-color:#a5d8ff;border-top-color:#0369a1"></span>正在投递「${job.title}」：受信任点击「立即沟通」建会话（按钮变「继续沟通」）→ 进会话页 ${modeDesc}（详情页会短暂切到前台，稍后自动归还焦点）…`, 'info', 0);

    const resp = await JH.send({ type: 'DELIVER_ONE', job, greeting, image: this.imageMode });

    const { jobs = [], deliveredIds = {} } = await JH.get(['jobs', 'deliveredIds']);
    const idx = jobs.findIndex((j) => j.id === job.id);

    if (resp && resp.ok) {
      // 打招呼文案已成功发送即视为投递完成（简历图功能暂不可用，发过文案即完成）
      if (idx >= 0) {
        jobs[idx].status = 'delivered';
        if (resp.imageSent) jobs[idx].imageSent = true;
        delete jobs[idx].pending;
        delete jobs[idx].greeting;
        delete jobs[idx].resendTries;
      }
      deliveredIds[job.id] = Date.now();
      await JH.set({ jobs, deliveredIds });
      await JH.incDailyCount();
      await JH.appendLog({
        jobId: job.id, title: job.title, company: job.company,
        result: 'success',
        reason: resp.imageNote ? `打招呼文案已发送（${resp.imageNote}）` : '打招呼文案已发送'
      });
      this.status(`「${job.title}」投递成功 ✓`, 'ok');
    } else if (resp && resp.skip) {
      await JH.appendLog({ jobId: job.id, title: job.title, company: job.company, result: 'skip', reason: resp.reason });
      deliveredIds[job.id] = Date.now();
      await JH.set({ deliveredIds });
      this.status(`「${job.title}」已跳过：${resp.reason}`, 'warn');
    } else {
      if (resp && resp.stage === 'risk') {
        // 风控熔断：终止整个队列
        this.deliverQueue = [];
        this.delivering = false;
        await JH.appendLog({ jobId: job.id, title: job.title, company: job.company, result: 'fail', reason: '触发安全验证，已熔断' });
        this.renderJobs(jobs);
        return this.status('⚠️ 检测到安全验证，投递已全部熔断停止！请手动打开BOSS完成验证，今天建议不要再自动投递', 'error', 0);
      }
      // 任何非 ok/非 skip 的结果（含底层定位失败、发送失败）都如实记为失败，绝不假装成功
      if (idx >= 0) jobs[idx].status = 'failed';
      await JH.set({ jobs });
      await JH.appendLog({ jobId: job.id, title: job.title, company: job.company, result: 'fail', reason: (resp && (resp.reason || resp.error)) || '未知错误' });
      this.status(`「${job.title}」投递失败：${(resp && (resp.reason || resp.error)) || '未知错误'}`, 'error', 8000);
    }

    this.renderJobs(jobs);
    this.deliverQueue.shift();

    // 岗位间节奏（规避风控）：手动模式 10~20s；自动模式更短且「打散」而非匀速，
    // 并保留「每若干岗来一次长休息」的拟人行为——但触发点随机化，去掉「正好每 5 个」的机器特征。
    if (this.deliverQueue.length) {
      if (this.autoLoop) {
        this._autoCount = (this._autoCount || 0) + 1;
        // —— 提速(零风险)：间隔期间预生成下一个岗位的文案，把 API 延迟藏进等待里 ——
        const nextJob = this.deliverQueue[0];
        const { resume: _r = {} } = await JH.get(['resume']);
        this._pendingGreeting = JH.send({ type: 'GEN_GREETING', job: nextJob, resumeText: _r.text, userName: _r.name || '' });
        this._pendingGreetingJobId = nextJob.id;

        if (this._autoCount >= (this._nextRestAt || 5)) {
          // 连续投递若干个后，模拟真人歇一会儿（时长与触发点均随机）
          const gap = JH.rand(60, 150);
          this.status(`已连续自动投递 ${this._autoCount} 个，自动休息约 ${Math.round(gap / 60)} 分钟后继续…（可随时点「停止投递」）`, 'info', 0);
          await JH.sleep(gap * 1000);
          this._nextRestAt = this._autoCount + JH.rand(4, 7);
        } else {
          // 打散的基础间隔：主流 14~26s，偶尔分心 26~42s，偶尔手顺 10~16s（突发更像人）
          const r = Math.random();
          const gap = r < 0.6 ? JH.rand(14, 26) : r < 0.85 ? JH.rand(26, 42) : JH.rand(10, 16);
          this.status(`为保护账号，${gap} 秒后自动进入下一个岗位…`, 'info', 0);
          await JH.sleep(gap * 1000);
        }
      } else {
        const gap = JH.rand(10, 20);
        this.status(`为保护账号，${gap} 秒后进入下一个岗位…`, 'info', 0);
        await JH.sleep(gap * 1000);
      }
    }
    await this.nextDeliverConfirm();
  },

  // ==========================================================
  // 投递记录
  // ==========================================================
  async renderLogs(logs, stats) {
    const { jobs = [], deliveredIds = {}, config = {}, filteredJobs = [] } = await JH.get(['jobs', 'deliveredIds', 'config', 'filteredJobs']);

    // 今日 00:00 时间戳，用于判定「今日」新增
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    const todayStart = t0.getTime();
    const isToday = (ts) => typeof ts === 'number' && ts >= todayStart;

    // 今日速览：是否剔除「薪资已过滤」岗位，跟随用户采集配置（仅勾选了「按薪资过滤」才剔除，与采集时保持一致）
    const honorExclusion = !!(config && config.filterSalary);
    const notExcluded = (j) => !honorExclusion || !j.salaryExcluded;
    const found = jobs.filter((j) => isToday(j.collectedAtTs) && notExcluded(j)).length;
    // 已过滤：从独立存储 filteredJobs 统计（涵盖薪资/关键词/猎头/僵尸HR 全部维度），并按各开关门控，与采集配置保持一致
    const dimEnabled = (dim) => {
      switch (dim) {
        case 'salary': return !!config.filterSalary;
        case 'headhunter': return !!config.filterHeadhunter;
        case 'inactiveHR': return !!config.filterInactiveHR;
        case 'keyword': return !!(config.excludeKeywords && config.excludeKeywords.trim());
        default: return false;
      }
    };
    const filtered = filteredJobs.filter((f) => isToday(f.filteredAtTs) && f.reasons.some((d) => dimEnabled(d))).length;
    const match = jobs.filter((j) => isToday(j.analyzedAtTs) && typeof j.score === 'number' && j.score >= 60 && notExcluded(j)).length;
    const deliveredToday = Object.keys(deliveredIds).filter((id) => isToday(deliveredIds[id])).length;

    // 进度概览（环形图：累计投递 / 总岗位）
    const totalDelivered = Object.keys(deliveredIds).length;
    const totalJobs = jobs.length;

    this.el.querySelector('#jh-t-found').textContent = found;
    this.el.querySelector('#jh-t-filtered').textContent = filtered;
    this.el.querySelector('#jh-t-match').textContent = match;
    this.el.querySelector('#jh-t-delivered').textContent = deliveredToday;

    const C = 2 * Math.PI * 52; // 环形周长（r=52）
    const ratio = totalJobs > 0 ? Math.min(1, totalDelivered / totalJobs) : 0;
    const fg = this.el.querySelector('#jh-ring-fg');
    fg.style.strokeDasharray = C;
    fg.style.strokeDashoffset = C * (1 - ratio);
    this.el.querySelector('#jh-ring-num').textContent = totalDelivered;

    // 投递明细（保留）
    const list = this.el.querySelector('#jh-loglist');
    if (!logs.length) {
      list.innerHTML = '<div class="jh-empty">暂无投递记录</div>';
      return;
    }
    list.innerHTML = logs.slice(0, 100).map((l) => `
      <div class="jh-log jh-log-${l.result}">
        <div class="jh-log-title">${l.title}｜${l.company}</div>
        <div class="jh-log-sub">${l.time} · ${l.result === 'success' ? '成功' : l.result === 'skip' ? '跳过' : '失败'}${l.reason ? ' · ' + l.reason : ''}</div>
      </div>`).join('');
  },

  async refreshLogsTab() {
    const { logs = [], stats = {} } = await JH.get(['logs', 'stats']);
    await this.renderLogs(logs, stats);
  }
};
