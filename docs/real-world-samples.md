# AutoEvo 真实样例目录

这个目录把可重复的用户路径、前置夹具、成功证据和清理责任放在一起。它不是“功能已经上线”的清单：`real-live-passed` 只表示一次有可核验 DSH 会话证据的路径；`implemented` 表示仓库自动化覆盖；`planned` 仍需要真实环境验收。

执行时先复制对应的中文用户回合，不要把它们拼成一条自动批准指令。发现、选择、审查和最终 `use_this` / `modify_this` / `create_new` 决定仍须来自新的顶层用户回合。

机器可读目录在 [`tests/fixtures/real-world-samples.json`](../tests/fixtures/real-world-samples.json)，由 [`tests/unit/real-world-samples.spec.ts`](../tests/unit/real-world-samples.spec.ts) 校验。

## 最小推荐集

首次验证或演示时，按下列五组顺序走完即可覆盖最常见的复用、拒绝、安装、修复和创建决策：

1. `reuse-local-unchanged`
2. `stop-after-review`
3. `remote-verified-install`
4. `failed-install-repair`
5. `scratch-create-and-install`

其余三组覆盖已安装升级、状态不明的安装恢复，以及依赖用户真实客户端测试的运行面。

## 样例总览

| ID | 用户目标 | 前置夹具 | 权威成功证据 | 清理 | 自动化状态 |
| --- | --- | --- | --- | --- | --- |
| `reuse-local-unchanged` | 找到本地能力后原样使用 | 本地候选 | `session-c4c5d09d-03ad-4c52-8657-a58c930db1d2` / `workflow_51eaaa4f1713af0e00890069` | 无安装物 | real-live-passed |
| `stop-after-review` | 审查后明确停止 | full review | `confirmation-gates` | 无 profile 变更 | implemented |
| `remote-verified-install` | 远端审查并安装 | 受控市场与 Host fixture | marketplace E2E | receipt 驱动移除 | implemented |
| `installed-upgrade-replacement` | 已装能力修改并替换 | 隔离 profile、冻结规格 | managed-installed-evolve-flow | 还原隔离 profile | implemented |
| `failed-install-repair` | 修复历史失败来源并首次安装 | `failed_absent` lineage | `session-af8d6384-6c1c-4b2a-af69-94c8044fae83` / `workflow_afb5a08eed8e5fa45dba77f4` / `installation_1d6f36d4c23346512e20e58f`，随后真实 `mcp__zhihu__search` 返回 2 条来源链接 | receipt 精确清理 | real-live-passed |
| `scratch-create-and-install` | 无候选时创建 | `create_authorized` 受管源码 | managed-create-flow | 释放 source lock | implemented |
| `sealed-install-failure-recovery` | 对账失败后的恢复 | failure/reconciliation receipt | install-outcomes | receipt 精确清理 | implemented |
| `manual-runtime-and-completed-restart` | 用户测试与重启后确认 | persistent manual runtime | 生命周期状态边界 | receipt 精确移除 | planned |

每个样例的完整中文回合、分类、夹具、证据及清理步骤均以 JSON 为准。样例不记录令牌、Cookie、完整私密日志或用户工作区路径。
