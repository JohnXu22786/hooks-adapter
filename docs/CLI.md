# CLI 指南

```
hooks-adapter <command> [flags]
```

| 命令 | 说明 | 退出码 |
| --- | --- | --- |
| `validate` | 检查所有可发现的配置文件 | 0 干净；1 有错误（`--strict` 时警告也算） |
| `run` | 一次性分发一个事件 | 0 放行/无命中；2 被拒绝；1 参数或载荷错误 |
| `listen` | stdio JSON-lines 协议服务（见 CONTRACT.md） | 0 |
| `dump` | 打印合并后的生效配置（JSON） | 0 |
| `list` | 列出发现到的配置文件 | 0 |
| `help` / `--help` / `-h` | 帮助 | 0 |
| `version` / `--version` | 版本号 | 0 |

## 通用 flags

| flag | 含义 |
| --- | --- |
| `--config FILE` | 固定使用该文件（等价环境变量 `HOOKS_ADAPTER_CONFIG`） |
| `--home DIR` | 发现用的 home（等价 `HOOKS_ADAPTER_HOME`） |
| `--cwd DIR` | 发现用的工作目录 |
| `--timeout N` | 全局默认超时（秒，须为正数，非法值报错） |

## run 专用

| flag | 含义 |
| --- | --- |
| `--event NAME` | 事件名（方言名或规范名，如 `PreToolUse` / `tool:before`，二者命中同一批组） |
| `--payload FILE` | 载荷 JSON 文件；缺省从 stdin 读取 |
| `--subject S` | 覆盖 matcher 主体（缺省从 payload 推导） |
| `--llm-base-url URL` | oracle handler 的 LLM 端点（须与 `--llm-model` 同用） |
| `--llm-model NAME` | oracle handler 的模型名 |
| `--llm-key KEY` | LLM 端点 API key（可选） |

示例：

```sh
# 阻塞性演示：payload 里 tool_name 命中 Bash 守卫
node lib/index.js run --event PreToolUse --payload payload.json
echo $?   # 2 = 被拒绝

# 从 stdin 传载荷
echo '{"tool_name":"Read"}' | node lib/index.js run --event PreToolUse

# 查看某个事件会命中哪些配置（dump 的 groups 按规范事件名分桶）
node lib/index.js dump | jq '.groups["tool:before"]'

# 用本地 mock LLM 跑 oracle hook
node lib/index.js run --event session:start --config examples/dsh-hooks.json \
  --llm-base-url http://127.0.0.1:8765/v1 --llm-model mock
```

## 输出约定

- 命令的机器可读结果（`run` / `dump` / `validate --json`）为**一行 JSON** 写 stdout
- 日志与人类可读诊断写 stderr——管道消费 stdout 时不会被污染
- `run` 的 stdout 结构：`{ "outcome": {...}, "runs": [{hook, outcome, durationMs}], "canonical": "tool:before" }`
