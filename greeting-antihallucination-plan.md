# 路线 A：把 AI Career OS 的「防幻觉机制」移植进 JobHunter

> 目标：保留 JobHunter 现有四段式 / 195 字文案风格，只把 Career OS 的「真实性铁律 → 证据溯源 → 幻觉核查 → 定向重写 → 句级剔除」这套**后处理防幻觉链路**搬过来。
> 范围：单文件 `extension/background.js`，不改动 `content/`、`panel.js`、调用点。
> 状态：**本文件只是方案，未改动任何扩展代码。**

---

## 0. 关键前提核查（已确认，比预想省事）

| 前提 | 结论 | 证据 |
|---|---|---|
| `genGreeting` 是否已有简历文本？ | ✅ 已有 `resumeText` 参数 | `background.js:109` 签名 `genGreeting(job, resumeText, apiKey, userName)` |
| 简历来源 | ✅ 来自 `chrome.storage` 的 `resume.text` | `panel.js:779` 调 `GEN_GREETING` 时传 `resumeText: resume.text` |
| `callDeepSeek` 是否支持 JSON 模式？ | ✅ 已支持 | `background.js:48-55`，`jsonMode` → `temperature:0.2` + `response_format:{type:'json_object'}` |
| 重写步骤需要 JD 吗？ | ✅ `job.jd` / `job.keywords` 生成时已可用 | `background.js:136` 已用 `job.jd` |
| 姓名兜底 | ✅ `userName` 已传入 | `background.js:920` |

**结论：防幻觉机制的全部输入在 JobHunter 里现成就有，没有新增输入/存储缺口。** 这是纯「单文件内加函数 + 串接」的工作。

---

## 1. 改动范围与成本一览

| 维度 | 估算 |
|---|---|
| 改动文件 | 仅 `extension/background.js`（单文件） |
| 新增代码量 | +150～200 行（6 个函数 + 1 个编排函数 + 常量 + 集成点） |
| 调用点改动 | 无（`background.js:920` 不变，只在 `genGreeting` 末尾串接后处理） |
| 每次文案的 API 调用 | 原 1 次生成 → 新增最多 2 次 cheap 调用（detect + 可能 repair） |
| Token 增量 | 约 +50%～100%/文案（detect/repair 上下文较小，且走 cheap 档） |
| 时延增量 | +3～8 秒/文案（2 次往返）；可「采集后批量预生成」绕开 |
| 失败兜底 | 整条后处理包 try/catch，LLM 出错则保留原文案、不阻断投递（与 Career OS 一致） |
| 回归风险 | 低（纯追加，不动现有四段生成逻辑；最多文案被改写/截断） |

---

## 2. 新增函数清单（移植自 `AI Career OS/src/backend/webui/kernel.py`）

> 括号内为对应的 Career OS 源函数与行号，便于溯源。

### 2.1 常量（直接复制真实值）

```js
// 复制自 kernel.py:213 _COMMON_LATIN_OK（拉丁专名允许名单，命中即不判幻觉）
const JH_COMMON_LATIN_OK = new Set([
  "ai","app","b","c","b2b","b2c","kpi","okr","roi","gmv","hr","it","ip","pc","ui","ux",
  "pm","po","crm","cms","saas","seo","sem","mcn","ugc","pgc","aigc","ceo","cto","coo","vp",
  "kol","koc","dau","mau","arpu","ltv","cac","roas","cpm","cpc","ctr","cvr","sop","qa","rd",
  "boss","offer","leader","team","ok","no","yes","vs","etc","e","g","i"
]);

// 复制自 kernel.py:221 _TOOL_HINTS（最容易被 AI 顺手编上去的工具/产品名）
const JH_TOOL_HINTS = [
  "midjourney","runway","stable diffusion","sora","pika","dall","chatgpt","gpt","claude",
  "gemini","figma","photoshop","premiere","剪映","达芬奇","sd","comfyui","notion","airtable",
  "tableau","powerbi","sql","python","excel","飞书","钉钉","企业微信","即梦","可灵","文心",
  "通义","豆包","kimi"
];
```

### 2.2 `jhNormForMatch(text)`（← `_norm_for_match` kernel.py:229）

```js
function jhNormForMatch(s) {
  return (s || '').toLowerCase().replace(/[\s·、,，。.\-_/\\()（）]+/g, '');
}
```

### 2.3 `jhDetectUnsupported(greeting, resumeText, apiKey)`（← `_llm_unsupported` kernel.py:251，JSON 模式）

- system 用 `_DETECT_SYSTEM`（kernel.py:236 逐字照搬，专门抓中文专名/领域声称/数字冲突——这是拦「原神式编造」的核心）。
- `callDeepSeek(messages, apiKey, true)`（jsonMode），解析 `{"unsupported":[...]}`，截断前 12 条。
- 内部 try/catch，异常返回 `[]`（不阻断）。

### 2.4 `jhFindUnsupportedTerms(greeting, resumeText, apiKey)`（← `_find_unsupported_terms` kernel.py:267）

三道检测，顺序与 Career OS 一致：
1. **拉丁正则** `[A-Za-z][A-Za-z0-9+.#]{1,}` → 小写后在 `JH_COMMON_LATIN_OK` 或长度<2 则跳过；否则归一后不在简历 → 判幻觉。
2. **中文工具词表** `JH_TOOL_HINTS` → 在文案归一串里、且不在简历归一串里 → 判幻觉。
3. **LLM 核查** `jhDetectUnsupported(...)` → 补中文专名/领域声称。
- 去重保序（按 Career OS 的 seen 集合逻辑）。

### 2.5 `jhRepairGreeting(greeting, resumeText, jd, badTerms, apiKey)`（← `_repair_greeting` kernel.py:324，**需本地化改写**）

- ⚠️ **关键本地化点**：Career OS 的 `_REPAIR_SYSTEM` 写死「80~140 字」（kernel.py:319），与 JobHunter 四段式 195 字硬约束**冲突**。JobHunter 版必须改写为：
  > 「…保持第一人称、口语化；**保持四段结构、每段换行、总字数严格 ≤195，第四段必须是完整句子收尾**，不要模板腔…」
- system 用本地化后的 `_JH_REPAIR_SYSTEM`，user 含 `简历 + JD(≤800) + 原语 + 禁用词`。
- `callDeepSeek(..., true)`，temperature `0.3`，解析 `{"greeting":"..."}`；异常返回 `""`。

### 2.6 `jhStripBadSentences(greeting, badTerms)`（← `_strip_bad_sentences` kernel.py:342）

```js
function jhStripBadSentences(greeting, badTerms) {
  if (!greeting) return greeting;
  const parts = greeting.split(/(?<=[。！？!?；;])/);
  const keep = parts.filter(p => p.trim() && !badTerms.some(b => jhNormForMatch(b) in jhNormForMatch(p)));
  return keep.join('').trim() || greeting; // 兜底：删空了就退回原文
}
```

### 2.7 `jhApplySelfIntro(greeting, userName)`（← `_apply_self_intro` kernel.py:352，复用现有 `nameRule` 思路做确定性兜底）

- `userName` 为空 → 原样返回（JobHunter 此时由模型从简历提姓名，不该硬塞）。
- 已以「您好/你好，我是{name}」开头 → 原样返回。
- 否则去模型自带问候/自称前缀，强制拼成「您好，我是{name}，…」。
- （注：JobHunter 生成 prompt 里的 `nameRule` 已要求这样开头，这里只是**确定性兜底**，防止模型偶尔不听话。）

### 2.8 `jhFinalizeGreeting(greeting, resumeText, jd, userName, apiKey)`（← `_finalize_greeting` kernel.py:367，编排）

```js
async function jhFinalizeGreeting(greeting, resumeText, jd, userName, apiKey) {
  const bad = jhFindUnsupportedTerms(greeting, resumeText, apiKey); // 含 LLM 检测
  if (bad.length) {
    const fixed = await jhRepairGreeting(greeting, resumeText, jd, bad, apiKey);
    if (fixed) {
      const stillBad = jhFindUnsupportedTerms(fixed, resumeText); // 复检（可只跑启发式省成本）
      greeting = stillBad.length ? jhStripBadSentences(fixed, stillBad) : fixed;
    } else {
      greeting = jhStripBadSentences(greeting, bad); // repair 失败兜底
    }
  }
  return jhApplySelfIntro(greeting, userName);
}
```

---

## 3. 集成点（`genGreeting` 末尾，background.js:154 之后）

现有代码到 line 154 的 `truncateAtSentence` 兜底结束、line 155 `return text`。在其后、return 前插入：

```js
  // —— 防幻觉后处理（路线 A：对齐 AI Career OS 的事实校验链路）——
  try {
    text = await jhFinalizeGreeting(text, resumeText, job.jd, userName, apiKey);
    if (plainLen(text) > 200) text = truncateAtSentence(text, 198); // 终态字数兜底
  } catch (e) {
    console.warn('[JH] 防幻觉后处理失败，保留原文案', e); // 不阻断投递
  }
  return text;
```

调用点 `background.js:920` **无需改动**。

---

## 4. 必须做的本地化改写（直接抄会翻车，务必注意）

| # | 陷阱 | 处理 |
|---|---|---|
| ① | `_REPAIR_SYSTEM` 写死 80~140 字 | JobHunter 版改「保持四段 + ≤195 字 + 完整收尾」（见 2.5） |
| ② | 拉丁允许名单 | 直接复制 `JH_COMMON_LATIN_OK`，否则 "UI/HR/API" 等会被误删 |
| ③ | 中文工具词表 | 直接复制 `JH_TOOL_HINTS`；简历里写了的不会误删（靠归一匹配） |
| ④ | 句级剔除可能塌段落 | JobHunter 是四段，若某段单句含禁用词会被整段删 → 变三段；方案是**优先 repair 保结构**，strip 仅最后兜底，可接受 |
| ⑤ | 终态字数 | finalize 后若 >200 再 `truncateAtSentence` 一次（复用现有函数） |
| ⑥ | 生成侧铁律（可选增强） | Career OS 的「真实性铁律 A–E」(`_TAILORED_SYSTEM` kernel.py:192) 是**生成时**约束；JobHunter 生成 prompt 目前零真实性约束。可在 `genGreeting` 的 `sys` 里顺手加一句「只使用简历里明确写过的事实，禁止虚构工具/数字/年限」，零成本、高收益 |

---

## 5. 风险与灰度建议

- **误删风险**：简历表述与文案不完全一致时（如简历写"熟悉 Python"，文案写"Python"）靠 `jhNormForMatch` 归一匹配规避；拉丁允许名单兜底。仍建议上线后抽看 10~20 条确认无过度删改。
- **成本可控开关**：可先只开**启发式两道**（拉丁正则 + 中文词表，零额外 LLM 调用），把 LLM 检测（2.3/2.4 的第③道）做成设置项开关，默认关 → 先零成本跑一段时间看启发式够不够。
- **时延缓解**：当前 `genGreeting` 在投递/分析时按需调用；若 +3~8s 不可接受，可改为「采集完成后批量预生成并缓存到 `job.greeting`」，投递时直接取。

---

## 6. 落地前建议（可选前置）

先抽 **5~10 条 JobHunter 已发过的文案**人工核对幻觉率（工具名编造、年限放大、JD 搬运等），用数据决定这套链路值不值得上。若幻觉率本就很低，启发式两道可能就够了，连 LLM 检测都不用开。

---

### 附：Career OS 真实链路溯源（已读源码确认）
- `_TAILORED_SYSTEM` 真实性铁律 A–E：kernel.py:185-208
- `_COMMON_LATIN_OK` / `_TOOL_HINTS`：kernel.py:213-226
- `_norm_for_match`：kernel.py:229
- `_DETECT_SYSTEM`：kernel.py:236
- `_llm_unsupported` / `_find_unsupported_terms`：kernel.py:251-311
- `_REPAIR_SYSTEM` / `_repair_greeting`：kernel.py:314-339
- `_strip_bad_sentences` / `_apply_self_intro` / `_finalize_greeting`：kernel.py:342-381
