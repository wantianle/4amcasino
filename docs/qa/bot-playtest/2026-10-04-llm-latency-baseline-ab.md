# LLM 延迟/超时基线 + A/B 测量报告

- 日期：2026-10-04
- 分支：`feat/room-bots`（HEAD `47a17a6`）
- 模型：`deepseek-flash`；网关：`https://sub2api.minieye.tech/v1`
- 默认配置：`LLM_TIMEOUT_MS=12000`、`LLM_MAX_OUTPUT_TOKENS=2048`、`LLM_MIN_BUDGET_MS=6000`；harness 动作时钟 30s、每手动作预算 `HAND_MS=600000`
- 测量命令（每组）：`. ./.botenv && HANDS=NN STYLES=llm,llm node --import tsx apps/server/test/botPlaytest.mjs`
- 说明：本报告所有数字均为真实运行结果；其中「基线」为两批独立运行的累加（`hands16` 78 次 + `hands20` 95 次 = 173 次），provider 波动已分别列出。逐请求数据由本次新增的 opt-in 接缝 `LLM_PER_REQUEST_FILE` 导出（见文末「测量接缝」）。

> 结论先行：**延迟由 completion（推理）token 数主导，而非 prompt**。当前 12s 超时率 ~25%（波动 20%–32%），根因是模型未在 12s 内生成长度可变的 hidden reasoning + tool call。精简 prompt、降低 `maxOutputTokens`、`enable_thinking:false`、换模型都**不能**在不牺牲「模型实际执行率」的前提下消除超时；真正杠杆只在提供商侧对 reasoning 长度的控制。

## 1. 基线分布（`maxOutputTokens=2048`，合并 n=173）

| 指标 | 值 |
| --- | --- |
| 请求总数 | 173 |
| `outcome=ok` | 129 |
| `outcome=timeout` | 44 |
| **timeoutRate** | **0.254**（批次1 25/78=0.321，批次2 19/95=0.200） |
| `parse` fallback | 4（0.023） |
| `deadlineSkips` | 0 |
| 每请求 latency（successful-only）min/p50/p95/p99/max | 2285 / 6511 / 11447 / 11908 / 11967 ms |
| 每请求 latency（timeout-only，**在 12s 处截断/censored**）min/p50/p95/p99/max | 11999 / 12001 / 12001 / 12003 / 12003 ms |
| prompt tokens（ok）mean/p50/p95/max | 1253 / 1258 / 1352 / 1405 |
| completion tokens（ok）mean/p50/p95/p99/max | 739 / 693 / 1426 / 1543 / 2048 |
| finishReason 分布 | `tool_calls` 127，`stop` 2 |

- `deadlineSkips=0`：本组动作时钟 30s，`remainingMs` 始终 ≥ `minModelBudgetMs`，故没有主动降级；所有超时都来自「请求已发出、12s 内未完成」。
- timeout-only 的 p50/p95/max 全在 12001±2ms，是配置上限的**截断值**，不是 provider 真实尾延迟（真实值未知，≥12s）。

### 成功请求延迟 vs prompt 长度

| 对比 | 相关系数 (Pearson) |
| --- | --- |
| latency ↔ completion tokens | **0.969** |
| latency ↔ prompt tokens | 0.395 |

按成功样本的 prompt tokens 三等分：

| prompt tokens 区间 | n | latency p50 | latency p95 | completion mean |
| --- | --- | --- | --- | --- |
| 1100–1224 | 43 | 5008 ms | 9375 ms | 547 |
| 1226–1288 | 43 | 6762 ms | 11011 ms | 735 |
| 1290–1405 | 43 | 8082 ms | 11745 ms | 936 |

- prompt 与延迟的弱正相关是**伪相关**：prompt 越长（多街 action history）通常对应越晚的街、模型推理也越长；控制 completion 后 prompt 本身影响很小。prompt 全程仅 1100–1405 tokens，变化幅度不足以解释 12s 尾。
- **timeout 不集中在长 prompt**：timeout 请求没有 usage（body 未返回），无法直接比较其 prompt；但成功样本证明主导变量是 completion。按 tag（`bot#1:llm` timeout 21/83，`bot#2:llm` timeout 23/90）无座位偏向。
- **特定 street 未捕获**：harness 的 LLM metric 事件不含 street，本次无法按街分解（如实说明，未做假设）。若需此项，可在 metric 里补 street。

## 2. A/B 试验

### (a) `maxOutputTokens` 2048 / 1024 / 512（各 83–173 请求）

| 组 | n | timeoutRate | success p50 | success p95 | success p99 | parse 率 | 模型执行率* | completion mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2048（基线） | 173 | 0.254 | 6511 ms | 11447 ms | 11908 ms | 0.023 | 125/173 = 72.3% | 739 |
| 1024 | 83 | **0** | 6002 ms | 9722 ms | 10514 ms | **0.229** | 64/83 = 77.1% | 634（p95 打满 1024） |
| 512 | 101 | **0** | 4822 ms | 5569 ms | 5813 ms | **0.634** | 37/101 = **36.6%** | 461（p95 打满 512） |

\* 模型执行率 = 服务端接受的、来源为模型的动作 / 请求数（`modelAccepted / calls`）。

- 降低 cap **确实消灭了 timeout**（请求在 12s 前必定结束），并显著压低尾延迟；但代价是 **tool-call 被截断**——`finishReason` 由 `tool_calls` 变成 `stop`，解析不到动作，全部走 `parse` fallback：
  - 1024：22.9% 截断，模型执行率仍 77.1%（可用但明显退化）；
  - 512：63.4% 截断，模型执行率跌到 36.6%（实质失效）。
- 即「timeout 率下降」只是把失败从 `timeout` 换成了 `parse`，并非净胜。2048 下 `completion p95=1426`、`max=2048`，说明部分请求本身就会顶到 2048，cap 越小截断越多。

### (b) 关闭/降低 reasoning

先用直连探测确认网关是否接受参数（**同一请求结构**：system prompt + tool + `tool_choice:"required"`；`max_tokens=2048`，n=8 交错）：

| 参数 | HTTP | reasoning_tokens p50 | completion p50 | ms p50 | ms p95 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 无（base） | 200 | 107 | 193 | 2139 | 5120 | 对照 |
| `reasoning_effort:"none"/"low"/"minimal"` | **400** | — | — | — | — | **网关拒绝**（`json: unknown field "summary"`） |
| `reasoning:{effort:"none"}` | 200 | 136 | 226 | 2457 | — | 200 但 reasoning 未降 → **被静默忽略** |
| `enable_thinking:false` | 200 | **38** | **127** | **1965** | **3067** | 被接受，reasoning/尾延迟方向性下降（方差大） |
| `chat_template_kwargs.enable_thinking:false` | 200 | 80 | 170 | 2151 | — | 部分生效（中间值） |

真实 bot 场景验证 `enable_thinking:false`（harness 经 `LLM_EXTRA_BODY` 透传，`maxOutputTokens` 保持 2048）：

| 组 | n | timeoutRate | success p50 | success p95 | success p99 | parse 率 | completion mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2048 基线 | 173 | 0.254 | 6511 | 11447 | 11908 | 0.023 | 739 |
| 2048 + `enable_thinking:false` | 82 | 0.207 | 6399 | 9803 | 11768 | 0 | 631 |

- `enable_thinking:false` 确实被接受并方向性削减 reasoning（completion mean 739→631，p95 11447→9803）；但 timeout 率 20.7% 仍落在基线两批（20%–32%）的波动区间内，**无法判定为显著改善**；p99 仍 11768ms，尾风险犹在。

### 换更低延迟模型（直连探测，n=6/模型，短 prompt）

| 模型 | n | 错误 | ms p50 | ms p95 | completion p50 | reasoning p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `deepseek-flash`（当前） | 6 | 0 | 3130 | 3764 | 280 | 183 |
| `deepseek-v4-flash` | 6 | 0 | 3065 | 3660 | 262 | 171 |
| `gpt-5.4-mini` | 0 | 6×HTTP 502 | — | — | — | — |

- `deepseek-v4-flash` 与当前模型延迟/推理几乎相同，无收益；`gpt-5.4-mini` 上游 502 不可用。

## 3. 建议（基于数据）

| 参数 | 建议 | 理由 | 风险 |
| --- | --- | --- | --- |
| prompt | **不精简** | prompt 仅 ~1250 tokens 且稳定，与延迟弱相关（r=0.40，含 completion 共变）；精简最多省几百 ms，无法消除 12s 尾 | 无（维持现状） |
| `LLM_MAX_OUTPUT_TOKENS` | **维持 2048** | 1024 虽 timeout=0，但 22.9% tool-call 截断（执行率 77%）；512 截断 63.4%（执行率 36.6%）。截断把 `timeout` 换成 `parse`，是失败转移而非减少 | 维持现状 |
| `LLM_TIMEOUT_MS` | **维持 12000**（可另做一次 15–20s A/B） | successful p99=11.9s 紧贴上限，说明成功样本也在边缘；提高上限可把部分 timeout 转成成功 | 每手时长/成本上升；timeout 真实延迟未知，未必够 |
| `LLM_MIN_BUDGET_MS` | **维持 6000** | 短时限主动降级（`deadline_skips`）已避免「发出必超时请求」，本组 30s 时钟下为 0 是预期 | 维持现状 |
| reasoning 控制 | **不依赖** | `reasoning_effort` 被网关 400 拒绝；`reasoning:{effort}` 被忽略；`enable_thinking:false` 仅部分生效且 timeout 未显著改善 | 若必须，需网关侧支持 |
| 模型 | **不换** | `deepseek-v4-flash` 无延迟优势；`gpt-5.4-mini` 上游 502 | 维持现状 |

**推荐参数（维持默认）**：`LLM_MAX_OUTPUT_TOKENS=2048`、`LLM_TIMEOUT_MS=12000`、`LLM_MIN_BUDGET_MS=6000`、`LLM_MODEL=deepseek-flash`。

**下一步（未在本次执行）**：
1. 若要继续降 timeout，真正杠杆是提供商侧限制 reasoning（如支持 `reasoning_effort`/thinking budget 的模型或网关），而非客户端参数。
2. 可做一次 `LLM_TIMEOUT_MS=18000` 的 A/B（≥60 请求），量化「放宽上限换成功率」的收益与每手时长代价。
3. 若能接受 1024 cap 的 23% 截断，可作为「timeout 敏感、允许降级」场景的折中，但默认不推荐。

## 4. 测量接缝（最小改动，仅测试 harness）

本次为拿到逐请求配对数据，对 `apps/server/test/botPlaytest.mjs` 加了两个 **opt-in** 接缝，**默认行为与产出完全不变**（不设 env 时不写文件、不注入字段），未改产品代码（`apps/server/src`、`packages/agent-core/src` 均未动）：

- `LLM_PER_REQUEST_FILE=<path>`：把每个请求的 `{tag, promptTokens, completionTokens, outcome, finishReason, ms, modelLegal, fallbackReason}` 与 `deadline_skip` 记录写为 JSON 数组（按 tag 串联合并，同实例请求串行，配对精确）。
- `LLM_EXTRA_BODY='{...}'`：经 policy 已有的 `fetch` 注入 seam，把 JSON 合并进请求 body，用于 A/B provider 侧参数；harness 报告 `config.llm.extraBody` 会记录它。

产品默认路径、报告格式、断言均未改变。

## 5. 保留的报告文件

| 文件 | 组 | 请求数 |
| --- | --- | --- |
| `2026-10-04T09-06-31-090Z-seed1234-hands20.md/.json` | 基线（批次2） | 95 |
| `2026-10-04T09-18-14-565Z-seed1234-hands16.md/.json` | `maxOutputTokens=1024` | 83 |
| `2026-10-04T09-26-53-155Z-seed1234-hands16.md/.json` | `maxOutputTokens=512` | 101 |

- 基线批次1（`hands16`，78 次）的原始报告未单独保留，其数字已并入本报告「合并 n=173」；如需原始逐请求数据可重跑 `HANDS=16`。
- `enable_thinking:false` 组（82 次）与模型/参数探测为一次性测量，原始文件未保留，数字见本报告（探测命令见文末）。
- 既有的 `2026-10-04T08-28-10-802Z-seed1234-hands12.*` 未改动。

### 复现命令

```bash
cd /home/mini/dev/4amcasino
. ./.botenv

# 基线
LLM_PER_REQUEST_FILE=/tmp/baseline.json HANDS=20 STYLES=llm,llm \
  node --import tsx apps/server/test/botPlaytest.mjs

# (a) maxOutputTokens
LLM_PER_REQUEST_FILE=/tmp/1024.json LLM_MAX_OUTPUT_TOKENS=1024 HANDS=16 STYLES=llm,llm \
  node --import tsx apps/server/test/botPlaytest.mjs
LLM_PER_REQUEST_FILE=/tmp/512.json LLM_MAX_OUTPUT_TOKENS=512 HANDS=16 STYLES=llm,llm \
  node --import tsx apps/server/test/botPlaytest.mjs

# (b) reasoning 关闭（harness 透传）
LLM_PER_REQUEST_FILE=/tmp/think.json LLM_EXTRA_BODY='{"enable_thinking":false}' HANDS=16 STYLES=llm,llm \
  node --import tsx apps/server/test/botPlaytest.mjs
```
