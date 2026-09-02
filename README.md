# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用工作流插件。在 **能力进化** preset 中，任何能力需求都先走 Search-first：先查本地与远程候选，能复用就不新建；候选只差一点时，可在托管源码中修改、重审后再安装。每个被采用的能力都有可检查的结果回执。

`Resolve → Search → Review → Deploy → Verify → Upgrade`

`Reuse before build. Improve before replace.`

## 文档

| 主题 | 入口 |
| --- | --- |
| 安装、首次使用、两道确认门、状态与恢复 | [使用指南](docs/user-guide.md) |
| 本地环境、源码入口、测试、调试与贡献 | [开发者指南](docs/developer-guide.md) |
| 状态机、数据布局和运行时接缝 | [架构说明](docs/architecture.md) |
| 信任边界、安装门槛和验证证据 | [安全模型](docs/security.md) |

每类内容只有一个权威出处。交互流程图（独立 HTML，可缩放、搜索与导出）：[主工作流](docs/assets/flowcharts/autoevo-main-workflow.html) · [安装结果状态机](docs/assets/flowcharts/autoevo-install-outcomes.html) · [托管施工](docs/assets/flowcharts/autoevo-managed-work.html)。在线浏览（GitHub Pages）：<https://klarkxy.github.io/dsh-plugin-autoevo/>。

## 安装

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.2.1
```

- `--profile web` 换成你实际使用的 profile；命令必须带 `@deepseek-ai/` 前缀（npm 上无 scoped 的 `dsh` 是无关项目）。
- 安装或升级后重启该 profile 加载新 bundle；日常启动：`npx @deepseek-ai/dsh web`。
- 要求 Node.js `^22.19.0 || ^24.0.0`，DSH `>=0.1.0-rc.6 <0.2.0`。

## 快速体验

1. 在 DSH 新建会话，选择用户 preset **能力进化**（id `evolution`）。
2. 用自然语言说明需要的能力，例如：

   > 我需要一个能同步项目记录的 DSH 插件。先查现成的。

3. AutoEvo 给出 1–5 个候选，或明确告知没有匹配。用一条新消息选择要审查的候选——这是第一道确认门。
4. 审查完成后，再用一条新消息决定：原样使用、安装、修改、继续搜索、从零创建或停止——这是第二道确认门。

完整流程见[使用指南 §3](docs/user-guide.md#3-第一次完整使用)，真实运行的逐步截图见 [`example/README.md`](example/README.md)。

[![AutoEvo 主工作流：Search-first 与两道确认门](docs/assets/flowcharts/autoevo-main-workflow.svg)](docs/assets/flowcharts/autoevo-main-workflow.html)

## 怎样理解结果

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| `verified` | Host 完成了预期工具往返，功能已验证 | 可以直接使用 |
| `activated` / `awaiting_user_test` | 已加载但无工具往返证据，或需人工测试 | 在目标 profile 中实际试用一次 |
| `restartRequired: true` | 已有非失败安装结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` / `recovery_required` | 安装失败，或状态不能安全判定 | 查看诊断；状态不明时先恢复，不要盲目重装 |

`installed` 或 `loaded` 不等于功能已验证，只有 `verified` 才能这样表述。完整状态说明见[使用指南 §5](docs/user-guide.md#5-结果状态与下一步)。

版本链工具：`capability_versions` 列出版本，`capability_rollback` 回滚到历史版本，`capability_adopt` 登记手工安装的插件，`capability_updates` 只读检查上游更新。详见[使用指南 §4.6](docs/user-guide.md#46-版本领养与上游更新)。

普通工作流、项目权限、插件/Profile 或 DSH 宿主故障仍然阻止任务完成时，AutoEvo 还可以提出一次完整权限故障修理。用户在新的消息中明确确认后，Host 会启动临时 `standard` Agent，应用官方 `danger-full-access` 预设并取消逐条命令审批；它可以跨项目、插件、Profile 和宿主环境自主施工，不受预定义修复动作限制。详见[使用指南](docs/user-guide.md#完整权限故障修理模式)。

## 安全边界

AutoEvo 负责工作流、警告和证据记录；权限、sandbox 与 approval 的强制执行属于 DSH Core。默认流程保持只读或受管边界；完整权限故障修理也通过 DSH Core 的官方权限预设实施，并要求新的用户确认。安装或修理的代码最终以当前用户权限运行。完整信任边界见[安全模型](docs/security.md)。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm check:fast
```

详见[开发者指南](docs/developer-guide.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
