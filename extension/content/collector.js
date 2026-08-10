// ============================================================
// collector.js — 岗位采集引擎
// 1) 搜索列表页：模拟真人滚动，解析岗位卡片
// 2) 详情页（后台标签）：提取完整JD/HR活跃度/猎头标识后回报
// ============================================================

const JHCollector = {

  /** 构造搜索页 URL
   *  搜索页路径为 /web/geek/job（不带 s）。?query=关键词&city=城市码 才会真正触发按关键词搜索。
   *  旧写法 /web/geek/jobs（带 s）不被识别 query，会落到默认推荐页：搜索框为空、结果不相关，
   *  这正是「采集到的岗位匹配度低 / 搜索框没有关键词」的根因。 */
  buildSearchUrl(keyword, city) {
    const base = 'https://www.zhipin.com/web/geek/job';
    const params = new URLSearchParams();
    params.set('query', keyword);
    const code = this.cityCode(city);
    if (code) params.set('city', code);
    return `${base}?${params.toString()}`;
  },

  /** 城市名 → BOSS city code（表里没有则返回空串，等价于「全国」） */
  cityCode(city) {
    return JH_CITY_CODES[(city || '').trim()] || '';
  },

  /** 用于状态提示的城市显示名：未收录城市要明说会按全国搜索，避免用户以为筛选生效了 */
  cityLabel(city) {
    const c = (city || '').trim();
    if (!c) return '全国';
    return this.cityCode(c) ? c : `${c}（城市码未收录，按全国搜索）`;
  },

  /**
   * 严格判断当前页是否为「关键词搜索列表页」。
   * 【重要】绝不能用 href.includes('/web/geek/job') 来判断——推荐页
   * /web/geek/job-recommend 同样包含该片段，会被误判成搜索页，导致点「岗位采集」时
   * 跳过跳转、直接抓推荐页岗位，采集配置里的关键词与城市完全不生效。
   */
  isSearchPage() {
    const p = (location.pathname || '').replace(/\/+$/, '');
    if (!p) return false;
    if (p.includes('job_detail')) return false;        // 岗位详情页
    if (/-recommend$/.test(p)) return false;           // 推荐页 /web/geek/job-recommend
    if (p === '/web/geek/job' || p === '/web/geek/jobs') return true; // 新版搜索页（含站点可能的复数写法）
    if (/^\/c\d+/.test(p)) return true;                // 旧版城市搜索页 /c101010100/?query=..
    return false;
  },

  /** 读取当前页 URL 上的搜索条件（城市兼容旧版写在路径里的 /c<cityCode> 形式） */
  currentSearchParams() {
    const sp = new URLSearchParams(location.search);
    let city = (sp.get('city') || '').trim();
    if (!city) {
      const m = (location.pathname || '').match(/^\/c(\d+)/);
      if (m) city = m[1];
    }
    return { query: (sp.get('query') || '').trim(), city };
  },

  /**
   * 当前页是否恰好就是「按给定关键词 + 城市」搜出来的结果页。
   * 只要有一项不符（改了城市、改了关键词、或落在推荐页/详情页），就必须重新跳转搜索，
   * 否则采到的仍是上一次条件下的岗位——这正是「改了城市却没重新搜索」的根因。
   */
  searchMatches(keyword, city) {
    if (!this.isSearchPage()) return false;
    const cur = this.currentSearchParams();
    if (cur.query !== (keyword || '').trim()) return false;
    return cur.city === this.cityCode(city);
  },

  /**
   * 当前页是否恰好就是 collectNav 记录的那次跳转目标（只比对 query + city，
   * 忽略站点自行追加的 page 等参数）。
   * 用途：自动续跑采集的兜底触发必须锁定「程序刚跳过去的那个页面」，
   * 否则会退化成「任意 BOSS 页面在时间窗内刷新都自动采集」。
   */
  isNavTarget(navUrl) {
    if (!navUrl) return false;
    try {
      const u = new URL(navUrl, location.origin);
      const t = {
        query: (u.searchParams.get('query') || '').trim(),
        city: (u.searchParams.get('city') || '').trim()
      };
      const cur = this.currentSearchParams();
      return this.isSearchPage() && cur.query === t.query && cur.city === t.city;
    } catch (e) {
      return false;
    }
  },

  /**
   * 从岗位位置文本提取城市名。
   * BOSS 列表页位置多为「城市·区」或「城市 区」，取首个分隔段；若首段不是已知城市，
   * 再试末段（个别岗位写成「区·城市」）；都取不到则取首段前 3 字兜底。
   */
  extractCityFromLocation(locText) {
    const t = (locText || '').trim();
    if (!t) return '';
    const segs = t.split(/[·・・\s\-–—/]/).map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return '';
    const known = (s) => !!JH_CITY_CODES[s];
    if (known(segs[0])) return segs[0];
    if (segs.length > 1 && known(segs[segs.length - 1])) return segs[segs.length - 1];
    return segs[0].slice(0, 3);
  },

  /** 抽样当前页面岗位卡片的主流城市（取出现次数最多的城市名）；无卡片返回 '' */
  sampleRenderedCity() {
    const cards = JH.$$(JH_SELECTORS.jobCard);
    const counts = {};
    for (const card of cards) {
      const cityEl = JH.$(JH_SELECTORS.jobCardCity, card);
      const name = this.extractCityFromLocation(cityEl ? cityEl.textContent : '');
      if (name) counts[name] = (counts[name] || 0) + 1;
    }
    let best = '', max = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k] > max) { max = counts[k]; best = k; }
    }
    return best;
  },

  /**
   * 校验当前搜索页「实际渲染的城市」是否为目标城市。
   * BOSS 可能忽略 URL 的 ?city= 参数、按自身存储的城市渲染（账号定位/上次选择），
   * 导致「搜深圳却渲染上海」。故落地后抽样岗位卡片城市，不符则尝试切到目标城市。
   * @param {string} targetCityLabel 目标城市名（如「深圳」）；为空表示全国，不校验
   * @param {boolean} alreadyTried 本轮采集已尝试过切换仍失败 → 不再重试，避免跳转死循环
   * @returns {{ok:boolean, navigated:boolean}} ok=无需切或已确认匹配；navigated=已触发跳转（调用方应暂停采集、等重载后续跑）
   */
  async ensureTargetCity(targetCityLabel, alreadyTried) {
    const label = (targetCityLabel || '').trim();
    if (!label) return { ok: true, navigated: false };
    await JH.waitFor(JH_SELECTORS.jobCard, 6000); // 等卡片渲染，避免页面未加载误判“无城市”
    const rendered = this.sampleRenderedCity();
    if (rendered && rendered === label) return { ok: true, navigated: false };
    if (alreadyTried) {
      console.warn('[JobHunter] 城市切换已尝试仍不匹配，按实际渲染城市继续：', rendered, '期望', label);
      return { ok: false, navigated: false };
    }
    return this.switchCityViaSelector(label);
  },

  /**
   * 尝试把 BOSS 当前城市切到 label：
   * ① 优先操作 BOSS 城市选择器 UI（可观测）；② 失败则尝试写 BOSS 城市存储(cookie/localStorage)后全量重载。
   * 均为 best-effort，任何一步失败都不抛错，交给调用方按实际渲染城市兜底采集。
   */
  async switchCityViaSelector(label) {
    const code = this.cityCode(label);
    // ① 操作 BOSS 城市选择器
    const trigger = JH.$([
      '.geek-city', '[class*="geek-city"]',
      '.nav-city', '[class*="nav-city"]',
      '.city-select', '[class*="city-select"]',
      '.job-search-city', '[class*="city"]'
    ]);
    if (trigger) {
      trigger.click();
      await JH.randSleep(600, 1200);
    }
    const input = await JH.waitFor([
      '.city-panel input', '[class*="city"] input',
      'input[placeholder*="城市"]', 'input[placeholder*="city"]'
    ], 4000);
    if (input) {
      await JH.humanType(input, label);
      await JH.randSleep(500, 1000);
      const items = JH.$$(['.city-panel li', '.city-list li', '[class*="city-item"]', '[class*="city-list"] li', 'li[class*="city"]']);
      let target = null;
      for (const it of items) {
        const txt = (it.textContent || '').replace(/\s+/g, '').trim();
        if (txt === label || txt.includes(label)) { target = it; break; }
      }
      if (target) {
        const before = location.href;
        target.click();
        await this._waitNavigate(before, 8000);
        const ok = this.sampleRenderedCity() === label;
        return { ok, navigated: true };
      }
    }
    // ② DOM 切换失败 → 写 BOSS 城市存储后全量重载
    if (code) {
      try {
        document.cookie = `where_city=${code}; path=/; domain=.zhipin.com; max-age=86400`;
        document.cookie = `where_cityname=${encodeURIComponent(label)}; path=/; domain=.zhipin.com; max-age=86400`;
        try { localStorage.setItem('where_city', code); localStorage.setItem('where_cityname', label); } catch (e) { /* ignore */ }
        location.href = location.href; // 重载，让 BOSS 读取新城市
        await JH.randSleep(3000, 5000);
        const ok = this.sampleRenderedCity() === label;
        return { ok, navigated: true };
      } catch (e) { /* ignore */ }
    }
    return { ok: false, navigated: false };
  },

  /** 等待页面地址变化（BOSS 切城市通常改 URL 的 city 参数） */
  async _waitNavigate(beforeHref, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (location.href !== beforeHref) return true;
      await JH.sleep(400);
    }
    return false;
  },

  /** 在当前搜索列表页采集岗位卡片（模拟真人滚动）
   *  @param {function} [onFiltered] 列表级被某过滤项挡掉的岗位回调 (job, reasons[])，用于「已过滤」统计记录 */
  async collectFromListPage(config, existingIds, deliveredIds, maxCount, onFiltered, oldFiltered, currentSig) {
    const collected = [];
    let noNewRounds = 0;
    let scanned = 0;       // 本次扫描到的有效岗位卡片数
    let duplicate = 0;     // 已采集/已投递（重复）被跳过
    let filteredList = 0;  // 列表级被过滤项挡掉（关键词/猎头/基础筛选）
    const oldMap = (oldFiltered && typeof oldFiltered.get === 'function') ? oldFiltered : null;
    const sig = currentSig != null ? currentSig : '';

    for (let round = 0; round < 15 && collected.length < maxCount; round++) {
      if (JH.riskDetected()) return { risk: true, jobs: collected, scanned, duplicate, filteredList };

      const cards = JH.$$(JH_SELECTORS.jobCard);
      const before = collected.length;

      for (const card of cards) {
        if (collected.length >= maxCount) break;
        const job = this.parseCard(card);
        if (!job) continue;
        scanned++;
        if (existingIds.has(job.id) || deliveredIds[job.id]) { duplicate++; continue; }   // 已采集/已投递去重
        if (collected.some((j) => j.id === job.id)) { duplicate++; continue; }
        const reasons = this.filterReasons(job, config);
        const basicFail = !this.passBasicFilter(job, config);
        if (reasons.length || basicFail) {
          const rs = reasons.length ? reasons : ['salary'];
          // 旧过滤岗位（之前被挡且过滤配置未变）→ 计入「重复」，不重复计入「过滤」
          const prevSig = oldMap ? oldMap.get(job.id) : undefined;
          if (prevSig !== undefined && prevSig === sig) {
            duplicate++;
          } else {
            filteredList++;
            if (onFiltered) { try { await onFiltered(job, rs); } catch (e) { /* 记录被挡岗位失败不阻断采集 */ } }
          }
          continue;
        }
        collected.push(job);
        existingIds.add(job.id);
      }

      noNewRounds = collected.length === before ? noNewRounds + 1 : 0;
      if (noNewRounds >= 3) break; // 连续3轮无新增，认为到底了

      // 真人节奏滚动加载更多
      await JH.humanScroll(JH.rand(500, 900));
      await JH.randSleep(1000, 2600);
    }
    return { risk: false, jobs: collected, scanned, duplicate, filteredList };
  },

  /** 解析单个岗位卡片 */
  parseCard(card) {
    const link = JH.$(JH_SELECTORS.jobCardLink, card);
    const title = JH.$(JH_SELECTORS.jobCardTitle, card);
    if (!link || !title) return null;

    let url = link.getAttribute('href') || '';
    if (url.startsWith('/')) url = 'https://www.zhipin.com' + url;
    if (!url.includes('job_detail')) return null;

    const titleText = title.textContent.trim();
    const salaryEl = JH.$(JH_SELECTORS.jobCardSalary, card);
    const cityEl = JH.$(JH_SELECTORS.jobCardCity, card);
    const hrEl = JH.$(JH_SELECTORS.jobCardHr, card);

    // 招聘者信息原文，如"王女士·猎头顾问"或"李先生·HR"
    const hrRaw = hrEl ? hrEl.textContent.trim().replace(/\s+/g, '') : '';
    const company = this.extractCompany(card, titleText);

    // 主标识用 BOSS 加密串（每个列表项独立，刷新后可能变化，但作为本次会话内唯一 key）；
    // fp 为稳定指纹，仅用于「已投递状态同步」与「累计投递统计去重」，不作为去重 key，
    // 避免把同公司同职位同城市的不同岗位（不同 HR/不同时间发布）误判为同一岗而全部跳过。
    const m = url.match(/job_detail\/([^.]+)\.html/);
    const id = m ? m[1] : url;
    const fp = JH.stableId(company, titleText, cityEl ? cityEl.textContent.trim() : '');

    // 列表级猎头识别：① 卡片左上角"猎头"角标（最可靠） ② 招聘者头衔含猎头特征词 ③ 公司名是人力资源/人才服务类
    const hunterIcon = JH.$(JH_SELECTORS.jobCardHunterIcon, card);
    const isHeadhunter =
      !!hunterIcon ||
      JH_HUNTER_TITLE_WORDS.some((w) => hrRaw.includes(w)) ||
      JH_HEADHUNTER_WORDS.some((w) => company.includes(w));

    return {
      id,
      fp,
      url: url.split('?')[0],
      title: titleText,
      salary: this.sanitizeSalary(salaryEl ? salaryEl.textContent.trim() : ''),
      company,
      city: cityEl ? cityEl.textContent.trim() : '',
      cityName: this.extractCityFromLocation(cityEl ? cityEl.textContent.trim() : ''),
      hrName: hrRaw.split(/[·\s]/)[0] || '',
      hrTitle: hrRaw,
      jd: '', hrActive: '', isHeadhunter,
      score: null, scoreReason: '', keywords: [],
      status: 'collected',
      collectedAt: new Date().toLocaleString('zh-CN'),
      collectedAtTs: Date.now()
    };
  },

  /**
   * 薪资清洗：BOSS 部分页面用自定义加密字体渲染薪资数字，
   * 文本层拿到的是缺数字的乱码（如"-K·薪"）。没有数字的薪资一律置空，
   * 面板对空薪资不显示，避免出现乱码。
   */
  sanitizeSalary(text) {
    const t = (text || '').trim();
    if (!t) return '';
    if (!/\d/.test(t)) return '';          // 数字被字体加密吃掉了 → 置空
    if (t.length > 20) return '';          // 异常长文本 → 不是薪资
    return t;
  },

  /**
   * 公司名候选验证：防止宽泛选择器误抓岗位标题/薪资/标签堆。
   * 否决条件：空值、与岗位名相同或互相包含、像薪资、含换行的大段文本、过长过短。
   */
  isValidCompany(text, titleText) {
    if (!text) return false;
    const t = text.replace(/\s+/g, '');
    if (t.length < 2 || t.length > 30) return false;
    const titleNorm = (titleText || '').replace(/\s+/g, '');
    // 与岗位名相同 / 包含岗位名（说明抓到的是标题所在容器）
    if (titleNorm && (t === titleNorm || t.includes(titleNorm) || titleNorm.includes(t))) return false;
    // 像薪资：12-20K、15-25K·13薪、300-500元/天
    if (/^\d+[-~]\d+(K|k|千|万|元)/.test(t) || /元\/(天|时|月)/.test(t)) return false;
    // 像经验/学历标签
    if (/^(经验不限|\d+-\d+年|本科|大专|硕士|博士|学历不限|在校|应届)/.test(t)) return false;
    return true;
  },

  /**
   * 公司名提取：遍历所有候选选择器的所有命中节点，逐个验证，取第一个可信值。
   * /gongsi/ 公司主页链接排在最前（BOSS 公司名必然链向公司主页，最可靠）。
   */
  extractCompany(card, titleText) {
    for (const sel of JH_SELECTORS.jobCardCompany) {
      let els = [];
      try { els = Array.from(card.querySelectorAll(sel)); } catch (e) { continue; }
      for (const el of els) {
        // 取节点第一行文本（避免容器节点把多行内容拼在一起）
        const raw = (el.textContent || '').trim().split('\n')[0].trim();
        if (this.isValidCompany(raw, titleText)) return raw;
        // 链接节点再尝试 title 属性
        const attr = (el.getAttribute && (el.getAttribute('title') || '')).trim();
        if (attr && this.isValidCompany(attr, titleText)) return attr;
      }
    }
    return '';
  },

  /**
   * 自诊断：生成第一张岗位卡片的结构报告（绕开 BOSS 反调试导致 F12 不可用的问题）。
   * 返回文本供用户复制发给开发者，用于精准修选择器。
   */
  buildDiagnostics() {
    const lines = [];
    lines.push('=== JobHunter 选择器诊断报告 ===');
    lines.push('URL: ' + location.href.split('?')[0]);
    lines.push('抽样渲染城市: ' + (this.sampleRenderedCity() || '(无卡片)'));
    lines.push('时间: ' + new Date().toLocaleString('zh-CN'));

    // 1. 卡片选择器命中情况
    let cards = [];
    for (const sel of JH_SELECTORS.jobCard) {
      try {
        const els = document.querySelectorAll(sel);
        lines.push(`卡片选择器 "${sel}" → 命中 ${els.length} 个`);
        if (!cards.length && els.length) cards = Array.from(els);
      } catch (e) { /* skip */ }
    }
    if (!cards.length) {
      lines.push('!! 没有任何卡片选择器命中，页面结构已大改');
      return lines.join('\n');
    }

    // 2. 第一张卡片的解析结果
    const card = cards[0];
    const job = this.parseCard(card);
    lines.push('--- 第一张卡片解析结果 ---');
    lines.push(JSON.stringify({
      title: job && job.title, company: job && job.company,
      salary: job && job.salary, city: job && job.city, hrTitle: job && job.hrTitle
    }, null, 2));

    // 3. 公司名各候选选择器分别取到什么（定位误抓的关键）
    lines.push('--- 公司名候选逐一取值 ---');
    for (const sel of JH_SELECTORS.jobCardCompany) {
      try {
        const el = card.querySelector(sel);
        lines.push(`"${sel}" → ${el ? JSON.stringify((el.textContent || '').trim().slice(0, 60)) : '(未命中)'}`);
      } catch (e) { /* skip */ }
    }

    // 4. 卡片原始 HTML（去掉 base64 图片与 style，截断防超长）
    let html = card.outerHTML
      .replace(/src="data:[^"]*"/g, 'src="(base64省略)"')
      .replace(/style="[^"]*"/g, '')
      .replace(/\s{2,}/g, ' ');
    if (html.length > 6000) html = html.slice(0, 6000) + '\n…(已截断)';
    lines.push('--- 第一张卡片 HTML ---');
    lines.push(html);
    return lines.join('\n');
  },

  /**
   * 解析薪资范围为 [low, high]（单位 K）。返回 null 表示无法判断（空 / 面议 / 日薪等）。
   * 支持：15-25K、20-40K·13薪、1-2万、30K以上、25K以下。
   * - 数字被加密字体吃掉（无数字）→ null
   * - 日薪（元/天）→ null（单位不可比，不参与薪资过滤）
   * - 单端「X以上」→ [X, null]；「X以下」→ [0, X]
   */
  parseSalaryRange(text) {
    const t = (text || '').trim();
    if (!t || !/\d/.test(t)) return null;                       // 空 / 面议 / 加密乱码
    if (/元\/天|元\/日|\/天|\/日|天·/.test(t)) return null;        // 日薪岗位，单位不可比
    const nums = (t.match(/[\d]+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) return null;
    if (/万/.test(t)) {                                          // 如「1-2万」→ [10,20]K（1万=10K）
      const scaled = nums.map((n) => n * 10);
      return [scaled[0], scaled.length > 1 ? scaled[1] : scaled[0]];
    }
    const low = nums[0];
    if (/以下/.test(t)) return [0, low];                         // 「X以下」：上限为 X
    if (/以上/.test(t)) return [low, null];                      // 「X以上」：下限为 X，无上限
    const high = nums.length > 1 ? nums[1] : null;
    return [low, high];
  },

  /**
   * 判断岗位是否因薪资不符而应在列表中隐藏（仅打标记，不丢弃）。
   * 规则：岗位薪资区间与期望区间「无重叠」才隐藏（有重叠即保留）。
   * 任一端无法解析 / 未开启过滤 / 期望薪资为空 → 保留（不误杀）。
   * @returns {boolean} true=应隐藏
   */
  isSalaryExcluded(jobSalary, salaryRange, filterOn) {
    if (!filterOn) return false;
    const j = this.parseSalaryRange(jobSalary);
    if (!j) return false;                                        // 岗位薪资无法判断 → 保留
    const e = this.parseSalaryRange(salaryRange);
    if (!e) return false;                                        // 期望未设/非法 → 不过滤
    const [jLow, jHigh] = j;
    const [eLow, eHigh] = e;
    const jTop = jHigh == null ? Infinity : jHigh;               // 岗位无上限 → 不可能「太贵」
    const jBottom = jLow == null ? 0 : jLow;                     // 岗位无下限 → 不可能「太便宜」
    if (jTop < eLow) return true;                                // 岗位最高值都低于期望最低 → 太便宜
    if (jBottom > eHigh) return true;                            // 岗位最低值都高于期望最高 → 太贵
    return false;                                                // 有重叠 → 保留
  },

  /** 列表页初筛：过滤关键词命中则丢弃；开启猎头过滤时列表级即拦截 */
  passBasicFilter(job, config) {
    const excludes = (config.excludeKeywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const text = `${job.title} ${job.company}`;
    if (excludes.some((kw) => text.includes(kw))) return false;
    if (config.filterHeadhunter && job.isHeadhunter) return false;
    return true;
  },

  /** 列表级被挡维度：返回被哪种过滤挡住的维度 key 数组（空=通过）。仅判列表级可判的维度（关键词、猎头） */
  filterReasons(job, config) {
    const reasons = [];
    const excludes = (config.excludeKeywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const text = `${job.title} ${job.company}`;
    if (excludes.some((kw) => text.includes(kw))) reasons.push('keyword');
    if (config.filterHeadhunter && job.isHeadhunter) reasons.push('headhunter');
    return reasons;
  },

  /** 详情页初筛后过滤（补采后调用）：HR活跃度、猎头 */
  passDetailFilter(job, config) {
    if (config.filterInactiveHR && job.hrActive) {
      if (JH_INACTIVE_WORDS.some((w) => job.hrActive.includes(w))) return { pass: false, reason: `HR ${job.hrActive}` };
    }
    if (config.filterHeadhunter && job.isHeadhunter) {
      return { pass: false, reason: '猎头/代招岗位' };
    }
    // 过滤关键词也检查 JD 全文
    const excludes = (config.excludeKeywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const hit = excludes.find((kw) => (job.jd || '').includes(kw));
    if (hit) return { pass: false, reason: `JD命中过滤词「${hit}」` };
    return { pass: true };
  },

  // ==========================================================
  // 详情页模式：被 background 打开的后台标签页里执行
  // ==========================================================
  async runDetailExtraction(task) {
    // 进页缓冲已移除：waitFor 改为 MutationObserver 事件驱动，不受后台标签页
    // 定时器节流影响，命中即回调，远比固定 sleep 快且功能无损。

    if (JH.riskDetected()) {
      JH.send({ type: 'DETAIL_RISK', jobId: task.jobId });
      return;
    }

    const jdEl = await JH.waitFor(JH_SELECTORS.detailJdText, 8000);

    // 风控/异常兜底：JD 没等到（结构异常或风控跳转）按风控上报，避免空数据入库
    if (!jdEl) {
      JH.send({ type: 'DETAIL_RISK', jobId: task.jobId, reason: 'JD等待超时' });
      return;
    }

    // 模拟真人阅读：详情页改为「滚动一次 + 短停」（skipLastGap 省掉最后一次停顿的定时器）
    // 原 4~6 步/每步 60~140ms → 1 步；停留 600~1400ms 保留，行为特征不变、后台节流下快得多
    await JH.humanScroll(JH.rand(300, 700), { minSteps: 1, maxSteps: 1, skipLastGap: true });
    await JH.randSleep(600, 1400);

    const activeEl = JH.$(JH_SELECTORS.detailBossActive);
    const brandEl = JH.$(JH_SELECTORS.detailBrand);
    const bossEl = JH.$(JH_SELECTORS.detailBossName);
    const bossTitleEl = JH.$(JH_SELECTORS.detailBossTitle);
    const companyEl = JH.$(JH_SELECTORS.detailCompany);

    const brandText = brandEl ? brandEl.textContent : '';
    const bossTitleText = bossTitleEl ? bossTitleEl.textContent.replace(/\s+/g, '') : '';
    let companyText = companyEl ? companyEl.textContent.trim().split('\n')[0].trim() : '';
    if (!this.isValidCompany(companyText, task && task.title)) companyText = '';
    const jdText = jdEl ? jdEl.textContent.trim() : '';

    // 猎头识别（详情级，三路信号任一命中）：
    // ① 招聘者头衔含"猎头顾问"等 ② 公司名/公司简介是人力资源类 ③ JD 明说代招
    const isHeadhunter =
      JH_HUNTER_TITLE_WORDS.some((w) => bossTitleText.includes(w)) ||
      JH_HEADHUNTER_WORDS.some((w) => brandText.includes(w) || companyText.includes(w)) ||
      jdText.includes('代招');

    const data = {
      jd: jdText,
      hrActive: activeEl ? activeEl.textContent.trim() : '',
      hrNameFull: bossEl ? bossEl.textContent.trim() : '',
      isHeadhunter
    };
    // 公司名兜底：详情页取到了才回传（避免空值覆盖列表页已采到的公司名）
    if (companyText) data.company = companyText;
    // 薪资兜底：列表页薪资常被加密字体吃掉数字，详情页多为明文，取到有效值就回传
    const salaryEl = JH.$(JH_SELECTORS.detailSalary);
    const detailSalary = this.sanitizeSalary(salaryEl ? salaryEl.textContent.trim() : '');
    if (detailSalary) data.salary = detailSalary;

    JH.send({ type: 'DETAIL_RESULT', jobId: task.jobId, data });
  }
};
