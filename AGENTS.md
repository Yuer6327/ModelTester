# ModelTester — DSH 兼容性长期维护规范

- **生效日期**：2026-09-25
- **来源**：用户交接提示词（长期维护授权，基于 DSH STORE 兼容性上架契约）
- **维护范围**：仅限本文所述的 DSH 版本跟进；其他事项未经用户明确要求不要动手。

## 背景（必须理解）

- 本插件上架于 DSH STORE。商城每 8 小时（UTC 00:05 / 08:05 / 16:05）自动扫描本仓库默认分支的固定 Commit，不执行任何本地代码，也不需要作者回复任何 issue。
- 商城滚动窗口 = npm 上 `@deepseek-ai/dsh` 按发布时间最新的三个非弃用发行版。`package.json` 的 `dsh.compatibility.dshReleases` 矩阵必须对窗口内至少一个版本有精确 `compatible` 记录，否则条目被自动暂时下架（可自动恢复）；范围声明不能替代逐版本精确记录。
- 兼容性证据工具：仓库根 `verify-dsh-releases.mjs`（`pnpm dsh-releases check` / `pnpm dsh-releases probe <dsh版本>…`）。probe 对指定版本下载四个契约包并验证四项契约面：
  1. dsh-web-frontend 平台种子表（9 项，含插件必需的 7 项）；
  2. dsh-client-ui-layout 的 `shell.overlay` 仍为 `{kind:'list',scope:'root'}`；
  3. dsh-client-ui-chat 的 `chat.legacy` 切片仍含 `nodes`/`partial`；
  4. dsh-api-session-controller 的 `SessionFace = ISession & ObservableSnapshot<SessionSnapshot>` 且有 `loadOlder()`。
- 插件运行时兼容性按设计来自结构读取，不依赖依赖范围；因此静态探针通过即可作为 `compatible` 声明的依据，但静态探针不等于真实 Profile 实机验收。
- **0.2.0 线两个实机契约变化（2026-09-30 实测，静态探针不覆盖）**：① client 入口模块的 `export const inject` 数组从「激活顺序提示」变为 **ctx 服务授权清单**——插件用到的每个服务（`sessions`/`uiConversation`/…）都必须声明，缺失即运行时拿不到该服务（表现为面板「暂无会话」、actions 返回 `unavailable`）；② `sessions.list.getSnapshot()` 移除了 `current` 字段（0.2.0 形状为 `{ids, byId, phase, projectionsBySession}`），当前会话选择移入 `uiSession` 服务，可结构读取 `byId[id].retainedBy.mainView > 0` 兜底（ModelTester 0.0.6-alpha.3 已修，兼容双读）。
- **主环境（2026-09-29 起）**：用户以 DSH 官方桌面端为主操作环境（本机安装于 `D:\Users\Yuer6327\AppData\Local\Programs\DeepSeek Harness\`），已卸载 WorkBuddy 目录内的旧 dsh CLI。桌面端内置 dsh 版本读其 `resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`。桌面端随 npm 发行版同步更新，滚动窗口仍以 npm `@deepseek-ai/dsh` 为准，例行流程不变；桌面端更新发布新版本时同样按本规范跟进。插件发布到 npm 后提醒用户在桌面端插件页安装。

## 例行流程（每次运行执行）

1. `git pull` 确保本地与 origin/main 一致。
2. `pnpm dsh-releases check`：
   - 退出码 0：窗口已全覆盖，本次结束，一句话报告，不做任何修改。
   - 退出码 1：npm registry 读取失败，失败关闭——不修改、不声明、不推送，报告错误后结束。
   - 退出码 2：取输出中的未声明版本列表，继续。
3. 未声明版本中若出现新版本线（如 0.2.0）：自动运行时停止，不声明、不推送，报告「出现新版本线，需要人工评估」后结束。跨系列必须人工跟进——仅当用户明确授权跟进该版本线后才继续步骤 4-7（插件运行时兼容性来自结构读取，探针通过 + 门禁全绿即可声明；0.2.0 线已于 2026-09-29 由用户授权跟进并声明）。
4. `pnpm dsh-releases probe <未声明版本…>`。任何一项探针失败：该版本保持未声明（unknown），本次不做任何提交与推送，报告失败详情后结束。宁可 unknown，绝不写入未经证实的 compatible。
5. 全部探针通过后修改文件：
   - `package.json`：每个新版本以 `"compatible"` 加入 `dsh.compatibility.dshReleases`（保留现有条目）；patch 版本号 +1；把六个 `@deepseek-ai` devDependencies（`dsh-brand`、`dsh-client-locale`、`dsh-client-store`、`dsh-client-ui-layout`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`）的精确锁更新为本次已声明版本中最新的那个；其余字段不动。
   - `package.json` 的 `dsh.compatibility.dsh` 范围声明：仅当新声明版本超出现有范围上下限时同步放宽（如跟进 0.2.x 时 `<0.2.0` 改 `<0.3.0`），避免与逐版本矩阵自相矛盾；其余字段仍不动。
   - `dsh-plugin.json`：仅把 `version` 改成与 `package.json` 一致。
   - 不修改 README（README 已注明矩阵以 package.json 为准；若出现新版本线，提醒用户人工更新 prose）。
6. `pnpm install`，然后依次 `pnpm typecheck`、`pnpm test`、`pnpm compat`、`pnpm build`。任何一步失败：`git checkout -- package.json dsh-plugin.json pnpm-lock.yaml verify-dsh-host.mjs` 撤销，报告失败输出，不推送。
7. 全部通过后提交：只 add 本次实际修改的 `package.json dsh-plugin.json pnpm-lock.yaml`，若本次同步修订了 `verify-dsh-host.mjs`（如门禁脚本内硬编码的版本线假设过时）或本文件，一并 add；提交信息第一行 `ModelTester <新版本号>: follow dsh <版本列表>`，正文注明：四项静态契约探针逐版本通过、证据为静态发行物比对、未做真实 Profile 实机验收，并逐条列出对常规清单的偏离及理由。推送到 origin/main；被拒时不强推、不覆盖远端，报告后结束。

## 硬性边界

- 探针不过绝不声明 compatible；失败关闭；绝不 force push；绝不写入或修改真实 `~/.dsh`；与任务无关的未提交改动一律不碰。
- `npm publish` 属对外发布且需要凭证：发现 npm 上的 `dsh-modeltester` 版本落后于仓库版本时，只报告提醒用户发布，不自动执行。
- 不要在 DSH-Store 的任何 issue 下回复、确认或关闭；商城状态全自动流转。

## 当前基线（2026-09-29，跨系列跟进 0.2.0 时更新）

- 2026-09-25 品牌重构：NoLetMe 0.3.9 → ModelTester 0.0.1-alpha.1。新仓库 `Yuer6327/ModelTester`（全新 git 历史）；旧仓库 `Yuer6327/NoLetMe` 与其 STORE 条目冻结在 0.3.9，不再维护。
- 2026-09-29 首次跨系列跟进（用户授权）：插件 0.0.6-alpha.2；矩阵新增 0.2.0-rc.1、0.2.0-rc.2（均为静态证据）；dev lock 0.2.0-rc.2；范围声明放宽至 `<0.3.0`。npm 上 `dsh-modeltester` 停留在 0.0.5-alpha.2，仓库领先，发布由用户手动执行。
- 下一个待跟进版本预计为 0.2.0-rc.3 或 0.2.0 正式版。
