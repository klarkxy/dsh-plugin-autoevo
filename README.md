# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用与安全演进插件。Agent 需要新能力时，先检查本地已有工具和技能，再搜索、审查、部署社区插件，并在候选只差一点时改进后继续使用。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## 安装

```powershell
dsh plugin --profile web add github:klarkxy/dsh-plugin-autoevo
```

安装后重启对应 DSH 进程。bundle 在进程启动时加载。

本仓库开发安装：

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile web add --save-exact "link:<absolute-path-to-this-repo>"
```

`link:` 只用于本仓库这份可信 checkout。第三方候选会物化为 owned `file:...tgz`。

## 工作方式

- 先检查当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不足时，用已认证的 `gh` 做有界 GitHub 搜索，再由 Agent rerank。发现入口是 `dsh-plugin` topic。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。
- 安装条件：`full + use`，风险 `low` 或 `medium`，兼容性 `compatible` 或 `unknown`，manifest 精确声明 `dsh.bundle.patch`。
- 安装和移除都需要 DSH 一次性批准 `allowed-once`。
- 临时试用在隔离 DSH home 中进行。验证需要真实的 `tool/call`、匹配的成功 `tool/result` 和任务结果。
- `partial` 候选先做最小修改并运行上游测试，再本地重审为 `full`，然后打成固定 tgz 再安装。
- 通用修改在当前任务完成后给出贡献建议。fork、push 与 PR 仍由现有 `git` / `gh` 在用户再次批准后执行。

## 试用

```powershell
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

打开 http://127.0.0.1:3080 ，在设置中填写 API Key。另开终端安装 AutoEvo，重启 Web，然后对 Agent 说：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

它应先调用 `capability_resolve`。GitHub 搜索使用本机已登录的 `gh`。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_resolve` | 检查本地能力；需要时搜索 GitHub 候选摘要 | 只读 |
| `plugin_review` | 审查 GitHub exact commit 或 workspace 内的本地 Git 修改 | 只读 |
| `plugin_install` | 复核审查凭据、请求批准、物化安装包并做真实任务验证 | 需批准 |
| `plugin_remove` | 按 installation receipt 精确移除 | 需批准 |

模型只看到这四个工具。

## 基线

维护线 `0.1.0`。已验证：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 \|\| >=24`。

```powershell
node --version
pnpm --version
gh auth status
pnpm check
```

设计见 [架构说明](docs/architecture.md)，安全门槛见 [安全模型](docs/security.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
