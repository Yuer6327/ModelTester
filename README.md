<img width="1710" height="1082" alt="" src="https://github.com/user-attachments/assets/ef968872-f49b-4183-9b20-9e9fe6846466" />


# ModelTester · dsh 模型检测面板

[![npm version](https://img.shields.io/npm/v/dsh-modeltester)](https://www.npmjs.com/package/dsh-modeltester) [![dsh-std Community v0.15](https://img.shields.io/badge/dsh--std-Community%20v0.15-6a4cff)](https://github.com/Yuer6327/ModelTester/blob/main/dsh-plugin.json) [![Awesome dsh-plugin](https://camo.githubusercontent.com/d49867731e8dae50cfe6c3e25a3ef1d845d4e55aace9b1da5a31d47162f8e683/68747470733a2f2f617765736f6d652d6473682d706c7567696e2e636f6d2f62616467652e737667)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

ModelTester 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）网页端插件：在会话页右上角挂载一块**模型检测面板**，回答一个问题——

1. **当前会话像哪家模型？**（归属分析：18 家厂商候选 + 完整证据账本）

一切判定都是本地、无模型、零网络的**结构指纹匹配**，且每一条结论都附带可展开的证据与上下文样本。面板回答「像谁」，不回答「是谁」。

> **前身**：[NoLetMe](https://github.com/Yuer6327/NoLetMe) v0.3.9，2026-09-25 品牌重构为独立新项目（npm `dsh-modeltester`，插件 id `io.github.yuer6327.modeltester`，版本自 `0.0.1-alpha.1` 起算）。

## 功能总览

| 层 | 回答的问题 | 实现 |
|---|---|---|
| **归属分析**（主视图） | 这个会话**像哪家**？ | 18 家厂商候选评分排名 + 证据账本（[`src/client/attribution.ts`](src/client/attribution.ts)） |
| **模板 / 分词器指纹** | 服务栈的模板与词表是哪家的？ | 各家官方 tokenizer_config 特殊 token 的 tier-1 泄漏行（[`src/client/tokenizers.ts`](src/client/tokenizers.ts)） |
| **脏 token 与泄漏物** | 底层漏出了什么工件？ | 社区证实清单 + 通用异常探测器：未收录泄漏自动入账本，供一行入表 |
| **0813 轨迹指纹** | 后训练风格像哪条轨迹？ | `We need` / `Let me` / `The user wants` 词法（支持性证据，[`src/client/keywords.ts`](src/client/keywords.ts)） |
| **探针包 + 批量测试** | 怎么主动取证？ | 11 个探针（工具格式诱发 / 模板识别 / glitch 电池 / 回声 / 字母计数 / 知识截止 / 拒答形状 / 上下文自述 / 自然任务 / 身份格网 / 系统提示词提取），按置信度排序；**复选框多选 + 预计 token 数 + 一键批量测试**（新开会话逐条发送等回复），跑完给出**猜测 + 置信度**（[`src/client/batch.ts`](src/client/batch.ts)）；旧宿主回退为逐条发送/复制 |
| **fertility 指纹**（仓库工具） | 分词器**定量**是哪家？ | usage 差分 + 官方 tokenizer 本地比对；drill 另含词表规模指纹、特殊 token 注入、目录泄露、错误包络、上下文天花板、同网关 A/B 与跨层综合判定（`fingerprint-drill.mjs --batch`） |

面板实时增量折叠流式输出、自动回填完整历史（≤30 页）、按会话本地持久化；不发送任何数据，不改动、不补丁宿主任何既有 UI。

## 归属分析（主视图）

**判定规则**：扫描全部已加载推理文本（探针哨兵顺带扫可见回复），把命中的结构指纹按权重累到厂商候选上；候选达到「匹配」需要至少一条 **tier-1** 证据且明显领先第二名，仅 tier-2/3 证据封顶「疑似」，只有无厂商证据时显示「未匹配」并列出泄漏物。证据账本按信号去重（≤40 条），每条带首现轮次与 ±40 字上下文样本。

证据表（`ATTRIBUTION_VERSION = 5`，[`src/client/attribution-signals.ts`](src/client/attribution-signals.ts)）分层：

| 层 | 证据 | 厂商 | 权重 |
|---|---|---|---:|
| 1 · 基础设施泄漏 | `antml` 命名空间（工具调用 XML 漏进推理） | Anthropic 系 | 6 |
| 1 · 模板泄漏 | 各家对话模板特殊 token（取自**最新代**官方 `tokenizer_config.json`：DeepSeek-V4.1-Flash、Qwen3-2507、GLM-4.6、Kimi-K3、MiniMax-M3、Llama-4、Mistral-Small-3.2、Gemma-3、Ling-1T）：MiniMax `<mm:think>` 与 `]<]image[>[` 括号融合族、Kimi `<|end_of_msg|>`/`<osagent_mode>`、GLM `<|observation|>`/`<arg_key>`/`/nothink`、DeepSeek 全角 `<｜Assistant｜>`、Llama-4 `<|header_start|>`/`<|eot|>`、Mistral `[TOOL_CALLS]`、ChatML `<|im_start|>` 系、Gemma `<start_of_turn>`、Ling `<|role_end|>` | 对应厂商 | 2–6 |
| 1 | `fp_v4pro_…` 部署串（社区观测于灰测会话） | DeepSeek 系 | 5 |
| 1 | 其他 `fp_…` 串（OpenAI 风格 API 指纹） | OpenAI 系 | 4 |
| 2 · 轨迹词汇 | 0813 Minimal（`we need`/`let's` 且零 `let me`）与 Standard（`let me` 沉重）指纹 | DeepSeek 系 | 1（支持性） |
| 2 · 已证实脏 token | `EDMFunc`、`everydaycalculation`、`Nameeee`（厂商未定） | 未归属 | — |
| 2 · 异常探测器 | 未收录 XML 标签、长十六进制串、`EDMFunc` 样后端标识、退化重复 | 未归属 | — |
| 3 · 风格轶事/探针 | `delve` 词癖、破折号密度、glitch 金丝雀（r50k/cl100k 分族，见下）、探针哨兵回声 | 弱支持 | 1 |

glitch 金丝雀清单取自公开研究：[SolidGoldMagikarp（LessWrong）](https://www.lesswrong.com/posts/aPeJE8bSo6rAFoLqg/solidgoldmagikarp-plus-prompt-generation)、[arXiv:2404.09894](https://arxiv.org/abs/2404.09894) 与 [garak 扫描器公开表](https://github.com/NVIDIA/garak/blob/main/garak/probes/glitch.py)。

- **模板泄漏行只扫推理**：探针**回答里引用**特殊 token 不触发归属，避免自产假阳性；模板识别探针仅供人工判读（末行假 token 是对照组）。
- **异常探测器**抓的是表里还没有的泄漏物：命中进「未归属」账本，可直接抄给社区、一行入表（`ATTRIBUTION_VERSION` 随之递增）。
- **证据账本**完整列出全部命中信号（层级着色、附上下文样本）；**证据包导出**一键复制 JSON（候选、证据、会话 id），纯本地。

### 实测案例：opencode-zen `space-bunny-free` = MiniMax-M3

OpenCode Zen 的官方隐身模型（限时免费、零保留提供商），社区猜测为 MiniMax 新模型。用本插件的探针包直连 API 采集三轮输出跑面板同款代码路径：轨迹指纹全中（`We need` 电报体，efficient 18 / `let me` 0）但按行业级风格降权处理；无任何 tier-1 泄漏、glitch 逐字复读、字母计数答对 22——被动面诚实输出「未匹配」。**最终由 fertility 指纹定量定案**（见下）：五维 usage 差分向量与 MiniMax-M3 官方 tokenizer **精确一致（L1=0）**，其余 8 家全部偏离（llama 4、deepseek-v4 14、glm 16、ling/qwen 32、gemma 40、mistral 51）。

### Fertility 指纹工具链（drill 模式，直连 API）

被动面板拿不到 usage 字段，仓库根另附一套直连 API 的定量工具：

1. [`fingerprint-texts.json`](fingerprint-texts.json) —— 固定探针文本组 T0–T5（英文/中文/代码/多语言 emoji/数字 URL，最大化分词器分歧）；
2. [`fingerprint-drill.mjs`](fingerprint-drill.mjs) —— 七个探针小节，按 flag 选择：`--usage` 逐条发送并记录 `usage.prompt_tokens`，网关模板开销恒定，**相邻差分剔除模板、隔离分词器本身**（探针文本 T0–T9：英/中/代码/多语言 emoji/ZWJ 旗标/泰韩俄/缩进/密度）；`--logprobs` 词表规模指纹（echo 分词向量 + 欠训练 token 概率画像 + 观测 max token id 对照词表参照表，近邻永远输出候选**对**）；`--inject` 特殊 token 注入电池（家族停止符截断探测，假 token / 截断形态 / 400 拒绝 / 推理预算耗尽四类对照）；`--models` 目录泄露扫描；`--errors` 错误包络（服务栈指纹）；`--context` 上下文天花板阶梯；`--sibling <model>` 同网关目录 A/B（usage 差分 L1 比对）。`--batch`（或 `--all`）跑全套并给出**跨层综合猜测 + 置信度**（分层原则：tokenizer 层 vs 基础设施层独立计票）。快照落盘 `.attr-corpus/fingerprints/`，跨期对比即模型替换审计。运行：`OPENCODE_ZEN_API_KEY=… node fingerprint-drill.mjs <model> [baseURL] [--batch] [--sibling <model>]…`；
3. [`fingerprint-reference.py`](fingerprint-reference.py) —— 用各家官方 `tokenizer.json`（python [tokenizers](https://pypi.org/project/tokenizers/) 库，参考文件在 `.attr-corpus/tokenizers-json/`）本地算同一组文本的差分向量并排名比对；
4. [`verify-fingerprint-drill.mjs`](verify-fingerprint-drill.mjs) —— 离线回归：本地 mock OpenAI 兼容服务器验证全部小节的快照输出（含批量综合判定）；[`verify-batch.mjs`](verify-batch.mjs) 验证面板批量评分纯函数（无网络、无凭据，均已在 `pnpm test` 链内）。

闭源/无公开 tokenizer 的厂商按层覆盖：Anthropic 由 antml 工件行、OpenAI 由 `fp_…` 行与 glitch 电池、xAI 与 NVIDIA（Nemotron 特殊 token 全是占位符）由目录泄露、词表规模簇与行为层覆盖。特征集与参照库均已刷新至各家族最新一代（2026-09-26 经代理自 HuggingFace 官方仓库重采，旧代文件移除）。

## 0813 轨迹指纹

面板的「轨迹特征」区保留为归属评分的支持性证据：统计推理块中 `We need…` / `Let's…`（🟢 高效）、`Let me…` / `I think…`（🟠 犹豫）、`The user wants…`（⚪ 中性）的出现频次，依据 [xiaobright/modeltest](https://github.com/xiaobright/modeltest) 对 DeepSeek V4 Pro GA「0813」后训练过拟合事件的公开调研。词频只反映推理**风格**，不能判定后端或 checkpoint——因此在归属评分中仅作支持性证据（权重 1）。完整证据链见 [`docs/research.md`](docs/research.md)。

## 安装

**前置条件**：dsh CLI ≥ **0.1.0-rc.7**，已建好目标 profile。本插件按 dsh **0.1.x** 客户端契约构建（rc.7 至 0.1.7 全线），逐版本精确兼容声明以 [`package.json`](package.json) 的 `dsh.compatibility.dshReleases` 矩阵为准。

**方式一 · npm 安装（推荐）** —— 预构建，无需 `allowBuilds` 审批

```sh
dsh plugin --profile demo add dsh-modeltester
```

**方式二 · 从 GitHub 安装**（`prepare` 脚本安装时自动构建 `lib/`）

```sh
dsh plugin --profile demo add github:Yuer6327/ModelTester
```

> pnpm ≥ 10 默认拦截 git 依赖的 `prepare` 脚本：把 `dsh-modeltester: true` 写入该 profile 的 `pnpm-workspace.yaml` 后重新 `add`。

**方式三 · 本地目录安装**

```sh
cd /path/to/this/repo/..
dsh plugin --profile demo add ./ModelTester
dsh web --profile demo
```

**本地开发**：

```sh
pnpm install && pnpm build
dsh web --patch '…/ModelTester/cordis.patch.yml'
```

> `cordis.patch.yml` 的行名是包名 `dsh-modeltester`；Windows 下行名写绝对路径会被 ESM loader 拒绝（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。

标准宿主（[dsh-std](https://github.com/Yan-Zero/dsh-std) Community v0.15）可先装 `@dsh-std/adapter-dsh` 再装本包——`dsh-plugin.json` 提供安装前兼容判定；面板本身仍走原生 `dsh.client`（v0.15 尚无 `shell.overlay` 对应 surface）。

## 构建

```sh
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # 计数引擎 + 归属引擎 + dsh-std 清单契约
pnpm compat       # dsh 0.1.x 平台种子契约
pnpm build        # tsdown → lib/index.js + lib/std/host.js + lib/client.js
pnpm dsh-releases check   # DSH STORE 滚动窗口 vs dshReleases 矩阵
```

发布：push 到 main 即 CI 验证并自动 `pnpm publish`（幂等——版本已在 npm 则跳过；`NPM_TOKEN` secret 未配置时发布步骤自动跳过）。

## 架构

```
src/
├── index.ts            # Node（宿主）半边 —— 空操作，满足 Loader
├── std/host.ts         # dsh-std Community v0.15 FacetModule
└── client/
    ├── apply.ts        # shell.overlay 注册 + 统计 store
    ├── slots.ts        # inject-face 契约
    ├── conversation.ts # 宿主快照结构子集（跨 0.1.x 版本）
    ├── session-source.ts / session-store.ts / accumulator.ts
    ├── stats.ts        # 计数引擎（0813 轨迹词汇 + 风格统计）
    ├── keywords.ts     # 0813 关键词表
    ├── attribution.ts / attribution-signals.ts  # 归属引擎 + 证据→厂商表
    ├── tokenizers.ts   # 各家官方 tokenizer 特征集（最新代）
    ├── probes.ts       # 探针包目录
    ├── ModelTesterPanel.tsx / .module.css
    └── locales.ts      # zh + en 词典
```

仓库根另有开发工具：`verify-*.mjs`（契约/校准/冒烟）、`fingerprint-*.json/.mjs/.py`（fertility 指纹 drill）。

## 兼容性

- dsh `>=0.1.0-rc.7 <0.2.0`；客户端依赖仅用于构建与类型检查（精确锁 0.1.7-rc.2），不进运行时产物——跨版本兼容由结构读取保证。
- 兼容性证据工具：`pnpm dsh-releases check` / `pnpm dsh-releases probe <版本>…`（静态发行物比对：平台种子表、`shell.overlay`、`chat.legacy` 切片、`SessionFace`）。
- 本插件不声明任何 dsh `peerDependencies`，0.1.7 的 `evaluatePluginCompatibility()` 版本闸门因此不生效（兼容性来自结构读取，而非版本区间）。

## 诚实边界

- **结构指纹 ≠ 模型身份**。归属排名回答「像谁」，不回答「是谁」：`antml` 这类工件可能来自**脚手架**而非底座模型；轨迹词汇是行业级后训练风格（2026-09-25 实测：社区猜测为 MiniMax 的隐身模型与 DeepSeek 0813 呈同一 `We need` 风格，故该行降为支持性）；风格标记是社区轶事级证据，checkpoint 漂移会改变风格。
- 面板所有数字（I'm doing、列表密度、p50、TTR、TTFT）始终与结论并列显示，判断留给用户；数据不离开浏览器（fertility drill 为仓库级开发工具，独立于面板运行）。

## 许可证

[MIT](LICENSE)
