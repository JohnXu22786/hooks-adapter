[English](README.md)

# hooks-adapter

一个面向 DeepSeek Harness（dsh）的 **hooks 配置兼容层**：读取主流 agent harness 已有的 hooks 配置文件（如 `.claude/settings.json` 中的 hooks 声明、`.codex/hooks.json`、`opencode.json` 的 hooks 段），把它们的生命周期事件映射到 dsh 的扩展点，并执行 **shell / webhook / oracle / proxy** 四类 handler——让同一份 hooks 配置在不同的 harness 之间原样复用。

- 零运行时依赖（Node ≥ 18，纯 ESM + JSDoc 类型）
- 配置只读不迁移：你已有的 hooks 声明不用改写
- 四类 handler 全支持：命令执行、HTTP 回调、LLM 评估、子代理委派
- 超时控制、失败降级策略、友好的配置校验（`validate` 子命令）
- 三种接入方式：dsh 插件（Cordis `apply`）、stdio JSON-lines 协议（任意宿主）、一次性 CLI

```
hooks-adapter/
├── package.json        # dsh bundle 清单（dsh.bundle + exports）
├── cordis.patch.yml    # 组合包层：向插件树插入本插件
├── dsh/plugin.js       # dsh 入口：Cordis 插件（name + apply(ctx, config)）
├── lib/                # 运行时核心（可独立于 dsh 使用）
│   ├── index.js        # CLI 入口 + 编程接口导出
│   ├── events.js       # 规范事件目录 + 四方言映射表 + matcher 语义
│   ├── discover.js     # 配置文件发现（全局/项目/本地）
│   ├── parse.js        # 四方言解析器（全部走诊断，不抛错）
│   ├── config.js       # 运行时组装：合并、disableAllHooks、默认值
│   ├── contract.js     # stdin JSON 契约构造 + 响应解码 + 决策折叠
│   ├── execute.js      # 四类 handler 执行器 + 超时 + 进程树清理
│   ├── dispatch.js     # 分发管道：matcher 匹配、顺序执行、blockable 约束
│   └── serve.js        # stdio JSON-lines 协议服务
├── docs/               # 配置格式、事件映射、契约、接入说明、CLI 指南
├── examples/           # 四方言示例配置 + 本地 mock LLM
└── test/               # node:test 测试（111 项）
```

## 它能做什么

在 `.claude/settings.json` 里声明 hooks（无论你之前为哪个 harness 写的），在 dsh 中它们照常生效：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "guard.sh", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "notify-send done" } ] }
    ]
  }
}
```

配置文件须为严格 JSON（不支持注释）；`examples/` 下有完整的四方言示例。

- `PreToolUse` → 工具执行前的拦截点：handler 退出码 2 / JSON `decision: "block"` 会**阻止**工具调用（或转为 ask 交人工确认）
- `PostToolUse` / `PostToolUseFailure` → 工具执行后（互斥触发）：拒绝写回为结果反馈、追加上下文
- `UserPromptSubmit` / `SessionStart` / `Stop` / `SubagentStart` / `SubagentStop` / `SessionEnd` → 注入上下文、拒绝提示词、强制模型继续
- `Notification` / `PreCompact` → 手动或经 stdio 协议触发

四类 handler（配置里的 `type` 字段按各 harness 习惯书写，内部归一）：

| 配置 type | 内部 kind | 行为 | 默认超时 |
| --- | --- | --- | --- |
| `command` | `shell` | 起 shell 进程，stdin 喂 JSON 契约 | 600s |
| `http` | `webhook` | POST JSON 到 URL，响应体即决策 | 600s |
| `prompt` | `oracle` | 调 LLM 端点评估，`{ok:false}` 即拒绝 | 30s |
| `agent` / `subagent` | `proxy` | 委派给子代理 runner（可配置命令） | 60s |

## 快速开始

### 方式一：dsh 插件（推荐）

```sh
# 在包含本插件 checkout 的目录中
dsh plugin --profile demo add ./hooks-adapter
dsh --profile demo
```

加载后插件自动发现项目与用户目录下的 hooks 配置（见下）。也可在 profile 的 `cordis.patch.yml` 中覆盖配置行：

```yaml
- replace:
    - id: hooks-adapter
      config:
        configPath: /abs/path/to/hooks.json   # 固定使用单一文件（跳过发现）
        discover: false
        llm: { baseUrl: "https://api.example.com/v1", model: "eval-small" }
        proxy: { command: "dsh run --quiet" }
```

接入细节见 [docs/INTEGRATION.md](docs/INTEGRATION.md)。

## 在 DSH 中安装

直接用 dsh 插件命令从 GitHub 仓库安装：

```sh
dsh plugin --profile demo add github:JohnXu22786/hooks-adapter
```

本包是 dsh bundle（`dsh.bundle.patch` → `cordis.patch.yml`），添加后即插入插件树，下次启动 dsh 时自动发现 hooks 配置。卸载：

```sh
dsh plugin --profile demo remove hooks-adapter
```

### 方式二：stdio 协议（任意宿主）

```sh
echo '{"op":"ping"}' | node lib/index.js listen --config hooks.json
echo '{"op":"dispatch","event":"PreToolUse","payload":{"tool_name":"Bash","tool_input":{}}}' | node lib/index.js listen
```

协议说明见 [docs/CONTRACT.md](docs/CONTRACT.md#stdio-协议)。

### 方式三：一次性 CLI

```sh
node lib/index.js validate            # 检查所有可发现的配置，退出码 0/1
node lib/index.js run --event PreToolUse --payload payload.json
node lib/index.js dump                # 打印合并后的生效配置
node lib/index.js list                # 列出发现到的配置文件
```

## 配置从哪里来

自动发现并按顺序合并（后者追加同名事件的组；`disableAllHooks` 以最具体的文件为准）：

| 顺序 | 文件 | 方言 |
| --- | --- | --- |
| 1 | `~/.claude/settings.json` | claude |
| 2 | `~/.codex/hooks.json` | codex |
| 3 | `~/.config/opencode/opencode.json` | opencode |
| 4 | `~/.config/hooks-adapter/hooks.json` | native |
| 5 | `<项目>/.claude/settings.json` | claude |
| 6 | `<项目>/.codex/hooks.json` | codex |
| 7 | `<项目>/opencode.json` | opencode |
| 8 | `<项目>/.dsh-hooks.json` | native |
| 9 | `<项目>/.claude/settings.local.json` | claude |

- 环境变量 `HOOKS_ADAPTER_CONFIG`（等价于 `--config`）与 `HOOKS_ADAPTER_HOME`（等价于 `--home`）
- 任意文件缺失都静默跳过；**存在的文件若有问题，只产生诊断**，不阻止启动
- 配置文件格式细节见 [docs/CONFIG.md](docs/CONFIG.md)

## 事件映射

每种 harness 的事件名映射到一套**规范事件**（`session:start`、`tool:before`……），再绑定到 dsh 的扩展点：

| 规范事件 | claude 方言 | codex 方言 | opencode 方言 | dsh 扩展点 |
| --- | --- | --- | --- | --- |
| `session:start` | `SessionStart` | `SessionStart` | `session.created` | `agent/session-start` |
| `session:end` | `SessionEnd` | `SessionEnd` | `session.deleted` | `session/disposed` |
| `prompt:submit` | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` | `agent/pre-step` |
| `tool:before` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `tools/pre-execute` |
| `tool:after` | `PostToolUse` / `PostToolUseFailure` | `PostToolUse` | `tool.execute.after` | `tools/post-execute` |
| `turn:stop` | `Stop` | `Stop` | `session.idle` | `agent/turn-stopping` |
| `subagent:start` | `SubagentStart` | `SubagentStart` | `tool.execute.before.subagent` | `subagent/start` |
| `subagent:end` | `SubagentStop` | `SubagentStop` | `tool.execute.after.subagent` | `subagent/end` |
| `notice` | `Notification` | `Notification` | `notification` | 手动 / stdio |
| `compact:before` | `PreCompact` | — | `experimental.session.compacting` | 手动 / stdio |

完整语义（可阻塞性、matcher 规则、载荷字段）见 [docs/EVENTS.md](docs/EVENTS.md)。

## 契约

- **stdin JSON**：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode` + 事件字段（`tool_name`/`tool_input`/`tool_use_id`/`tool_response`/`prompt`/`source`……）
- **退出码**：`0` = 放行（stdout 为 JSON 时解析决策）；`2` = 拒绝（stderr 为原因）；其他非零 = 非阻塞错误
- **stdout JSON**：`decision`、`continue`/`stopReason`、`systemMessage`、`hookSpecificOutput.permissionDecision`（`allow`/`deny`/`ask`）、`additionalContext`、`updatedInput`；oracle 应答 `{ok: true|false, reason}`
- **多 hook 折叠**：`deny > ask > allow`；任一 `continue:false` 即停；上下文按 hook 顺序累加
- 细节与 stdio 协议见 [docs/CONTRACT.md](docs/CONTRACT.md)

## 测试

```sh
node --test
```

（默认测试发现模式即可跑全部 111 项测试；辅助脚本在 `test-support/`，不会被误当测试。）

## 许可证

基于 [MIT License](LICENSE) 发布。
