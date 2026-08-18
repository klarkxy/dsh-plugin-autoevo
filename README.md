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

安装后重启对应的 DSH 进程。bundle 在进程启动时加载。

升级时把 tag 换成新版本，再执行同一条安装命令，例如 `#v0.5.0` 换成 `#v0.5.1`。

DSH 的 `plugin` 命令把依赖操作转交给 pnpm。semver、Git tag 和 exact commit 都能钉住版本，但 DSH 不会自动追踪或热加载。固定版本后需要显式升级并重启。

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

安装后，AutoEvo 默认会安装用户 Agent preset **能力进化**（id `evolution`，模板版本 V5）。它基于创造模式：具备创造模式的全部能力，并提供社区插件复用、审查安装、已有能力升级和受控的托管 git 源创建；改进过的插件可在明确批准后贡献回上游。配置项 `evolutionPreset` 默认为 `true`；设为 `false` 只跳过安装与升级，**不会**删除已有 preset。`sourceDir` 默认为 `<stateDir>/sources`，用于托管 modify/create 的普通 git 源仓库。

它出现在 DSH 的用户 preset 列表里（界面标记为自定义），不是内置系统模式。首次安装或升级后需要重启对应的 DSH 进程。AutoEvo 只升级自己管理且未被改过的版本；用户改过的文件、或同名的外来目录一律保留。

新建动态 Cordis 插件时，在空白/新会话中把 Agent 切到 **能力进化**。官方创造模式仍用于既有插件修复和静态开发；AutoEvo 不会在全局替换 `cordis-plugin-development`。

卸载 AutoEvo 前，先在 DSH 的 Agent preset 管理界面移除 **能力进化**，再移除插件依赖并重启。仅把 `evolutionPreset` 设为 `false` 不会删除现有目录。

## 工作方式

- 父会话执行层拒绝 filesystem write/edit、shell、Cordis mutation/definition、agent/subagent/workflow 委托，以及直接的 DSH plugin install/remove。只保留读/搜/审与 AutoEvo 决策工具。Windows 上 sandbox 是完整性导向的部分隔离，不宣称机密性或网络隔离。
- 发现结束后先在对话里说明候选，等真实用户回话；再调用 `capability_workflow_resume`，**只传** `workflow_id` 与 `interrupt_id`。Host 从已声明的用户回合解析决策。审完后再等用户明确选择 `用这个` / `在这个上改` / `新建`。DSH approval 不能代替该决策。
- `create_authorized` / `modify_this` 只在 Host 拉起的、cwd 绑定托管源、`workspace-write` 子会话中继续；父会话不得 `cordis_define(kind:new)`。
- 安装结果只有 `pending | verified | failed_absent | recovery_required`。只有 Loader/runtime 验证通过后才报告 installed/success。`plugin_remove` 只卸载，不删除托管源仓库。
- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，优先调用当前 Agent scope 内已有的 [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin)。若市场未安装，AutoEvo 在一次性批准后用脚本安装 `dsh-find-plugin` 并尽量热加载到当前进程；热加载失败才需要重启。不要审查市场插件，也不要直接用 `gh` 搜索。市场已装但没有相关候选时，视为没有可复用插件。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，实际 DSH 版本兼容，且 review 携带匹配的不可变 install specification。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 临时试用在隔离 DSH home 中进行。验证需要真实的 `tool/call`、匹配的成功 `tool/result`，以及以 `turn/end: completed` 收口的最终回答；还可要求回答含精确预期文本。
- `partial` 候选在托管 git 源上做最小修改并跑上游测试，再本地重审为 `full`，最后打成固定 tgz 安装。
- 对已装社区插件不满时，升级走同一套门禁：安装回执经 `reviewId` 指回上游 repository 与 exact commit，用户选中该来源后按审查 → 在这个上改 → 本地重审 → 固定 tgz 重装执行，最后按旧回执精确移除。从零创建走托管源脚手架，不恢复 scratch grant。
- 当前任务完成后再建议向上游贡献。安装回执的 `contributionAdvice` 记录是否具备建议资格；fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

安装并重启后，对当前 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_workflow`，再在对话里说明搜到的仓库是干什么的，等你回话后才调用 `capability_workflow_resume`（只带 `workflow_id` 与 `interrupt_id`）。如果当前 scope 还没有 `find_dsh_plugin`，批准后由 AutoEvo 用脚本安装并尽量热加载；热加载失败才需要重启。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_workflow` | 启动固定工作流：检查本地能力，需要时复用 `find_dsh_plugin`，没有市场则申请批准并用脚本安装。返回带 `interrupt_id` 的 interrupt；同会话/cwd/需求会复用未完成工作流 | 只读 / 装市场时需批准 |
| `capability_workflow_resume` | 仅传 `workflow_id` + `interrupt_id`；由 Host 从已声明用户回合解析决策 | 审查只读；安装需批准 |
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
