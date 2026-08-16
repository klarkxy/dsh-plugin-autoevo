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
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.2.0
```

安装后重启对应的 DSH 进程。bundle 在进程启动时加载。

升级时把 tag 换成新版本，再执行同一条安装命令，例如 `#v0.2.0` 换成 `#v0.2.1`。

DSH 的 `plugin` 命令把依赖操作转交给 pnpm。semver、Git tag 和 exact commit 都能钉住版本，但 DSH 不会自动追踪或热加载。固定版本后需要显式升级并重启。

本仓库开发安装：

```powershell
pnpm install
pnpm build
New-Item -ItemType Directory -Force C:\tmp\autoevo-pack
npm pack --pack-destination C:\tmp\autoevo-pack --ignore-scripts
dsh plugin --profile web add --save-exact "file:C:/tmp/autoevo-pack/dsh-plugin-autoevo-0.2.0.tgz"
```

开发包同样使用不可变 `file:...tgz`。这也避开了 DSH rc.6 在 Windows 上转交含空格 `link:` 路径时的参数拆分问题。第三方候选也会打成 owned `file:...tgz`。

## 能力进化模式

安装后，AutoEvo 默认会安装用户 Agent preset **能力进化**（id `evolution`）。它基于创造模式：具备创造模式的全部能力，并提供社区插件复用、审查安装和受控的动态 Cordis 插件创建。配置项 `evolutionPreset` 默认为 `true`；设为 `false` 只跳过安装与升级，**不会**删除已有 preset。

它出现在 DSH 的用户 preset 列表里（界面标记为自定义），不是内置系统模式。首次安装或升级后需要重启对应的 DSH 进程。AutoEvo 只升级自己管理且未被改过的版本；用户改过的文件、或同名的外来目录一律保留。

新建动态 Cordis 插件时，在空白/新会话中把 Agent 切到 **能力进化**。官方创造模式仍用于既有插件修复和静态开发；AutoEvo 不会在全局替换 `cordis-plugin-development`。

卸载 AutoEvo 前，先在 DSH 的 Agent preset 管理界面移除 **能力进化**，再移除插件依赖并重启。仅把 `evolutionPreset` 设为 `false` 不会删除现有目录。

## 工作方式

- 带 Agent 身份的 `cordis_define`（`plugin.kind = "new"`）只在真正的能力进化模式下放行，且必须先经过 `capability_resolve`。模式外调用会被拒绝，并提示切换到 **能力进化**。
- 模式内：本地可复用、候选可修改、或候选尚未审完时同样拒绝创建。只有发现和审查都确认没有可用候选后，才发放一次 `scratch_ready`。技术性失败可重试，成功即消费；新的解析会撤销旧权限。
- `plugin.kind = "existing"`、普通文件编辑、命令、测试和既有插件修复不受这道门禁影响。门禁不把通用开发工具误判为插件创建。
- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，优先调用当前 Agent scope 内已有的 [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin)。若市场未安装，AutoEvo 在一次性批准后用脚本安装 `dsh-find-plugin` 并尽量热加载到当前进程；热加载失败才需要重启。不要审查市场插件，也不要直接用 `gh` 搜索。市场已装但没有相关候选时，视为没有可复用插件。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，实际 DSH 版本兼容，且 manifest 声明的 `dsh.bundle.patch` 在快照内可解析。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 临时试用在隔离 DSH home 中进行。验证需要真实的 `tool/call`、匹配的成功 `tool/result`，以及以 `turn/end: completed` 收口的最终回答；还可要求回答含精确预期文本。
- `partial` 候选先做最小修改并跑上游测试，再本地重审为 `full`，最后打成固定 tgz 安装。
- 当前任务完成后再建议向上游贡献。fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

安装并重启后，对当前 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_resolve`。如果当前 scope 还没有 `find_dsh_plugin`，批准后由 AutoEvo 用脚本安装并尽量热加载；热加载失败才需要重启。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_resolve` | 检查本地能力；需要时先复用 `find_dsh_plugin`；没有市场则申请批准并用脚本安装 | 只读 / 装市场时需批准 |
| `plugin_review` | 审查 GitHub exact commit 或 workspace 内的本地 Git 修改 | 只读 |
| `plugin_install` | 复核审查凭据、请求批准、安装已审查的包并做真实任务验证 | 需批准 |
| `plugin_remove` | 按 installation receipt 精确移除 | 需批准 |

AutoEvo 新增这四个高层工具，并在 DSH 工具执行边界上守卫 `cordis_define(kind:new)`；当前 Profile 的其余工具仍由其 Agent scope 决定。

## 基线

维护线 `0.2.0`。已验证：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 \|\| >=24`。审查回执记录实际 `dsh --version`；无法确认版本时不会授权安装。

```powershell
node --version
pnpm --version
gh auth status
pnpm check         # 完整门：静态检查、单测、Loader、local/adversarial/full/partial E2E
pnpm check:release # 完整门 + pack dry-run；发布前必须通过
```

设计见 [架构说明](docs/architecture.md)，安全门槛见 [安全模型](docs/security.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
