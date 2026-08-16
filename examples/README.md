# 示例

| 文件 | 说明 |
| --- | --- |
| `claude-settings.json` | claude 方言：Bash 守卫 + SessionStart 上下文 + prompt 评估 + Stop 通知 |
| `codex-hooks.json` | codex 方言（matcher 为正则） |
| `opencode.json` | opencode 方言（点分事件名） |
| `dsh-hooks.json` | native 通用格式（规范事件名 + 四类 handler + `onError`） |
| `hooks/guard-bash.mjs` | 示例 hook 脚本：检测危险 shell 命令，退出码 2 拒绝 |
| `mock-llm.mjs` | 本地 mock LLM（OpenAI 兼容端点），离线验证 oracle handler |

## 快速体验（不装 dsh）

以下命令都从**仓库根目录**运行（示例配置里的命令是仓库根相对路径）：

```sh
# 1. 校验 native 示例
node lib/index.js validate --config examples/dsh-hooks.json

# 2. 一次性分发：命中 Bash 守卫 → 退出码 2
echo '{"tool_name":"bash","tool_input":{"command":"rm -rf /"}}' |
  node lib/index.js run --event tool:before --config examples/dsh-hooks.json
echo $?

# 3. 起 mock LLM，验证 oracle 接线
node examples/mock-llm.mjs --port 8765 &
echo '{"session_id":"s1"}' |
  node lib/index.js run --event session:start --config examples/dsh-hooks.json \
    --llm-base-url http://127.0.0.1:8765/v1 --llm-model mock
```

注意：示例配置里的命令是相对路径（`node ./examples/hooks/...`），实际使用时请改为绝对路径，或把 `${CLAUDE_PROJECT_DIR}` 配成项目根（`--config` 单文件模式不支持该令牌时优先用绝对路径）。
