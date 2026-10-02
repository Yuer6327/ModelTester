# 厂商归属检测 — 后续计划

状态基线：2026-09-25（同日完成社区调研更新）。本文收纳已评估、暂未实施的检测手段；每项注明落点（drill = 仓库根直连 API 的开发工具，插件内 = 被动扫描或复制粘贴探针）与预期证据强度。原则不变：只记录结构性证据，宁可 unknown，不做身份断言。

## 取证分层原则（调研引入，约束所有新手段）

社区共识（见来源 [The Nameless Surplus]）：**一个观测只能识别"能产生它的那一层"**。五层可分离：tokenizer 血统 / 模型权重 / 后训练塑造 / 服务栈 / 运营方。usage 与词表探针证明 tokenizer 血统；错误文本形状证明服务栈；它们都**不能**单独证明运营方。每条证据进账本时应携带所属层标注；血统识别便宜（约百次请求），运营方识别基本只能靠自愿披露——插件专注前者。

另一条调研结论直接决定优先级：**usage 计量是最抗反取证的面**——厂商伪造 usage 等于伪造自己的计费账单，而模板随机化、金丝雀词表隔离等反取证手段针对的恰恰是文本类指纹（来源 [The Nameless Surplus]）。因此 usage 类探针（已落地的 `--usage`）是长期最稳的底座。

## 已落地（本计划之外，列出仅为对齐现状）

- usage-delta fertility 指纹 —— drill `--usage` + `fingerprint-reference.py`（2026-09-25 定案 space-bunny-free = MiniMax-M3 tokenizer，L1=0；2026-09-26 扩容 T6–T9 后复测仍 L1=0，漂移审计稳定）。社区平行验证：r/opencodeCLI 用 7 条 canary 分词指纹把 Space Bunny Alpha 对准 MiniMax M3.1，r/singularity 用 95 探针全中把 Ox Alpha 对准 GLM-5 tokenizer——方法与本工具同型，属主流成熟路线。**2026-09-26 已搬进面板**（`src/client/fertility.ts` + `fertility-score.ts`，FERTILITY_VERSION 1）：`usage 指纹` 按钮把 T0–T9 逐条发到**独立新会话**，读每轮 usage 的 prompt 侧 token（total−output，宿主节点结构读取），跨会话差分消掉网关包装常量（基线轮 prompt 侧同时作为 L2 包装常量显示），对 13 家官方 tokenizer 参照向量 L1 比对。单会话内逐轮差分的方案被实测否决——宿主动态管理上下文（压缩/截断/逐轮注入），轮间增量不等于文本 token。space-bunny-free 实测 9/9 维 L1=0 精确匹配 MiniMax（次近 llama L1=26），与 drill 两次定案一致。
- logprobs 词表规模指纹 —— drill `--logprobs`（echo 分词向量 + 欠训练 token 概率画像 + 观测 max token id → 候选家族对；token id 需 vLLM 类服务端）。
- 特殊 token 注入电池 —— drill `--inject`（家族停止符截断 + 假 token / 截断形态 / 400 拒绝 / 推理预算耗尽四类对照，promptΔ 判断 token 存活）。
- 目录泄露 `--models`、错误包络 `--errors`、上下文天花板 `--context`、同网关 A/B `--sibling`、跨层综合判定 `--batch`（2026-09-26 实测 space-bunny-free：context ≥1M 实测、错误包络为 zen 包装层、注入面诚实无证据、usage 九维 L1=0 → MiniMax-M3）。
- 面板批量测试 —— 探针扩到 11 个（新增工具格式诱发 / 拒答形状 / 上下文自述 / 身份格网 / 系统提示词提取），复选框多选 + 置信度排序 + 预计 token 数 + 一键批量（`runBatch` 单新会话逐条驱动）+ 聚合猜测卡（`src/client/batch.ts`，识别探针自列 token 防假阳性）。
- 用户回声抑制 + 置信度系数（2026-09-26 两轮实机迭代，ATTRIBUTION_VERSION 9）：第一轮（v8）发现批量会话里模型思考复述探针列出的 token，引擎把 `tmpl-step` 等假点燃到 18 分（space-bunny 排成 Step 第一、MiniMax 第六）；第二轮实机复测发现 v8 的回声抑制**在真机上完全未生效**——宿主 `chat.legacy` 里用户类节点发布的是 `node.data`（`{kind:'user', content:[{type:'text',text}]}`），没有 `blocks` 字段，回声语料一直是空的，一整排 tier-1 模板行 95–100%（GLM 100% 第一、MiniMax 第七）。v9 修复：① 回声语料同时读 `content` 消息分片与 `blocks`；② **讨论回合抑制**——提示词列过模板 token 的回合，其推理中的模板/异常命中整体丢弃（覆盖类推派生 token：`<|im_start|>`→`<|im_end|>`、`[INST]`→`[/INST]`）；③ 批量家族扫描只看可见回复、跳过模板识别回合（`batchScanText`）；④ glitch 金丝雀行改无厂商方向（退化/干净复读方向相反，由人判，纯诊断行）——消除干净会话里 OpenAI 靠金丝雀默认登顶；⑤ 置信度系数（t1 0.95 / t2 0.45 / t3 0.12 基线 × 权重/6，noisy-OR）用于排名与判定。实机复测（space-bunny-free 批量 11/11）：归属「未匹配 / 暂无归属证据」、批量「本轮未产生可排名的证据」——假证据清零，真空是诚实的（该隐身条目服务层不漏模板 token，文本面无 MiniMax 正向证据）。
- 隐身代号账本（2026-09-26 落地静态卡）：归属区附社区定案代号→家族对照（Space Bunny=MiniMax M3.1、Ox Alpha=GLM-5.3、Pony=GLM-5、Quasar/Optimus=GPT-4.1、Sherlock Dash=Grok 4.1 Fast、Hunter/Healer=小米 MiMo、Elephant=蚂蚁 Ling、Andromeda=NVIDIA Nemotron Nano 2 VL、Owl=美团 LongCat-2.0），纯参考、不参与评分；宿主不向插件暴露模型 id，自动匹配留待后续版本评估。

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

- **R1 时代风格 folklore 退役（2026-09-26）**：traj-minimal / traj-standard / style-delve / style-emdash 行与面板「轨迹特征/关键词明细/犹豫压力」区整体移除（ATTRIBUTION_VERSION 10，持久化 v3）——style 是行业级后训练产物（space-bunny 等 MiniMax 血统模型呈现同类风格），不是结构证据；量化 tokenizer 层证据由面板内 usage 指纹承担。保留推理健康诊断（纯文本无 reasoning 告警）。
- **审查边界形状画像**（社区自称"最强行为信号"）：拒答探针已升级为分级双语阶梯（3 话题 × 2 措辞烈度，2026-09-26）；进一步做成被动拒绝句式密度统计待评估。注意分层与抗性：Lasso Security 指出单次配置变更即可扰动该信号，只作支持性证据、跨轮聚合。研究基础：refusal discovery（Discovering Forbidden Topics in Language Models）。
- **自报身份矛盾显示（2026-09-26 落地）**：批量结论卡显示身份探针回复中自称的厂商（bait 档），供人工与结构证据对照；自动矛盾判定因语义模糊暂缓。
- **面板结果持久化 + 一键全量 + 会话清理（2026-09-26 落地）**：批量结论与 usage 指纹结论存 localStorage（记录机制版本 + 测量时间戳，形状/版本不符整体拒收），刷新后照常显示；「一键测试」升级为**全量电池**——自动遍历全部已注册测试项（11 探针 + fertility 序列，未来新增即自动纳入），usage 指纹按钮保留为单项快捷入口；runner 创建的会话 id 记入 `dsh-modeltester.test-sessions`，「清理测试会话」按钮特性探测宿主删除面——0.1.7 会话面只有 create/fork/rename/search/list，无删除 RPC，按钮如实提示待宿主支持。
- **自报身份降级为 bait 档**：stealthprint 明确把 "who are you" 类探针排除在外，因为隐身模型的自述**频繁是诱饵**。原计划的自报身份格网保留但只进 tier-3/bait 档，且声明与结构证据矛盾时反而记为异常。
- **隐身代号账本**：面板附一张社区已定案的代号→家族对照（Quasar/Optimus=GPT-4.1、Sherlock Dash=Grok 4.1 Fast、Pony=GLM-5、Hunter/Healer=小米 MiMo、Elephant=蚂蚁 Ling、Andromeda=NVIDIA Nemotron Nano 2 VL、Owl=美团 LongCat-2.0、Ox Alpha=GLM-5.3、Space Bunny=MiniMax M3.1……），新命中时给出"同型历史案例"参考。纯静态数据表 + 版本号。**（静态卡已落地，见上「已落地」；自动匹配需宿主暴露模型 id，待评估。）**
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

## 2026-10-02 实机验证记录（桌面版 0.2.0-rc.2，space-bunny-free）

- **usage 指纹通道全链路验证通过**：25 家参照表 + 后台并发采集 + 崩溃续跑（T0–T5 读数跨重启复用）实机跑通；结论卡给出 minimax-m3 8/9 维共识簇、offset 0、runner-up（llama/deepseek-v4，L1 181）——与社区 space-bunny = MiniMax 系定案一致；wrapper 漂移如实标记（drift=true），离群维（T9）由「定向重测」按钮给出，等一次干净重跑。
- **批量通道文本面受宿主限制**：实测确认 `sessions.create()` 不聚焦新会话，会话装配（chat.legacy）仅为主视图会话物化——后台探针会话经 `uiConversation.binding(id)` 与 SessionFace 快照均读不到文本（20+ 次采集 0 字符；会话实际在 ~46s 内完成回复）。批量探针在宿主补上「后台装配物化」或插件拿到 uiSession 聚焦能力之前，文本采集只能在探针会话恰好位于主视图时成功；超时项如实记 0 字符，聚合宁可 none 不造假。usage projections 不受此限（fertility 并发采集正常）。
- **背景窗口计时器节流**：遮挡/最小化窗口内 setTimeout 被节流到分钟级，纯定时轮询会瘫痪——采集等待已改为「宿主 observable 订阅唤醒 + 定时兜底」（waitTick），订阅回调不受节流影响。
