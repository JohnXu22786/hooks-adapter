# 配置格式

本插件读取四种 hooks 配置方言，内部归一为统一的 matcher group 模型。任意文件缺失都静默跳过；存在但内容有问题时只产生诊断（`validate` 子命令可查看），不阻止启动。

## 一、claude 方言：`.claude/settings.json`

与各 harness 通用的 settings 布局一致（配置须为严格 JSON，不支持注释）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          { "type": "command", "command": "guard.sh", "timeout": 10 },
          { "type": "http",    "url": "https://example.com/hook", "timeout": 5 },
          { "type": "prompt",  "prompt": "Approve this call? $ARGUMENTS" },
          { "type": "agent",   "prompt": "Summarize: $ARGUMENTS" }
        ]
      }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "cat ${CLAUDE_PROJECT_DIR}/context.md" } ] }
    ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "notify-send done" } ] } ]
  },
  "disableAllHooks": false
}
```

- `matcher` 语义（claude 方言）：任意字符串按 `,`/`|`（含其后空白）拆分为**精确交替项**逐项比对，支持 `-`、空格与非 ASCII 工具名（如 `"matcher": "Edit, Write"` 或 `"阅读"`）；缺失 / 空串 / `*` 匹配全部。codex / opencode 方言则一律按未锚定正则解释
- 无 matcher 主体的事件（`UserPromptSubmit`、`Stop` 等）上的 matcher 会被丢弃并产生警告；`SessionEnd` 的 matcher 主体是结束原因
- `type` 可选值：`command` / `http` / `prompt` / `agent`（未知类型 → 诊断 + 跳过）
- `timeout` 单位为秒（正整数）；`onError` 为扩展字段，见下文
- 每 hook 的 `if` 过滤字段（如 `"if": "Bash(rm *)"`）**不会被求值**：带 `if` 的 hook 在 matcher 命中时一律执行，配置校验会给出警告

## 二、codex 方言：`.codex/hooks.json`

```json
{
  "$comment": "注释字段被忽略",
  "hooks": {
    "SessionStart": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "echo hi" } ] } ],
    "PreToolUse":   [ { "matcher": "^bash$", "hooks": [ { "type": "command", "command": "guard", "timeout": 9 } ] } ]
  }
}
```

- matcher 一律按**未锚定正则**解释
- 事件名同 claude 方言（不含 `PreCompact` / `PostToolUseFailure`）

## 三、opencode 方言：`opencode.json`

```json
{
  "hooks": {
    "tool.execute.before": [ { "matcher": "bash", "hooks": [ { "type": "command", "command": "guard" } ] } ],
    "session.created":     [ { "hooks": [ { "type": "subagent", "prompt": "hello $ARGUMENTS" } ] } ]
  }
}
```

- 事件名为点分小写（`tool.execute.before` 等）；`type` 可选 `command` / `http` / `subagent`
- matcher 按未锚定正则解释

## 四、native 方言：`.dsh-hooks.json`

本插件自己的通用格式，直接使用**规范事件名**，四种 handler 用内部名，并支持扩展字段：

```json
{
  "version": 1,
  "events": {
    "tool:before": [
      {
        "matcher": "bash|write",
        "hooks": [
          { "type": "shell", "command": "guard.sh", "timeout": 10, "onError": "block", "env": { "MODE": "strict" } }
        ]
      }
    ],
    "prompt:submit": [
      { "hooks": [ { "type": "webhook", "url": "https://example.com/h", "headers": { "X-Token": "$API_TOKEN" } } ] }
    ],
    "session:start": [
      { "hooks": [ { "type": "oracle", "prompt": "Evaluate: $ARGUMENTS", "timeout": 30 } ] }
    ],
    "turn:stop": [
      { "hooks": [ { "type": "proxy", "prompt": "Summarize the session." } ] }
    ]
  }
}
```

- `type`：`shell` / `webhook` / `oracle` / `proxy`，也接受旧名 `command` / `http` / `prompt` / `agent` / `subagent` 作为别名
- matcher 语义同 claude 方言（字面量交替 / 正则）
- 扩展字段（各方言均接受，其他 harness 解析不到的字段本就无害）：

| 字段 | 适用 kind | 含义 |
| --- | --- | --- |
| `timeout` | 全部 | 超时（秒）；缺省用全局默认，再缺省用 kind 默认（shell/webhook 600s、oracle 30s、proxy 60s） |
| `onError` | 全部 | handler 基础设施失败（spawn 失败、超时、HTTP 非 2xx、oracle/proxy 未配置）时的降级策略：`warn`（记日志继续，默认）/ `block`（升级为拒绝）/ `ignore`（静默） |
| `env` | `shell` | 附加环境变量（字符串映射） |
| `headers` | `webhook` | 请求头（字符串映射；值支持 `$ENV_NAME` 展开） |
| `command` | `proxy` | 本 hook 的 runner 命令（缺省用全局 `proxy.command`） |

## 变量替换

| 令牌 | 位置 | 含义 |
| --- | --- | --- |
| `${CLAUDE_PROJECT_DIR}` | `command` | 项目根（插件配置 `projectDir`；缺省为运行目录），同时也作为 `CLAUDE_PROJECT_DIR` 环境变量注入 shell 进程 |
| `${CLAUDE_PLUGIN_ROOT}` | `command` | 插件根目录（插件配置 `pluginRoot`） |
| `$ARGUMENTS` | `prompt` | 运行时替换为完整 stdin JSON 契约 |
| `$ENV_NAME` / `${ENV_NAME}` | `headers` | 运行时从环境变量展开；未设置保持原样 |

未提供的令牌保持字面原样，不报错。

## 发现顺序与合并

见 README 的「配置从哪里来」。合并规则：

- 同一**规范事件**的 matcher group 按文件顺序**追加**（先全局后项目再本地）；也就是说，`PreToolUse`、`tool.execute.before` 与 `tool:before` 的组会被并入同一个桶，分派时一起执行
- 顶层 `disableAllHooks` 布尔开关在**任何方言文件**中都生效；**更具体的文件**（local > project > global）决定最终值
- 重复路径（如 `--home` 与工作目录相同导致同一文件被同时视为全局与项目）自动去重

## 校验

```sh
node lib/index.js validate            # 人类可读；有问题退出码 1
node lib/index.js validate --strict   # 警告也视为问题
node lib/index.js validate --json     # 机器可读
```

诊断示例：

```
[hooks-adapter:warn] [error] C:\proj\.claude\settings.json: hooks[PreToolUse][1].hooks[0]: unknown hook type "warp"
[hooks-adapter:warn] [warning] C:\proj\.claude\settings.json: hooks[UserPromptSubmit][0]: matcher has no effect on UserPromptSubmit (no matcher subject)
```

每一条都带文件路径与 JSON 定位（事件、组下标、hook 下标），方便直接改。
