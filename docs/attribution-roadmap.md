# 厂商归属检测 — 后续计划

状态基线：2026-09-25（同日完成社区调研更新）。本文收纳已评估、暂未实施的检测手段；每项注明落点（drill = 仓库根直连 API 的开发工具，插件内 = 被动扫描或复制粘贴探针）与预期证据强度。原则不变：只记录结构性证据，宁可 unknown，不做身份断言。

## 取证分层原则（调研引入，约束所有新手段）

社区共识（见来源 [The Nameless Surplus]）：**一个观测只能识别"能产生它的那一层"**。五层可分离：tokenizer 血统 / 模型权重 / 后训练塑造 / 服务栈 / 运营方。usage 与词表探针证明 tokenizer 血统；错误文本形状证明服务栈；它们都**不能**单独证明运营方。每条证据进账本时应携带所属层标注；血统识别便宜（约百次请求），运营方识别基本只能靠自愿披露——插件专注前者。

另一条调研结论直接决定优先级：**usage 计量是最抗反取证的面**——厂商伪造 usage 等于伪造自己的计费账单，而模板随机化、金丝雀词表隔离等反取证手段针对的恰恰是文本类指纹（来源 [The Nameless Surplus]）。因此 usage 类探针（已落地的 `--usage`）是长期最稳的底座。

## 已落地（本计划之外，列出仅为对齐现状）

- usage-delta fertility 指纹 —— drill `--usage` + `fingerprint-reference.py`（2026-09-25 定案 space-bunny-free = MiniMax-M3 tokenizer，L1=0；2026-09-26 扩容 T6–T9 后复测仍 L1=0，漂移审计稳定）。社区平行验证：r/opencodeCLI 用 7 条 canary 分词指纹把 Space Bunny Alpha 对准 MiniMax M3.1，r/singularity 用 95 探针全中把 Ox Alpha 对准 GLM-5 tokenizer——方法与本工具同型，属主流成熟路线。
- logprobs 词表规模指纹 —— drill `--logprobs`（echo 分词向量 + 欠训练 token 概率画像 + 观测 max token id → 候选家族对；token id 需 vLLM 类服务端）。
- 特殊 token 注入电池 —— drill `--inject`（家族停止符截断 + 假 token / 截断形态 / 400 拒绝 / 推理预算耗尽四类对照，promptΔ 判断 token 存活）。
- 目录泄露 `--models`、错误包络 `--errors`、上下文天花板 `--context`、同网关 A/B `--sibling`、跨层综合判定 `--batch`（2026-09-26 实测 space-bunny-free：context ≥1M 实测、错误包络为 zen 包装层、注入面诚实无证据、usage 九维 L1=0 → MiniMax-M3）。
- 面板批量测试 —— 探针扩到 11 个（新增工具格式诱发 / 拒答形状 / 上下文自述 / 身份格网 / 系统提示词提取），复选框多选 + 置信度排序 + 预计 token 数 + 一键批量（`runBatch` 单新会话逐条驱动）+ 聚合猜测卡（`src/client/batch.ts`，识别探针自列 token 防假阳性）。

## Drill 端新手段（按调研优先级排序）

1. **L1 探针文本组扩容 + 参照库扩家族**：现有 T0–T5 补充社区验证过的分歧维度——ZWJ 组合 emoji 与国旗、泰/韩/俄文、代码缩进/空白、浮点数列；`fingerprint-reference.py` 参照库补齐 2026 隐身高发家族：**Xiaomi MiMo、xAI Grok、Meituan LongCat、NVIDIA Nemotron**（17 个月 17 个隐身代号里四家都有产出，当前 VENDORS 表缺失）。usage 类，抗反取证，优先级最高。
2. **L2 包装常量显式化（wrapper offset）**：把 T0 的 `prompt_tokens − 本地 token 数` 作为"网关包装常量"单独建档、跨快照追踪。同一底层模型的两个入口包装常量可以不同，但词表不变；同一网关上隐身条目与具名条目的包装常量差（如社区实测 +24 offset）是强归属证据。改动小：快照加一个字段。
3. **L7 同网关目录 A/B**：对同一 baseURL 的具名兄弟模型跑同款 L1/L2 电池，比对包装常量、特殊 token 增量、vision 开销、reasoning_effort 行为。与某具名目录模型的连续性是接近确定性的证据。drill 加 `--sibling <model>` 多模型对比模式。
4. **L4 错误包络分析**：错误响应的形状本身就是服务栈指纹——数值 vs 字符串错误码、serde 风格（Rust vs Java 文案）、接受的 role 集、校验风格。drill 已能收到错误响应，只需记录形状；与原计划的响应头/流式字段采集合并为一个小节。注意分层：证明的是服务栈，不是模型。
5. **L3 上下文天花板验证**：二分搜索实测 verified context ceiling + 头/中/尾三针召回；1M 级实测可直接排除旧代际候选（space-bunny 案例的关键一步）。drill 加 `--context` 小节，成本可控（长 prompt 只计 usage，可用短 max_tokens）。
6. **L6 视觉真值与后端混合率**：已知颜色图片实测 vision 是否真开；**跨图片尺寸的 token 开销斜率**（恒定 = 占位符，按尺寸缩放 = 真编码器）；同一探针重复 24 次检测**异构后端池**（回复特征漂移 = 隐身条目实际是模型池——隐身模型独有问题）。依赖多模态 API，排在文本手段之后。
7. **logprobs 深水区**（在 `--logprobs` 之上）：(a) **全词表分布重建**——按 "Logits of API-Protected LLMs Leak Proprietary Information"（arXiv:2403.09539）的 softmax bottleneck 低秩方法，从 top-k logprobs 重建完整输出分布并估计 hidden size，单分布即可做模型识别；(b) **欠训练 token 概率画像**（UTF 思路的被动版）——echo 探针把 `token_logprobs` 数值也存下来，教师强制概率向量是 checkpoint 级签名，可离线跨模型比对。均为离线分析，drill 只需多存字段。
8. **金丝雀漂移审计固化**：反取证预测（模板随机化、金丝雀词表与出货词表隔离）意味着 tmpl-* 行与 canary 文本会随代际衰减——快照已落盘，补一个跨快照 diff 命令即可持续监控某隐身条目的指纹漂移（替换审计的推广）。

## 插件内新手段

- **审查边界形状画像**（社区自称"最强行为信号"）：分级话题阶梯探针（同一话题按措辞烈度递进），中英双语同电池跑出边界剖面——各家的拒绝边界位置与形状是后训练管线的签名，且隐蔽模型无法只改名字就改变它。实现为复制粘贴探针包 + 被动扫描拒绝句式密度。注意分层与抗性：Lasso Security 指出单次配置变更即可扰动该信号，只作支持性证据、跨轮聚合。研究基础：refusal discovery（Discovering Forbidden Topics in Language Models）。
- **自报身份降级为 bait 档**：stealthprint 明确把 "who are you" 类探针排除在外，因为隐身模型的自述**频繁是诱饵**。原计划的自报身份格网保留但只进 tier-3/bait 档，且声明与结构证据矛盾时反而记为异常。
- **隐身代号账本**：面板附一张社区已定案的代号→家族对照（Quasar/Optimus=GPT-4.1、Sherlock Dash=Grok 4.1 Fast、Pony=GLM-5、Hunter/Healer=小米 MiMo、Elephant=蚂蚁 Ling、Andromeda=NVIDIA Nemotron Nano 2 VL、Owl=美团 LongCat-2.0、Ox Alpha=GLM-5.3、Space Bunny=MiniMax M3.1……），新命中时给出"同型历史案例"参考。纯静态数据表 + 版本号。
- **保留项**：reasoning 开头词直方图、思考语言配比（被动 derived 行， folklore 级）；工具调用格式诱发探针、system prompt 提取探针（主动触发器）。R1 时代的风格 folklore 行（traj-*、delve、em-dash）维持 weight-1 支持级不再加重，专注最新代际的结构性行。

## 明确不投入

- 统计水印检测、embedding 侧信道——与只读宿主形态不匹配。
- 把 usage-delta 搬进插件内：宿主 conversation slice 只暴露 sessionId 与 assistant blocks；drill 是它的正确落点。
- 运营方（custody）判定：黑盒行为指纹可被语义保持的输出过滤钝化，且不属于血统层证据；账本只呈现分层证据，不下 custody 结论。

## 建议实施顺序

L1 扩容/新家族 > L2 包装常量 > L7 同网关 A/B > 审查边界电池（插件内最高） > L4 错误包络 > L3 上下文天花板 > logprobs 深水区 > L6 视觉 > 隐身代号账本。

## 来源（2026-09-25 调研）

- [stealthprint —— 隐身模型指纹库（L1–L7 分级、三个实锤案例）](https://github.com/majiayu000/stealthprint)
- [The Nameless Surplus —— 五层分离、"观测只识别能产生它的层"、billing-meter 抗反取证、17 代号账本](https://seldondance.substack.com/p/the-nameless-surplus)
- [Logits of API-Protected LLMs Leak Proprietary Information (arXiv:2403.09539) —— softmax bottleneck 低秩泄露、hidden size 估计、单分布识别](https://arxiv.org/abs/2403.09539)
- [r/opencodeCLI: M3.1 is Space Bunny Alpha —— 7 canary 分词指纹](https://www.reddit.com/r/opencodeCLI/comments/1wpv45g/m31_is_space_bunny_alpha)
- [r/singularity: I fingerprinted Ox Alpha —— 95 探针全中 GLM-5 tokenizer](https://www.reddit.com/r/singularity/comments/1vufbx1/i_fingerprinted_ox_alpha_same_tokenizer_as_glm53)
- UTF: Under-Trained Tokens as Fingerprints（ACL 2025）；LLMmap（USENIX Security）；AdaptPrint（arXiv 2026-08）—— 学术线，文本提及
