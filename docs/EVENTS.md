# 事件映射

本插件定义 10 个**规范事件**，把每种 harness 的事件名映射到它们，再把它们绑定到 dsh 的扩展点。

## 规范事件 ↔ 各方言事件名

| 规范事件 | claude | codex | opencode | 含义 |
| --- | --- | --- | --- | --- |
| `session:start` | `SessionStart` | `SessionStart` | `session.created` | 会话开始/恢复 |
| `session:end` | `SessionEnd` | `SessionEnd` | `session.deleted` | 会话结束 |
| `prompt:submit` | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` | 用户提示词提交后、处理前 |
| `tool:before` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | 工具执行前 |
| `tool:after` | `PostToolUse` / `PostToolUseFailure` | `PostToolUse` | `tool.execute.after` | 工具执行后（成功/失败） |
| `turn:stop` | `Stop` | `Stop` | `session.idle` | 模型回合想要结束 |
| `subagent:start` | `SubagentStart` | `SubagentStart` | `tool.execute.before.subagent` | 子代理启动 |
| `subagent:end` | `SubagentStop` | `SubagentStop` | `tool.execute.after.subagent` | 子代理结束 |
| `notice` | `Notification` | `Notification` | `notification` | 通知 |
| `compact:before` | `PreCompact` | —（无对应） | `experimental.session.compacting` | 上下文压缩前 |

dsh 扩展点绑定与行为：

| 规范事件 | dsh 扩展点 | 行为 |
| --- | --- | --- |
| `session:start` | `agent/session-start`（emit） | 后台执行；hooks 产出的上下文经 `agent.inject` 注入 |
| `session:end` | `session/disposed`（emit） | 后台执行，仅观察 |
| `prompt:submit` | `agent/pre-step`（waterfall） | 拒绝 → `{kind:'reject'}`；上下文追加进 enter 的 messages |
| `tool:before` | `tools/pre-execute`（waterfall） | 拒绝 → `{kind:'deny', reason}`；ask → `{kind:'ask'}` |
| `tool:after` | `tools/post-execute`（waterfall） | 拒绝 → `{kind:'block', feedback}`；上下文随结果折叠 |
| `turn:stop` | `agent/turn-stopping`（serial） | 拒绝 → `agent.steer(...)` 强制继续 |
| `subagent:start` | `subagent/start`（emit） | 后台执行；上下文注入子代理 |
| `subagent:end` | `subagent/end`（emit） | 后台执行，仅观察 |
| `notice` / `compact:before` | 无原生扩展点 | 经 stdio 协议或 CLI 手动触发 |

## 可阻塞性

| 规范事件 | blockable | contextFromStdout |
| --- | --- | --- |
| `session:start` | 否 | 是 |
| `session:end` | 否 | 否 |
| `prompt:submit` | 是 | 是 |
| `tool:before` | 是 | 否 |
| `tool:after` | 否 | 否 |
| `turn:stop` | 是 | 否 |
| `subagent:start` | 否 | 是 |
| `subagent:end` | 否 | 否 |
| `notice` | 否 | 否 |
| `compact:before` | 否 | 是 |

- **blockable**：该事件上 handler 的「拒绝」能真正阻止动作。不可阻塞事件（如 `notice`、`session:start`）上出现的 deny 会被降级为 `none`，并标记 `outcome.downgraded = true`，原始拒绝保留在 `outcome.rawDecision` / `outcome.rawReason`
- **contextFromStdout**：该事件上 handler 的**纯文本 stdout** 会被当作上下文收集（与 `additionalContext` 一起注入）。例如 `SessionStart` hook 输出 git 状态即可直接进入模型上下文
- `tool:after` 的拒绝不能阻止已执行的工具；在 dsh 的 `tools/post-execute` 扩展点上它映射为**结果替换**（`{kind:'block', feedback}`，把拒绝原因作为反馈写回工具结果），其他宿主上降级为 `none`

## matcher 语义

| 方言 | 模式 | 说明 |
| --- | --- | --- |
| claude / native | 字面量 | 任意字符串按 `,`/`|`（含其后空白）拆分为精确交替项，逐项精确比对（支持含 `-`、空格及非 ASCII 的工具名） |
| codex / opencode | 正则 | 非空模式一律按未锚定正则 |

- 缺失、空串、`*`：匹配全部
- 非法正则（regex 方言）：配置校验报错；运行期匹配一律不命中（安全失败）
- 多拼写 canonical：claude 的 `tool:after` 有 `PostToolUse` 与 `PostToolUseFailure` 两个触发点，二者**互斥**——按哪个拼写分派就只运行该拼写配置的组（按 canonical 名 `tool:after` 分派则运行全部）
- matcher 主体：`tool:before`/`tool:after` 取工具名；`session:start` 取会话来源；`session:end` 取结束原因（dsh 侧暂不携带结束原因，配置了具体 reason 的 matcher 在 dsh 下不命中，match-all 仍生效）；`subagent:*` 取 `agent_type`（dsh 侧恒为 `general-purpose`，与 harness 子代理默认一致）；其余事件无主体（写了 matcher 会得到警告并被丢弃）

## 载荷（stdin JSON 契约）

见 [CONTRACT.md](CONTRACT.md#stdin-json-契约)。要点：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode` 为基础字段；工具事件加 `tool_name`/`tool_input`/`tool_use_id`（`tool:after` 还有 `tool_response`）；`prompt:submit` 加 `prompt`；子代理事件加 `agent_id`/`agent_type`；`turn:stop` 与 `subagent:end` 加 `stop_hook_active`。
