# 契约

本页定义三层契约：handler 收到的 **stdin JSON**、handler 返回的**响应契约**（退出码 + stdout JSON）、以及多 handler 结果如何**折叠**。另附 stdio 协议与本地 mock LLM 说明。

## stdin JSON 契约

所有 handler 通过 stdin（`command`/`agent`/`subagent`）或 POST body（`http`）收到同一份 JSON，末尾带一个换行（claude 方言行为）。

基础字段：

| 字段 | 含义 |
| --- | --- |
| `session_id` | 会话 id（无会话时为空串） |
| `transcript_path` | 会话记录文件路径（宿主未暴露时为空串） |
| `cwd` | 会话工作目录 |
| `hook_event_name` | 触发事件在**该方言**下的名字（如 `PreToolUse`） |
| `permission_mode` | 恒为 `default` |

事件字段：

| 规范事件 | 附加字段 |
| --- | --- |
| `tool:before` | `tool_name`、`tool_input`、`tool_use_id` |
| `tool:after` | 上述 + `tool_response`（工具结果的纯文本） |
| `prompt:submit` | `prompt`（用户提示词文本） |
| `session:start` | `source`（会话来源） |
| `turn:stop` | `stop_hook_active`（恒 `false`） |
| `subagent:start` | `agent_id`、`agent_type` |
| `subagent:end` | `agent_id`、`agent_type`、`stop_hook_active` |

native 方言的载荷是信封形式：`{ "event": "tool:before", "ts": "<ISO 时间>", ... 上述同名字段 }`。

## 响应契约

### 退出码

| 退出码 | 含义 | 效果 |
| --- | --- | --- |
| `0` | 成功 | stdout 若为 JSON 对象则解析决策字段；纯文本在 `contextFromStdout` 事件上作为上下文 |
| `2` | 拒绝 | 阻断动作；`stderr` 作为原因（无 stderr 时用默认文案） |
| 其他非零 | 非阻塞错误 | 记日志（warn），动作照常进行 |
| （进程被杀/无法启动） | 基础设施失败 | 视为非阻塞错误；`onError: "block"` 可升级为拒绝 |

### stdout JSON 字段

仅退出码 `0` 且 stdout 以 `{` 开头时解析；解析失败视为纯文本。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `decision` | `"approve"` / `"block"` | 旧式顶层决策 |
| `reason` | string | 顶层决策的原因 |
| `continue` | boolean | `false` 表示请求停止（配合 `stopReason`） |
| `stopReason` | string | 停止原因 |
| `systemMessage` | string | 面向用户的警告 |
| `additionalContext` | string | 追加进模型上下文的文本 |
| `hookSpecificOutput.hookEventName` | string | 声明本块所属事件；与触发事件不符时丢弃整个 `hookSpecificOutput`（顶层字段仍生效） |
| `hookSpecificOutput.permissionDecision` | `"allow"` / `"deny"` / `"ask"` | 结构化决策（覆盖顶层 `decision`） |
| `hookSpecificOutput.permissionDecisionReason` | string | 结构化决策的原因 |
| `hookSpecificOutput.additionalContext` | string | 追加上下文 |
| `hookSpecificOutput.updatedInput` | object | 工具入参改写请求（当前解析但不执行，记日志警告） |

### oracle 应答

oracle handler 要求 LLM 端点在 `choices[0].message.content` 返回一个 JSON 对象：

```json
{ "ok": false, "reason": "不允许执行" }
```

- `ok: false` → 拒绝（原因取 `reason`，缺省 `denied by evaluation`）
- `ok: true` → 放行
- 其余字段（`decision`、`continue`、`hookSpecificOutput` 等）同样按上表生效
- 非 JSON 应答 / HTTP 非 2xx / 超时 → 非阻塞错误

## 折叠规则

同一事件上命中的多个 handler 按配置顺序执行，结果合并为唯一决策：

1. **决策优先级**：`deny > ask > allow`（`block`/`deny` 与 `approve`/`allow` 分别等价）；获胜等级的原因用空行连接
2. **停止**：任一 `continue:false` 即停，取第一个的 `stopReason`
3. **上下文**：各 handler 的 `additionalContext` + `contextFromStdout` 事件的纯文本 stdout，按执行顺序累加
4. **消息**：`systemMessage` 按顺序累加
5. **可阻塞性**：不可阻塞事件上的 deny 降级为 `none`（`outcome.downgraded = true`），原始拒绝保留在 `outcome.rawDecision` / `outcome.rawReason`，供需要"已执行动作的反馈语义"的宿主使用（如 dsh 的 `tools/post-execute` 把拒绝写回为结果反馈）

## 超时与降级

- 超时解析：`hook.timeout` > 插件配置 `timeoutSec` > kind 默认（shell/webhook 600s、oracle 30s、proxy 60s）
- 超时到达时**强杀整个进程树**（Windows 用 `taskkill /T /F`），防止脚本孙进程残留
- 宿主传入的取消信号（AbortSignal）同样生效：宿主中止（如 dsh 插件卸载、回合取消）时立即强杀进程树 / 中止请求
- 基础设施失败（spawn 失败、超时、HTTP 非 2xx、oracle/proxy 未配置）按 `onError` 策略处理：`warn`（默认，记日志继续）/ `block`（升级为拒绝）/ `ignore`（静默）

## stdio 协议（listen 模式）

`node lib/index.js listen` 提供行分隔 JSON 协议（stdin 进、stdout 出，日志走 stderr）：

| 请求 | 响应 |
| --- | --- |
| `{"op":"ping"}` | `{"ok":true,"pong":true}` |
| `{"op":"dispatch","event":"PreToolUse","payload":{...},"subject":"Bash","cwd":"/w"}` | `{"ok":true,"canonical":"tool:before","outcome":{...},"runs":[{hook,outcome,durationMs}]}` |
| `{"op":"reload"}` | `{"ok":true,"diagnostics":[...]}` |
| `{"op":"bye"}` | `{"ok":true}` 后退出 |

`subject` 省略时从 payload 推导（`tool_name`/`tool`/`name`）。错误响应统一为 `{"ok":false,"error":"..."}`。

任意宿主（脚本、CI、其他 harness）都能用这个协议驱动本运行时，而无需依赖 dsh。

## 本地 mock LLM

oracle handler 依赖 LLM 端点（OpenAI 兼容的 `POST {baseUrl}/chat/completions`）。仓库提供本地可运行的 mock：

```sh
node examples/mock-llm.mjs --port 8765
# 插件配置：llm: { baseUrl: "http://127.0.0.1:8765/v1", model: "mock" }
```

mock 的行为：提示词含 `DENY` 时回答 `{"ok":false,"reason":"mock denied"}`，否则 `{"ok":true}`——足以离线验证 oracle 的接线与折叠。
