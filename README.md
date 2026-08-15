# AutoEvo

> 进化永不停歇。

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）里的能力复用与安全演进层。Agent 需要新能力时，先核对本地工具与技能，再搜索、审查、试用和改进已有 DSH 插件。

`Local Resolve → GitHub Search → Review → Approved Trial → Verify → Reuse / Improve`

`Reuse before build. Improve before replace.`

## 维护状态

当前维护线是 `0.1.0`。已验证运行基线：DSH `0.1.0-rc.6`、Cordis `4.0.1`、Node.js `>=22.19.0 || >=24`。包管理、Git 协作和代码修改继续走 DSH、pnpm、`git`、`gh` 与当前 Agent。

## 工作方式

- 先看当前 Agent 可见的 tools、model-invocable skills，以及已有 `tool_search` 桥能到达的工具。
- 本地能力不够时，用已认证的 `gh` CLI 做有界 GitHub 搜索，再由 Agent rerank。
- 审查精确 commit 上的 manifest、README 和必要源码，只输出路径、派生事实、风险代码与内容 hash。系统提示只含本插件固定策略。
- 安装门槛：`full + use`、风险 `low` 或 `medium`、兼容性 `compatible` 或 `unknown`、manifest 精确声明 `dsh.bundle.patch`。
- 安装前按审查材料再核对一遍；commit、blob 或 manifest 变化会使凭据过期。
- 安装和移除都走 DSH 一次性批准 `allowed-once`。
- 临时试用落在插件自有的隔离 DSH home/profile。验证看真实 `tool/call`、匹配的成功 `tool/result` 和任务结果。
- `partial` 候选先在 workspace 里最小修改、跑上游测试，再本地重审为 `full`。批准后复制为 owned snapshot，用 `npm pack --ignore-scripts` 打成固定 tgz 再安装。
- 通用修改在任务完成后给出贡献建议。fork、push 与 PR 由现有 Git / `gh` 能力在用户再次批准后执行。

## 前置条件

```powershell
node --version
pnpm --version
gh auth status
```

GitHub 搜索与审查需要可用的 `gh` 认证。本仓库把 `@deepseek-ai/dsh@0.1.0-rc.6` 钉在 devDependency 里，用 `pnpm exec dsh` 即可。

## 安装本插件

```powershell
dsh plugin --profile <profile> add github:klarkxy/dsh-plugin-autoevo
```

本仓库开发安装：

```powershell
pnpm install
pnpm build
pnpm exec dsh plugin --profile <profile> add --save-exact link:E:/absolute/path/dsh-plugin-autoevo
```

`link:` 只用于本仓库这份可信 checkout。第三方候选一律物化为 owned `file:...tgz`。

DSH 在进程启动时确定 bundle 集合。常驻 Profile 装好后，新进程加载新 bundle；当前进程会收到 `restartRequired: true`。临时验证由插件拉起隔离子进程。

## Agent 工具

| 工具 | 作用 | 环境 |
|---|---|---|
| `capability_resolve` | 检查本地能力；需要时搜索 GitHub 候选摘要 | 只读 |
| `plugin_review` | 审查 GitHub exact commit 或 workspace 内的本地 Git 修改 | 只读 |
| `plugin_install` | 复核审查凭据、请求批准、物化安装包并做真实任务验证 | 需批准 |
| `plugin_remove` | 按 installation receipt 精确移除 | 需批准 |

模型只看到这四个工具。`verificationPatchPaths` 和凭据环境变量白名单留在管理员配置里。

## 安全

第三方 README、源码、注释和 manifest 按不可信数据处理。审查结果是派生事实、风险代码与内容 hash。进程请求用 argv 数组发出。Windows 上 DSH rc.6 会经 shell 转发 pnpm 参数，安装 spec 只接受通过元字符校验的值。GitHub 安装钉死 exact commit；输出、文件数、读取字节和执行时间都有上限。

隔离 DSH home 提供配置与依赖隔离。获准安装的包以当前用户权限运行，生命周期脚本名和派生风险会出现在批准理由里。风险为 `high` 的候选停在审查阶段。详见 [安全模型](docs/security.md)。

临时安装需要带内容的 `verification_task`。安装前先写 provisional receipt，外部命令成功后即使最终状态写入失败，也留有 `installationId` 供清理。

## 门禁

```powershell
pnpm check
pnpm test:e2e
pnpm pack --dry-run
```

`pnpm test:e2e` 依次覆盖：

1. 本地能力已足够时，解析在本地结束。
2. live GitHub full-fit：搜索、审查、隔离安装、真实 calculator 调用与清理。
3. live GitHub partial-fit：exact checkout、科学计数法最小补丁、上游测试、本地重审、真实 `1e3 + 2` 调用与清理。

后两项需要网络和 `gh` 认证。设计见 [架构说明](docs/architecture.md)。

## 维护

改行为时同步更新 `src/`、本 README、[架构说明](docs/architecture.md) 和 [安全模型](docs/security.md)，再跑完整门禁。提升 DSH 基线时，同时改 `package.json` 里的 `@deepseek-ai/dsh*` 版本、本文的运行基线，以及 Loader / E2E 仍能通过的证明。

## 许可

SATA，见 [LICENSE](./LICENSE)。
