# Changelog

## 0.1.0 — 2026-08-17

Initial release: a universal hooks compatibility layer for DeepSeek Harness (dsh).

- Reads hooks configs from Claude Code (`.claude/settings.json`), Codex (`.codex/hooks.json`),
  opencode (`opencode.json`) and native configs; maps lifecycle events to dsh extension points.
- Four handler kinds: shell, webhook, oracle (LLM evaluation) and proxy (subagent delegation).
- Timeout control with whole-process-tree cleanup, `onError` degradation policy
  (ignore/warn/block), and strict-JSON contract decoding (incl. markdown-fenced oracle answers).
- Three integration modes: dsh Cordis plugin (`dsh/plugin.js`), stdio JSON-lines protocol
  (`listen`), and a one-shot CLI (`validate`/`run`/`dump`/`list`).
- Zero runtime dependencies, pure ESM + JSDoc types, `node --test` suite (111 items).
