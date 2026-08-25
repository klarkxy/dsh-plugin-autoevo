# AutoEvo

[English](README.en.md) | 中文

> 进化永不停歇。

<p align="center">
  <img src="docs/assets/kanban.png" alt="AutoEvo" width="420">
</p>

`dsh-plugin-autoevo` 是 DeepSeek Harness（DSH）的能力复用与安全演进插件。在 **能力进化** preset 中，所有能力需求——包括临时实验——都先走 Search-first：Host 保留用户原话，必要时只澄清一次，然后检查本地与远程真实候选。候选只差一点时，可在 Host 绑定的托管源码中修改、重审和安装；用户最终采用的能力统一持久化。

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

安装到正在使用的 DSH profile；下面以 `web` 为例（通过 npx 运行 DSH，无需全局安装）：

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

日常启动该 profile 用 `npx @deepseek-ai/dsh web`。注意 npm 上无 scoped 的 `dsh` 包是无关项目，命令必须带上 `@deepseek-ai/` 前缀。

安装或升级后重启对应的 DSH profile，让它加载新 bundle；之后为其它能力执行安装时是否需要再次重启，见[使用指南 §5](docs/user-guide.md#5-结果状态与下一步)。

安装命令使用最新发布 tag；仓库 `package.json` 中的版本号可能领先于最新发布版。Node.js 要求 `>=22.19.0 || >=24.0.0`；当前开发与验收基于 DSH `0.1.1-rc.2`、Cordis `4.0.1`。

## 快速体验

1. 在 DSH 新建会话，选择用户 preset **能力进化**（id `evolution`）。
2. 用自然语言说明需要的能力，例如：

   > 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

3. 需求有实质歧义时，先回答一次澄清；随后 AutoEvo 给出 1–5 个候选，或明确告知没有匹配候选。
4. 有候选时，用新的正常聊天消息选择要审查的候选；无候选时，选择继续搜寻、创建新能力或停止。
5. 审查完成后，再用一条新的消息决定原样使用、安装、修改、继续搜索、从零创建或停止。

这两次回复是两道独立的用户确认门；完整流程与原理见[使用指南 §3](docs/user-guide.md#3-第一次完整使用)。

安装演示（选择 preset → 描述需求 → 候选短名单 → 审查 → 确认 → 已安装）：

<p align="center">
  <img src="example/install/01-select-evolution.png" alt="选择能力进化 preset" width="320">
  <img src="example/install/02-ask.png" alt="描述需求" width="320">
  <img src="example/install/03-shortlist.png" alt="候选短名单" width="320">
  <img src="example/install/04-review.png" alt="审查结果" width="320">
  <img src="example/install/05-confirm.png" alt="确认安装" width="320">
  <img src="example/install/06-installed.png" alt="已安装" width="320">
</p>

## 怎样理解结果

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| `verified` | Host 完成了预期工具往返，功能已验证 | 可以直接使用 |
| `activated` / `awaiting_user_test` | 已加载但没有工具往返证据，或需在真实客户端/profile 中人工测试 | 在目标 profile 中实际试用一次 |
| `restartRequired: true` | 安装已形成非失败结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` / `recovery_required` | 安装失败，或安装/清理状态不能安全判定 | 查看诊断；状态不明时先恢复，不要盲目重装 |

`installed` 或 `loaded` 不等于功能已验证；只有 `verified` 才能这样表述。完整状态和恢复步骤见[使用指南](docs/user-guide.md#5-结果状态与下一步)。

AutoEvo 还跟踪每个包的安装版本链：`capability_versions` 列出版本，`capability_rollback` 回滚到历史版本（仍走标准批准安装），`capability_adopt` 把工作流外手工安装的插件登记入台账，`capability_updates` 只读检查上游更新。详见[使用指南 §4.6](docs/user-guide.md#46-版本领养与上游更新)。

## 安全边界

- 发现、审查和诊断默认只读；安装、移除、修改和新建需要真实用户决定，副作用还需 DSH 一次性批准；安装的第三方代码最终以当前用户权限运行。
- 完整信任边界见[安全模型](docs/security.md)；使用中的安全与隐私注意事项见[使用指南 §8](docs/user-guide.md#8-安全与隐私提示)。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm check
```

源码、生成的 `lib/`、测试矩阵和发布前检查见[开发者指南](docs/developer-guide.md)。

## 许可

SATA，见 [LICENSE](./LICENSE)。
