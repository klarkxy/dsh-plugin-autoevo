# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用与安全演进插件。Agent 需要新能力时，先检查本地已有工具和技能，再搜索、审查、部署社区插件，并在候选只差一点时改进后继续使用。对动态 Cordis 插件入口，AutoEvo 会在工具执行层强制执行这条顺序。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## 安装

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.2
```

安装后重启对应 DSH 进程。bundle 在进程启动时加载。

升级到新的已发布版本时，显式替换 tag 后重新执行安装命令，例如：

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.1.2
```

DSH 的 `plugin` 命令把依赖操作转交给 pnpm：registry semver、Git tag 和 exact commit 都能作为版本边界，但 DSH 不会自动追踪或热加载新版本。固定 tag/commit 后需要显式升级，并重启对应进程。

本仓库开发安装：

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` 只用于本仓库这份可信 checkout。第三方候选会物化为 owned `file:...tgz`。

## 能力进化模式

安装 AutoEvo 后，默认会把用户 Agent preset **能力进化**（id `evolution`，描述「先复用，再改进，最后才创建」）安全地物化到 `<dshHome>/.agent-presets/evolution`。配置项 `evolutionPreset` 默认为 `true`；设为 `false` 时跳过安装/升级，但**不会**自动删除已有 preset。

该目录属于 DSH 的用户 preset 根，因此 UI 会把它标记为**自定义**、trust 为 `user`；它不是内置系统模式。首次安装或升级后必须重启对应 DSH 进程。AutoEvo 只会升级内容与包内已知历史 manifest 完全一致的受管版本；用户改过文件、manifest、文件集合，或已有同名外国目录时一律保留并记录警告，不覆盖、不删除。

在空白/新会话中把 Agent 切换到 **能力进化**，即可进入受托管的动态创建路径：preset 挂载 `dsh-plugin-autoevo/evolution-mode`，注册 `autoevo-plugin-creator` 技能，并在 isolate realm 内发布 `autoevoEvolutionMode` 标记。仅当 `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 返回该标记时，AutoEvo 才承认当前 Agent 处于真·能力进化模式；preset id 本身不是授权依据。

官方 **创造模式 / Creator** 仍用于既有插件修复与静态开发；AutoEvo **不会**在全局替换 `cordis-plugin-development` 技能。

卸载 AutoEvo 前，先在 DSH 的 Agent preset 管理界面移除 **能力进化**，再移除插件依赖并重启。仅把 `evolutionPreset` 设为 `false` 不会删除现有目录。

## 工作方式

- 带 Agent 身份的 `cordis_define`（`plugin.kind = "new"`）只在真·能力进化模式下放行，且必须先经过 `capability_resolve`。模式外调用会收到可操作的拒绝提示，引导切换到能力进化。模式内：本地可复用、候选可修改或候选尚未审完时都会被拒绝；只有完整发现和审查确认无可用候选后，才向当前 Agent 发放一次 `scratch_ready` 成功创建权限。技术性失败可重试，成功即消费；新解析会撤销旧权限。
- `plugin.kind = "existing"`、普通文件编辑、命令、测试和既有插件修复不受这道门禁影响。门禁不把通用开发工具误判为插件创建。
- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，优先调用当前 Agent scope 内已有的 [`find_dsh_plugin`](https://github.com/awesome-dsh-plugin/dsh-find-plugin)；它缺失、失败或没有有效结果时，才用已认证的 `gh` 做有界 GitHub 搜索。两条发现路径都从 `dsh-plugin` topic 取候选，再由 Agent rerank。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，实际 DSH 版本兼容性为 `compatible`，manifest 精确声明且快照内存在可解析的 `dsh.bundle.patch`。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 临时试用在隔离 DSH home 中进行。验证需要真实的 `tool/call`、匹配的成功 `tool/result`，以及会话中以 `turn/end: completed` 收口的最终回答；还可要求回答包含精确预期文本。
- `partial` 候选先做最小修改并运行上游测试，再本地重审为 `full`，然后打成固定 tgz 再安装。
- 通用修改在当前任务完成后给出贡献建议。fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

安装并重启后，对当前 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_resolve`。如果当前 scope 安装并开放了 `find_dsh_plugin`，AutoEvo 会优先复用它；否则 GitHub 搜索使用本机已登录的 `gh`。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_resolve` | 检查本地能力；需要时先复用 `find_dsh_plugin`，再降级到内置 `gh` 候选搜索 | 只读 |
| `plugin_review` | 审查 GitHub exact commit 或 workspace 内的本地 Git 修改 | 只读 |
| `plugin_install` | 复核审查凭据、请求批准、物化安装包并做真实任务验证 | 需批准 |
| `plugin_remove` | 按 installation receipt 精确移除 | 需批准 |

AutoEvo 新增这四个高层工具，并监听 DSH 工具执行边界来保护 `cordis_define(kind:new)`；当前 Profile 的其他工具仍由其 Agent scope 决定。

## 基线

维护线 `0.1.2`。已验证：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 \|\| >=24`。审查回执记录实际 `dsh --version`；无法确认版本时不会授权安装。

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
