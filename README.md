# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用与安全演进插件。Agent 需要新能力时，先检查本地已有工具和技能，再搜索、审查、部署社区插件；候选只差一点，就地改进后再用。对动态 Cordis 插件入口，AutoEvo 会在工具执行层强制执行这一顺序。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## 安装

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.3
```

安装后 AutoEvo 会先尝试把 bundle 热加载进当前 DSH 进程；只有 Loader 无法完成热加载（例如还包含浏览器端资源）时才要求重启。

升级时把 tag 换成新版本，再执行同一条安装命令，例如 `#v0.5.2` 换成 `#v0.5.3`。

DSH 的 `plugin` 命令把依赖操作转交给 pnpm。semver、Git tag 和 exact commit 都能钉住版本；AutoEvo 安装后会显式尝试 Loader 热加载，失败时才要求重启。

本仓库开发安装：

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.5.3.tgz"
```

开发包同样使用不可变 `file:...tgz`。这也避开了 DSH rc.6 在 Windows 上转交含空格 `link:` 路径时的参数拆分问题。第三方候选也会打成 owned `file:...tgz`。

## 能力进化模式

安装后，AutoEvo 默认会全新安装用户 Agent preset **能力进化**（id `evolution`，模板版本 V12）。它基于创造模式：具备创造模式的全部能力，并提供社区插件复用、审查安装、已有能力升级和受控的托管 git 源创建；改进过的插件可在明确批准后贡献回上游。当前没有旧用户迁移路径：发布包只认当前 V12 的精确托管内容，其他现有或手改 preset 一律保留，不会覆盖。配置项 `evolutionPreset` 默认为 `true`；设为 `false` 只跳过安装，**不会**删除已有 preset。`sourceDir` 默认为 `<stateDir>/sources`，用于托管 modify/create 的普通 git 源仓库。当前运行时是 Policy V8。completed 的安装可在用户新的顶层消息明确要求清理并重来后，按工作流精确清理再开全新发现；故障 `recovery_required` 仍走 sealed interrupt，两条路径不得混同。

> [!WARNING]
> **不要使用智力或工具调用能力过低的 LLM 运行能力进化。** 最终安装、修改、新建和停止决定由当前 LLM 理解用户自然语言后提交为结构化 `decision`；Host 负责校验真实新用户回合、当前 interrupt 绑定的 action/candidate、review、session、boot 与防重放边界，但不会再用关键词替模型重做语义理解。弱模型可能在合法选项之间选错动作或候选。请使用具备可靠指令遵循、上下文保持和结构化工具调用能力的模型。

它出现在 DSH 的用户 preset 列表里（界面标记为自定义），不是内置系统模式。首次安装或升级后先尝试热加载，只有当前进程无法完整接入时才需要重启。AutoEvo 只升级自己管理且未被改过的版本；用户改过的文件、或同名的外来目录一律保留。

新建动态 Cordis 插件时，在空白/新会话中把 Agent 切到 **能力进化**。官方创造模式仍用于既有插件修复和静态开发；AutoEvo 不会在全局替换 `cordis-plugin-development`。

卸载 AutoEvo 前，先在 DSH 的 Agent preset 管理界面移除 **能力进化**，再移除插件依赖并重启。仅把 `evolutionPreset` 设为 `false` 不会删除现有目录。

## 工作方式

- 父会话复用创造模式的官方工具（读改文件、shell、计划、待办、子代理、Cordis 检查与 existing 定义等）。执行层只拒绝 `cordis_define(kind:new)` 和未审查的直接装卸。社区插件的改/建仍在 Host 拉起的 `workspace-write` 托管源子会话中进行。Windows 上 sandbox 是完整性导向的部分隔离，不宣称机密性或网络隔离。
- Workflow 只管理事实、预算、持久状态和副作用授权。`capability_workflow` 返回最多 20 个 Host 验证候选；Agent 可在最多两轮、五个补充查询词内调用 `capability_workflow_refine` 换词或提交严格的 GitHub 仓库标识，再用 `capability_workflow_present` 自主密封 1–5 个最终候选。密封前没有用户选择 interrupt，也不会预选推荐项。
- Agent 自主排序、比较、推荐和自然表达，并负责把“按你推荐”“两个都”“另一个”“看看3”等回答映射到密封候选 ID。只有新鲜真实用户回合选中的候选才进入只读审查；审查完成后才签发第二道决定门。
- 审完后只展示真实合法动作。简单 UI 主操作为 `use_this` / `search_more`；`modify_this` / `create_new` / `stop` 在 advanced/recovery。用户明确选择安装、修改、新建或停止时，Agent 直接依靠 LLM 的语义理解提交结构化 `decision`：`action`、安装/修改所需的当前候选 `candidate_id`，以及安装时可选的 `retention`。Host 只验证该解释是否落在当前 interrupt 和快照边界内，铸造 commitment/lease，并把它绑定到新鲜真实用户回合；不再用正则表达式二次解析用户措辞。DSH approval 不能代替该决定。MechanicalFacts 只用于展示和路由；需要语义判断时由 Host 拉起独立 reviewer。
- 安全 finding 是静态审查事实，不是用途判断。同类 source/build 命中会合并展示来源；Agent 不得从 `process_execution` 自行推断“恶意”“OAuth 必需”“启动回调服务”或其它未验证语义。任何 block finding 仍保持 `high` 并禁止直接安装。
- `create_authorized` / `modify_this` 只在 Host 拉起的、cwd 绑定托管源、`workspace-write` 子会话中继续；父会话不得 `cordis_define(kind:new)`。
- 用户停止父任务时，Host 会立即 dispose 正在运行的托管子 Agent。已产生的受控编辑用独立 cleanup 生命周期 checkpoint；workflow 进入 `recovery_required`，锁被释放，取消不会伪装成“git 不存在”。
- 安装结果为 `pending | verified | activated | awaiting_user_test | failed_absent | recovery_required`。`verified`、`activated`、`awaiting_user_test` 都是非失败完成态：workflow completed，不阻塞正常聊天。只有 Host `tool_roundtrip` passed 才是功能已验证；`activated` 只表示 bundle 已加载；`awaiting_user_test` 需要用户到目标客户端/profile 手动测试，后二者不得冒充已验证。`plugin_remove` 只卸载，不删除托管源仓库。
- 搜索、审查、托管修改、安装或验证失败后，Agent 可调用只读 `capability_workflow_diagnose` 获取脱敏定长事实；每个失败事件最多两次诊断、合计八个探针。诊断不会重试、修改、安装或清理。重复失败后给出人类决策或诊断出口，不得原样循环。
- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，优先调用当前 Agent scope 内已有的 [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin)。若市场未安装，AutoEvo 在一次性批准后用脚本安装 `dsh-find-plugin` 并尽量热加载到当前进程；热加载失败才需要重启。不要审查市场插件，也不要直接用 `gh` 搜索。市场已装但没有相关候选时，视为没有可复用插件。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，实际 DSH 版本兼容，且 review 携带匹配的不可变 install specification。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 机械验证完全由 Host 驱动：不把验证任务交给普通模型，不让模型自行判断 success，也不把独立 semantic verifier 当作可信完成门槛。旧 semantic 组件可兼容存在，但发布包行为以 Host 三层结果为准。
- 三层必须严格区分：`tool_roundtrip` passed → `verified`；`bundle_activation` passed → `activated`；`manual_runtime` persistent → `awaiting_user_test`。第三方工具包默认没有 Host attestation，因此通常进入 `manual_runtime` / persistent；包清单 `safe`/`risk` 或候选自报不得升级为 `tool_roundtrip`。`manual_runtime` 的 temporary 会在安装与批准副作用前被拒绝。
- 进入 `awaiting_user_test` 后，自然提示用户到目标客户端/profile 手动测试；不要机械式固定话术，也不要在之后的闲聊里反复追问。
- 同一 review / source / layer / fixture 不能重复安装或验证；modify 最多两次。用户明确要求清理并重来时，completed 的 `installed` / `restart_required` / `activated` / `awaiting_user_test` 走完成态 cleanup/restart；故障 `recovery_required` 走 sealed interrupt。`taskResultMatchedExpectation` 只是诊断字段，不作为成功门槛。
- `partial` 候选在托管 git 源上做最小修改并跑上游测试，再本地重审为 `full`，最后打成固定 tgz 安装。
- 对已装社区插件不满时，升级走同一套门禁：安装回执经 `reviewId` 指回上游 repository 与 exact commit，用户选中该来源后按审查 → 在这个上改 → 本地重审 → 固定 tgz 重装执行，最后按旧回执精确移除。从零创建走托管源脚手架，不恢复 `create_authorized` grant。
- 当前任务完成后再建议向上游贡献。安装回执的 `contributionAdvice` 记录是否具备建议资格；fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

安装完成后（若结果明确要求重启则先重启），对当前 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_workflow` 获取真实发现池，自主补查或收敛后调用 `capability_workflow_present` 给出 1–5 个自然短名单。你选一个后 Host 才审查，再停一次让你决定是否安装。同回合 resume 是 no-op，不是错误。用自然语言明确选择即可；例如“装这个”表示安装，“看看第二个”表示改看另一个候选——这些只是例子，不是固定口令。最终安装、修改或新建由 LLM 理解该明确选择后转换成结构化 `decision`，Host 再把它约束到当前真实用户回合。如果当前 scope 还没有 `find_dsh_plugin`，批准后由 AutoEvo 用脚本安装并尽量热加载；热加载失败才需要重启。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_workflow` | 保留用户原始需求，检查本地与市场能力，返回 Host 验证的有界发现池、证据和预算 | 只读 / 装市场时需批准 |
| `capability_workflow_refine` | 在发现阶段提交补充查询词或严格 GitHub 仓库标识；Host 校验、去重并合并候选 | 只读 |
| `capability_workflow_present` | 从发现池密封 1–5 个最终短名单候选并开启第一道用户门 | 只读 |
| `capability_workflow_resume` | 只读搜索/审查/复用时传 `navigation`；最终确认时由 LLM 传结构化 `decision`，Host 校验真实回合与当前 interrupt 的 action/candidate 边界 | 导航只读；安装/修改/新建需真实确认 |
| `capability_workflow_diagnose` | 失败后读取有预算的脱敏搜索、审查、安装、验证、子会话和清理事实 | 只读 |
| `capability_workflow_recover` | 两条互不混同的路径：sealed 故障恢复必须带当前 `interrupt_id`；completed 安装的清理重开由新的顶层用户明确要求驱动，且省略 `interrupt_id` | 需真实确认 / 一次性批准清理 |
| `plugin_remove` | 按 installation receipt 精确卸载；不删除托管源仓库 | 需批准 |

AutoEvo 新增这些高层工具，并在父会话只拦截 `cordis_define(kind:new)` 与直接装卸；创造模式的其余官方工具保持可用。

## 基线

维护线 `0.5.3`。已验证：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 \|\| >=24`。审查回执记录实际 `dsh --version`；无法确认版本时不会授权安装。

```powershell
node --version
pnpm --version
gh auth status
pnpm check         # 日常门：静态检查、单测、Loader、local/adversarial E2E
pnpm check:release # 日常门 + 市场/full/partial live E2E + pack dry-run；发布前必须通过
```

设计见 [架构说明](docs/architecture.md)，安全门槛见 [安全模型](docs/security.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
