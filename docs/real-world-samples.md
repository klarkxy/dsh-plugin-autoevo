# AutoEvo 真实样例目录

[使用指南](user-guide.md) · [开发者指南](developer-guide.md) · [返回 README](../README.md)

这个目录把可重复的用户路径、前置夹具、成功证据和清理责任放在一起。它不是“功能已经上线”的清单：`real-live-passed` 只表示一次有可核验 DSH 会话证据的路径；`implemented` 表示仓库自动化覆盖；`planned` 仍需要真实环境验收。

执行时先复制对应的中文用户回合，不要把它们拼成一条自动批准指令。发现、选择、审查和最终 `use_this` / `modify_this` / `create_new` 决定仍须来自新的顶层用户回合。

## 最小推荐集

首次验证或演示时，按下列五组顺序走完即可覆盖最常见的复用、拒绝、安装、修复和创建决策：

1. `reuse-local-unchanged`
2. `stop-after-review`
3. `remote-verified-install`
4. `failed-install-repair`
5. `scratch-create-and-install`

其余三组覆盖已安装升级、状态不明的安装恢复，以及依赖用户真实客户端测试的运行面。

机器可读目录是 `tests/fixtures/real-world-samples.json`（当前 `schema_version: 1`，发布包不携带测试源码，GitHub 仓库中可查看），由 `tests/unit/real-world-samples.spec.ts` 校验；每个样例的完整中文回合、分类、夹具、证据及清理步骤均以 JSON 为准。样例不记录令牌、Cookie、完整私密日志或用户工作区路径。
