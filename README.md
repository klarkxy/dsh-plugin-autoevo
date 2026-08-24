# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用与安全演进插件。能力进化 preset 是官方创造模式的超集：创造模式已有的运行时检查、活进程插件实验、preset 创作和委托工具都在。Agent 需要可复用的新能力时，AutoEvo 先检查本地工具和技能，再发现、审查并安装社区插件；候选只差一点时，可以在 Host 托管源码上完成修改、重审和安装。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## 文档

| 读者 / 主题 | 入口 |
| --- | --- |
| 使用者：安装、首次使用、两道确认门、状态与恢复 | [使用指南](docs/user-guide.md) |
| 开发者：本地环境、架构入口、测试、调试与贡献 | [开发者指南](docs/developer-guide.md) |
| Policy、数据布局和运行时接缝 | [架构说明](docs/architecture.md) |
| 信任边界、安装门槛和验证证据 | [安全模型](docs/security.md) |
| 可重复用户路径及其证据等级 | [真实样例目录](docs/real-world-samples.md) |

详细文档遵循单一权威原则：操作步骤以使用指南为准，开发流程以开发者指南为准，内部状态与安全不变量分别以架构和安全文档为准。

## 安装

安装到正在使用的 DSH profile；下面以 `web` 为例：

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

安装或升级 AutoEvo 后，重启对应的 DSH profile，让它加载新 bundle。AutoEvo 运行后为其它能力执行安装时，才会通过结果中的 `restartRequired: true` 告诉你是否需要再次重启目标 profile。

当前可安装发布版为 `v0.5.1`；仓库中的 `0.5.3` 是尚未发布的下一版本。Node.js 要求 `>=22.19.0 || >=24.0.0`；当前开发与验收基于 DSH `0.1.0-rc.6`、Cordis `4.0.1`。

## 快速体验

1. 在 DSH 新建会话，选择用户 preset **能力进化**（id `evolution`）。
2. 用自然语言说明需要的能力，例如：

   > 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

3. AutoEvo 给出 1–5 个候选后，用新的正常聊天消息选择要审查的候选。
4. 审查完成后，再用一条新的消息决定原样使用、安装、修改、继续搜索、从零创建或停止。

这两次用户回复是两道独立确认门。DSH 的一次性 approval 只批准具体副作用，不能替代候选选择或最终决定。自然语言即可，不需要背内部 action 名称。

## 怎样理解结果

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| `verified` | Host 完成了预期工具往返，功能已验证 | 可以直接使用 |
| `activated` | bundle 已加载，但没有工具往返证据 | 在目标 profile 中实际试用 |
| `awaiting_user_test` | 该能力必须在真实客户端或 profile 中人工测试 | 按提示试用一次 |
| `restartRequired: true` | 安装已形成非失败结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` | 安装失败，且 Host 证明目标不存在 | 查看诊断，再决定是否重试 |
| `recovery_required` | 安装状态或清理状态不能安全判定 | 先走恢复，不要盲目重装 |

`installed` 或 `loaded` 不等于功能已验证；只有 `verified` 才能这样表述。完整状态和恢复步骤见[使用指南](docs/user-guide.md#5-结果状态与下一步)。

## 安全边界

- 发现、审查和诊断默认只读；安装、移除、修改和新建需要真实用户决定，副作用还需要 DSH 一次性批准。
- 修改和创建发生在当前能力进化会话可见的 Host 托管 Git 源中，不会启动隐藏子 Agent，也不会回退到 `code`。
- Windows sandbox 是完整性导向的部分隔离，不是凭据、网络或恶意代码的机密性沙箱；安装的第三方代码最终仍以当前用户权限运行。
- 弱模型可能把自然语言理解成另一个合法动作或候选。能力进化应搭配可靠的指令遵循、上下文保持和结构化工具调用能力。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm check
```

源码、生成的 `lib/`、测试矩阵和发布前检查见[开发者指南](docs/developer-guide.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
