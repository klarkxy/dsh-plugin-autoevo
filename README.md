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
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

安装后 AutoEvo 会先尝试把 bundle 热加载进当前 DSH 进程；只有 Loader 无法完成热加载（例如还包含浏览器端资源）时才要求重启。

升级时把 tag 换成新版本，再执行同一条安装命令，例如 `#v0.5.0` 换成 `#v0.5.1`。

DSH 的 `plugin` 命令把依赖操作转交给 pnpm。semver、Git tag 和 exact commit 都能钉住版本；AutoEvo 安装后会显式尝试 Loader 热加载，失败时才要求重启。

本仓库开发安装：

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.5.1.tgz"
```

开发包同样使用不可变 `file:...tgz`。这也避开了 DSH rc.6 在 Windows 上转交含空格 `link:` 路径时的参数拆分问题。第三方候选也会打成 owned `file:...tgz`。

## 能力进化模式

安装后，AutoEvo 默认会安装用户 Agent preset **能力进化**（id `evolution`，模板版本 V9）。它基于创造模式：具备创造模式的全部能力，并提供社区插件复用、审查安装、已有能力升级和受控的托管 git 源创建；改进过的插件可在明确批准后贡献回上游。配置项 `evolutionPreset` 默认为 `true`；设为 `false` 只跳过安装与升级，**不会**删除已有 preset。`sourceDir` 默认为 `<stateDir>/sources`，用于托管 modify/create 的普通 git 源仓库。Policy V5 起，未完成的旧 policy workflow 不能 resume，必须重新 `capability_workflow` 开一条新的 V5 发现。

> [!WARNING]
> **不要使用智力或工具调用能力过低的 LLM 运行能力进化。** 最终安装、修改、新建和停止决定由当前 LLM 理解用户自然语言后提交为结构化 `decision`；Host 负责校验真实新用户回合、当前 interrupt 绑定的 action/candidate、review、session、boot 与防重放边界，但不会再用关键词替模型重做语义理解。弱模型可能在合法选项之间选错动作或候选。请使用具备可靠指令遵循、上下文保持和结构化工具调用能力的模型。

它出现在 DSH 的用户 preset 列表里（界面标记为自定义），不是内置系统模式。首次安装或升级后先尝试热加载，只有当前进程无法完整接入时才需要重启。AutoEvo 只升级自己管理且未被改过的版本；用户改过的文件、或同名的外来目录一律保留。

新建动态 Cordis 插件时，在空白/新会话中把 Agent 切到 **能力进化**。官方创造模式仍用于既有插件修复和静态开发；AutoEvo 不会在全局替换 `cordis-plugin-development`。

卸载 AutoEvo 前，先在 DSH 的 Agent preset 管理界面移除 **能力进化**，再移除插件依赖并重启。仅把 `evolutionPreset` 设为 `false` 不会删除现有目录。

## 工作方式

- 父会话执行层拒绝 filesystem write/edit、shell、Cordis mutation/definition、agent/subagent/workflow 委托，以及直接的 DSH plugin install/remove。只保留读/搜/审与 AutoEvo 决策工具。Windows 上 sandbox 是完整性导向的部分隔离，不宣称机密性或网络隔离。
- Workflow 只管理持久状态、审查证据和副作用授权。Agent 负责把“两个都、前两个、全部、另一个、第二个”等自然语言映射到当前 interrupt 快照的候选 ID；这类只读导航调用 `capability_workflow_resume` 时携带 `navigation`，不会产生授权回执。
- 严格完整匹配的本地能力直接推荐；产品名或仓库名重合不能单独阻止远端搜索。远端候选最多三个，支持固定审查或“先审两个、没有可直接使用项再审第三个”的自适应计划。
- 审完后只展示真实合法动作。简单 UI 主操作为 `use_this` / `search_more`；`modify_this` / `create_new` / `stop` 在 advanced/recovery。用户明确选择安装、修改、新建或停止时，Agent 直接依靠 LLM 的语义理解提交结构化 `decision`：`action`、安装/修改所需的当前候选 `candidate_id`，以及安装时可选的 `retention`。Host 只验证该解释是否落在当前 interrupt 和快照边界内，铸造 commitment/lease，并把它绑定到新鲜真实用户回合；不再用正则表达式二次解析用户措辞。DSH approval 不能代替该决定。MechanicalFacts 只用于展示和路由；需要语义判断时由 Host 拉起独立 reviewer。
- 安全 finding 是静态审查事实，不是用途判断。同类 source/build 命中会合并展示来源；Agent 不得从 `process_execution` 自行推断“恶意”“OAuth 必需”“启动回调服务”或其它未验证语义。任何 block finding 仍保持 `high` 并禁止直接安装。
- `create_authorized` / `modify_this` 只在 Host 拉起的、cwd 绑定托管源、`workspace-write` 子会话中继续；父会话不得 `cordis_define(kind:new)`。
- 用户停止父任务时，Host 会立即 dispose 正在运行的托管子 Agent。已产生的受控编辑用独立 cleanup 生命周期 checkpoint；workflow 进入 `recovery_required`，锁被释放，取消不会伪装成“git 不存在”。
- 安装结果只有 `pending | verified | failed_absent | recovery_required`。只有 Loader/runtime 验证通过后才报告 installed/success。`plugin_remove` 只卸载，不删除托管源仓库。
- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，优先调用当前 Agent scope 内已有的 [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin)。若市场未安装，AutoEvo 在一次性批准后用脚本安装 `dsh-find-plugin` 并尽量热加载到当前进程；热加载失败才需要重启。不要审查市场插件，也不要直接用 `gh` 搜索。市场已装但没有相关候选时，视为没有可复用插件。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，实际 DSH 版本兼容，且 review 携带匹配的不可变 install specification。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 临时试用在隔离 DSH home 中进行。最终 `verified` 需要 Host mechanical Loader 证据（真实 `tool/call`、匹配的成功 `tool/result`、`turn/end: completed`）以及独立 semantic verifier。`taskResultMatchedExpectation` 只是诊断字段，不作为成功门槛。
- `partial` 候选在托管 git 源上做最小修改并跑上游测试，再本地重审为 `full`，最后打成固定 tgz 安装。
- 对已装社区插件不满时，升级走同一套门禁：安装回执经 `reviewId` 指回上游 repository 与 exact commit，用户选中该来源后按审查 → 在这个上改 → 本地重审 → 固定 tgz 重装执行，最后按旧回执精确移除。从零创建走托管源脚手架，不恢复 `create_authorized` grant。
- 当前任务完成后再建议向上游贡献。安装回执的 `contributionAdvice` 记录是否具备建议资格；fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

安装完成后（若结果明确要求重启则先重启），对当前 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_workflow`，再用精简编号说明候选。你可以回复“按推荐”“两个都”“第二个”或“另一个”；Agent 会把它转换为当前快照候选 ID，并用只读 `navigation` 推进审查。最终安装、修改或新建确认由 LLM 转换成结构化 `decision`，Host 再把它约束到当前真实用户回合和 interrupt 候选集合。如果当前 scope 还没有 `find_dsh_plugin`，批准后由 AutoEvo 用脚本安装并尽量热加载；热加载失败才需要重启。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_workflow` | 启动固定工作流：检查本地能力，需要时复用 `find_dsh_plugin`，没有市场则申请批准并用脚本安装。返回带 `interrupt_id` 的 interrupt；同会话/cwd/需求会复用未完成工作流 | 只读 / 装市场时需批准 |
| `capability_workflow_resume` | 只读搜索/审查/复用时传 `navigation`；最终确认时由 LLM 传结构化 `decision`，Host 校验真实回合与当前 interrupt 的 action/candidate 边界 | 导航只读；安装/修改/新建需真实确认 |
| `plugin_remove` | 按 installation receipt 精确卸载；不删除托管源仓库 | 需批准 |

AutoEvo 新增这些高层工具，并在父会话执行边界上拒绝 write/shell/Cordis-new/委托/直接装卸；当前 Profile 的其余工具仍由其 Agent scope 决定。

## 基线

维护线 `0.5.1`。已验证：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 \|\| >=24`。审查回执记录实际 `dsh --version`；无法确认版本时不会授权安装。

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
