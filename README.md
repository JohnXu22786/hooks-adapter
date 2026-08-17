[简体中文](README.zh.md)

# hooks-adapter

A **hooks configuration compatibility layer** for DeepSeek Harness (dsh): it reads existing hooks config files from mainstream agent harnesses (such as the hooks declarations in `.claude/settings.json`, `.codex/hooks.json`, and the hooks section of `opencode.json`), maps their lifecycle events to dsh extension points, and executes four kinds of handlers — **shell / webhook / oracle / proxy** — so the same hooks config can be reused as-is across different harnesses.

- Zero runtime dependencies (Node ≥ 18, pure ESM + JSDoc types)
- Config is read-only, not migrated: your existing hooks declarations stay unchanged
- All four handler kinds supported: command execution, HTTP callbacks, LLM evaluation, subagent delegation
- Timeout control, failure degradation policy, and friendly config validation (`validate` subcommand)
- Three integration modes: dsh plugin (Cordis `apply`), stdio JSON-lines protocol (any host), one-shot CLI

```
hooks-adapter/
├── package.json        # dsh bundle manifest (dsh.bundle + exports)
├── cordis.patch.yml    # composite package layer: inserts this plugin into the plugin tree
├── dsh/plugin.js       # dsh entry: Cordis plugin (name + apply(ctx, config))
├── lib/                # runtime core (usable independently of dsh)
│   ├── index.js        # CLI entry + programmatic API exports
│   ├── events.js       # canonical event catalog + four-dialect mapping table + matcher semantics
│   ├── discover.js     # config file discovery (global/project/local)
│   ├── parse.js        # four-dialect parsers (all go through diagnostics, never throw)
│   ├── config.js       # runtime assembly: merging, disableAllHooks, defaults
│   ├── contract.js     # stdin JSON contract construction + response decoding + decision folding
│   ├── execute.js      # four-kind handler executor + timeout + process tree cleanup
│   ├── dispatch.js     # dispatch pipeline: matcher matching, ordered execution, blockable constraints
│   └── serve.js        # stdio JSON-lines protocol server
├── docs/               # config formats, event mapping, contract, integration notes, CLI guide
├── examples/           # four-dialect example configs + local mock LLM
└── test/               # node:test tests (111 items)
```

## What It Can Do

Declare hooks in `.claude/settings.json` (no matter which harness you wrote them for) and they keep working in dsh:

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

Config files must be strict JSON (no comments); see `examples/` for complete four-dialect examples.

- `PreToolUse` → interception point before tool execution: handler exit code 2 / JSON `decision: "block"` will **block** the tool call (or turn it into ask for human confirmation)
- `PostToolUse` / `PostToolUseFailure` → after tool execution (mutually exclusive triggers): reject the write-back as result feedback, append context
- `UserPromptSubmit` / `SessionStart` / `Stop` / `SubagentStart` / `SubagentStop` / `SessionEnd` → inject context, reject prompts, force the model to continue
- `Notification` / `PreCompact` → triggered manually or via the stdio protocol

The four handler kinds (the `type` field in config follows each harness's conventions; normalized internally):

| Config type | Internal kind | Behavior | Default timeout |
| --- | --- | --- | --- |
| `command` | `shell` | spawn a shell process, feed the JSON contract on stdin | 600s |
| `http` | `webhook` | POST JSON to a URL, the response body is the decision | 600s |
| `prompt` | `oracle` | call an LLM endpoint to evaluate, `{ok:false}` rejects | 30s |
| `agent` / `subagent` | `proxy` | delegate to a subagent runner (configurable command) | 60s |

## Quick Start

### Mode one: dsh plugin (recommended)

```sh
# From a directory containing this plugin checkout
dsh plugin --profile demo add ./hooks-adapter
dsh --profile demo
```

After loading, the plugin automatically discovers hooks configs in project and user directories (see below). You can also override the config line in the profile's `cordis.patch.yml`:

```yaml
- replace:
    - id: hooks-adapter
      config:
        configPath: /abs/path/to/hooks.json   # pin a single file (skip discovery)
        discover: false
        llm: { baseUrl: "https://api.example.com/v1", model: "eval-small" }
        proxy: { command: "dsh run --quiet" }
```

Integration details: [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Installing in DSH

Install directly from the GitHub repository with the dsh plugin command:

```sh
dsh plugin --profile demo add github:JohnXu22786/hooks-adapter
```

The package is a dsh bundle (`dsh.bundle.patch` → `cordis.patch.yml`); once added, it inserts itself into the plugin tree and automatically discovers hooks configs on the next dsh run. Remove it with:

```sh
dsh plugin --profile demo remove hooks-adapter
```

### Mode two: stdio protocol (any host)

```sh
echo '{"op":"ping"}' | node lib/index.js listen --config hooks.json
echo '{"op":"dispatch","event":"PreToolUse","payload":{"tool_name":"Bash","tool_input":{}}}' | node lib/index.js listen
```

Protocol details: [docs/CONTRACT.md](docs/CONTRACT.md#stdio-协议).

### Mode three: one-shot CLI

```sh
node lib/index.js validate            # check all discoverable configs, exit code 0/1
node lib/index.js run --event PreToolUse --payload payload.json
node lib/index.js dump                # print the merged effective config
node lib/index.js list                # list discovered config files
```

## Where the Config Comes From

Auto-discovered and merged in order (later files append groups for same-named events; `disableAllHooks` follows the most specific file):

| Order | File | Dialect |
| --- | --- | --- |
| 1 | `~/.claude/settings.json` | claude |
| 2 | `~/.codex/hooks.json` | codex |
| 3 | `~/.config/opencode/opencode.json` | opencode |
| 4 | `~/.config/hooks-adapter/hooks.json` | native |
| 5 | `<project>/.claude/settings.json` | claude |
| 6 | `<project>/.codex/hooks.json` | codex |
| 7 | `<project>/opencode.json` | opencode |
| 8 | `<project>/.dsh-hooks.json` | native |
| 9 | `<project>/.claude/settings.local.json` | claude |

- Environment variables `HOOKS_ADAPTER_CONFIG` (same as `--config`) and `HOOKS_ADAPTER_HOME` (same as `--home`)
- Any missing file is silently skipped; **if an existing file has issues, it only produces diagnostics**, it never blocks startup
- Config file format details: [docs/CONFIG.md](docs/CONFIG.md)

## Event Mapping

Every harness's event names map to a set of **canonical events** (`session:start`, `tool:before`, ...), which then bind to dsh extension points:

| Canonical event | claude dialect | codex dialect | opencode dialect | dsh extension point |
| --- | --- | --- | --- | --- |
| `session:start` | `SessionStart` | `SessionStart` | `session.created` | `agent/session-start` |
| `session:end` | `SessionEnd` | `SessionEnd` | `session.deleted` | `session/disposed` |
| `prompt:submit` | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` | `agent/pre-step` |
| `tool:before` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `tools/pre-execute` |
| `tool:after` | `PostToolUse` / `PostToolUseFailure` | `PostToolUse` | `tool.execute.after` | `tools/post-execute` |
| `turn:stop` | `Stop` | `Stop` | `session.idle` | `agent/turn-stopping` |
| `subagent:start` | `SubagentStart` | `SubagentStart` | `tool.execute.before.subagent` | `subagent/start` |
| `subagent:end` | `SubagentStop` | `SubagentStop` | `tool.execute.after.subagent` | `subagent/end` |
| `notice` | `Notification` | `Notification` | `notification` | manual / stdio |
| `compact:before` | `PreCompact` | — | `experimental.session.compacting` | manual / stdio |

Full semantics (blockability, matcher rules, payload fields): [docs/EVENTS.md](docs/EVENTS.md).

## Contract

- **stdin JSON**: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode` + event fields (`tool_name`/`tool_input`/`tool_use_id`/`tool_response`/`prompt`/`source` ...)
- **Exit codes**: `0` = allow (when stdout is JSON, the decision is parsed from it); `2` = block (stderr is the reason); any other non-zero = non-blocking error
- **stdout JSON**: `decision`, `continue`/`stopReason`, `systemMessage`, `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`), `additionalContext`, `updatedInput`; oracle answers `{ok: true|false, reason}`
- **Multi-hook folding**: `deny > ask > allow`; any `continue:false` stops; context accumulates in hook order
- Details and the stdio protocol: [docs/CONTRACT.md](docs/CONTRACT.md)

## Testing

```sh
node --test
```

(The default test-discovery mode runs all 111 tests; helper scripts live in `test-support/` and are not mistaken for tests.)

## License

Released under the [MIT License](LICENSE).
