# 接入说明（dsh）

dsh（DeepSeek Harness）是 Cordis 插件系统上的「一切皆插件」harness：插件是导出 `apply(ctx, config)` 的模块，通过 `package.json` 的 `dsh.bundle` 声明一个配置层（`cordis.patch.yml`），装入 profile 后由 loader 挂载。

## 包结构

```
package.json        # dsh.bundle.patch 指向 cordis.patch.yml；main 指向 dsh/plugin.js
cordis.patch.yml    # 组合包层：插入插件行
dsh/plugin.js       # 插件模块：export const name / inject / apply
lib/                # 运行时核心（纯 Node，无依赖，可独立使用）
```

`package.json` 关键字段：

```json
{
  "name": "hooks-adapter",
  "type": "module",
  "main": "./dsh/plugin.js",
  "exports": { ".": "./dsh/plugin.js", "./cli": "./lib/index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: hooks-adapter
      name: hooks-adapter
      config:
        discover: true
```

## 安装

```sh
# 在包含本插件 checkout 的目录执行（相对路径会锚定到调用目录）
dsh plugin --profile demo add ./hooks-adapter
dsh --profile demo --dump-config   # 可见 "# == hooks-adapter" 层
dsh --profile demo
```

也可以发布到 npm 后 `dsh plugin add hooks-adapter`。本插件是纯 JS、无构建步骤，git 安装不需要 `prepare` 脚本授权。

## 插件配置行

`apply(ctx, config)` 收到的 `config`（默认值见下）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `discover` | `true` | 自动发现标准位置的 hooks 配置 |
| `configPath` | — | 固定使用单个文件（跳过发现） |
| `cwd` | 进程 cwd | 发现用的工作目录 |
| `homeDir` | 用户主目录 | 发现用的 home |
| `projectDir` | — | `${CLAUDE_PROJECT_DIR}` 替换值 + 注入子进程的环境变量 |
| `pluginRoot` | — | `${CLAUDE_PLUGIN_ROOT}` 替换值 |
| `llm` | — | `{ baseUrl, model, apiKey? }`，oracle handler 的端点 |
| `proxy` | — | `{ command }`，proxy handler 的默认 runner 命令 |
| `timeoutSec` | — | 全局超时覆盖（秒） |
| `onError` | `warn` | 全局失败降级策略 |
| `stderrCap` | `500` | `hook/result` 记录中 stderr 摘要的字符上限 |

配置行可被上层 `cordis.patch.yml` 按行 id 整体替换（dsh 的 patch 语义是整行替换 config，不深度合并）。

## 事件订阅与决策映射

插件订阅 dsh 扩展点，把事件映射到 hooks 事件（详见 [EVENTS.md](EVENTS.md)），把折叠后的决策映射回扩展点的返回形状：

| dsh 事件 | 模式 | 映射 | 决策返回 |
| --- | --- | --- | --- |
| `agent/session-start` | emit | `SessionStart` | 上下文 → `agent.inject(userMessage)` |
| `session/disposed` | emit | `SessionEnd` | 仅观察 |
| `agent/pre-step` | waterfall | `UserPromptSubmit` | deny → `{kind:'reject'}`；上下文追加进 enter 的 messages |
| `tools/pre-execute` | waterfall | `PreToolUse` | deny → `{kind:'deny', reason}`；ask → `{kind:'ask', reason?}`；否则 `next()` |
| `tools/post-execute` | waterfall | `PostToolUse` / `PostToolUseFailure`（按 `result.isError`） | deny → `{kind:'block', feedback}`；上下文随结果折叠；否则 `next()` |
| `agent/turn-stopping` | serial | `Stop` | deny → `agent.steer(userMessage(reason))` |
| `subagent/start` | emit | `SubagentStart` | 上下文注入子代理 |
| `subagent/end` | emit | `SubagentStop` | 仅观察 |

设计要点：

- **无硬依赖**：`inject = []`；可选服务（`agents`、`sessionPersistence`、`@deepseek-ai/dsh-llm`）全部经 `ctx.get` / 动态 import 惰性获取，最小部署也能加载
- **后台运行可清理**：emit 类事件上的 hook 后台执行，经 `ctx.effect` 注册的 disposer 在卸载时中止并排空；子代理保留到配对结束事件，确保 `SubagentStop` 仍能访问其工作目录
- **留痕**：在会话日志中成对追加 `hook/invoked` 与 `hook/result`（`dialect: "adapter"`、按 `handlerId` 配对、含退出码/决策/stderr 摘要/耗时）；追加失败只静默跳过，不影响会话
- **载荷**：按 claude 方言契约构造（`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode` 等），`transcript_path` 在宿主未暴露时为空串
- **失败不炸会话**：任何 hook 的运行失败都折叠为结果（非阻塞），绝不向扩展点抛异常；`onError: "block"` 时才升级为拒绝

## 其他宿主接入

不跑 dsh 也可以：用 `listen` 模式的 stdio 协议（[CONTRACT.md](CONTRACT.md#stdio-协议)），或直接 `import` `lib/` 的编程接口：

```js
import { loadRuntime, dispatchEvent } from 'hooks-adapter/cli'

const runtime = loadRuntime({ cwd: process.cwd() })
const { outcome } = await dispatchEvent(runtime, 'PreToolUse', {
  session_id: 's1', cwd: process.cwd(), tool_name: 'Bash', tool_input: {},
})
if (outcome.decision === 'deny') console.log('blocked:', outcome.reason)
```

`lib/index.js` 同时提供 `validate` / `run` / `dump` / `list` 子命令（见 [CLI.md](CLI.md)）。
