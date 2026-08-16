/**
 * Dialect parsers: turn a raw config document from any supported harness
 * into normalized matcher groups. Parsing is total — every malformed entry
 * becomes a diagnostic instead of a thrown error, so one bad file can never
 * take the whole runtime down.
 * @module hooks-adapter/parse
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { DIALECTS, CANONICAL_EVENTS, HANDLER_KINDS, EVENT_META, matcherDiagnostic, MATCHER_REGEX } from './events.js'
import { substituteTokens } from './util.js'

const ON_ERROR_VALUES = ['ignore', 'warn', 'block']

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

/** Build a hook id that stays stable across reloads. */
function hookId(dialect, file, event, groupIdx, hookIdx) {
  return `${dialect}:${basename(file ?? 'inline')}:${event}:${groupIdx}:${hookIdx}`
}

/**
 * Parse one hook entry of a matcher group into a normalized hook, or report
 * a diagnostic. Returns `undefined` when the entry is unusable.
 */
function parseHook(dialect, file, event, groupIdx, hookIdx, rawHook, vars, diagnostics) {
  const hook = asObject(rawHook)
  if (!hook) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: entry is not an object` })
    return undefined
  }
  const type = typeof hook.type === 'string' ? hook.type : 'command'
  const kind = DIALECTS[dialect].typeAliases[type]
  if (!kind || !HANDLER_KINDS.includes(kind)) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: unknown hook type ${JSON.stringify(type)}` })
    return undefined
  }

  const spec = {}
  if (kind === 'shell') {
    const command = asString(hook.command)
    if (command === undefined || command.trim() === '') {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: missing command` })
      return undefined
    }
    spec.command = substituteTokens(command, vars)
  }
  if (kind === 'proxy') {
    const command = asString(hook.command)
    if (command !== undefined) {
      if (command.trim() === '') {
        diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: command must not be empty` })
        return undefined
      }
      spec.command = substituteTokens(command, vars)
    }
  }
  if (kind === 'webhook') {
    const url = asString(hook.url)
    if (url === undefined || url.trim() === '') {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: missing url` })
      return undefined
    }
    spec.url = url
    const headers = asObject(hook.headers)
    if (headers !== undefined) {
      if (Object.values(headers).every((v) => typeof v === 'string')) {
        spec.headers = headers
      } else {
        diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: headers must be a string map` })
      }
    }
  }
  if (kind === 'oracle' || kind === 'proxy') {
    const prompt = asString(hook.prompt)
    if (prompt === undefined || prompt.trim() === '') {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: missing prompt` })
      return undefined
    }
    spec.prompt = prompt
  }

  let timeoutSec
  if (hook.timeout !== undefined) {
    if (typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) && hook.timeout > 0) {
      timeoutSec = hook.timeout
    } else {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: timeout must be a positive number of seconds` })
    }
  }

  let onError
  if (hook.onError !== undefined) {
    if (ON_ERROR_VALUES.includes(hook.onError)) {
      onError = hook.onError
    } else {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: onError must be one of ${ON_ERROR_VALUES.join('/')}` })
    }
  }

  let env
  if (kind === 'shell' && hook.env !== undefined) {
    const rawEnv = asObject(hook.env)
    if (rawEnv && Object.values(rawEnv).every((v) => typeof v === 'string')) {
      env = rawEnv
    } else {
      diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: env must be a string map` })
    }
  }

  // The per-hook `if` filter of the claude dialect is not evaluated; running
  // the hook unconditionally (when the matcher matched) would over-fire, so
  // surface it honestly instead of silently ignoring it.
  if (hook.if !== undefined) {
    diagnostics.push({
      severity: 'warning',
      file,
      event,
      message: `hooks[${event}][${groupIdx}].hooks[${hookIdx}]: "if" filters are not evaluated; this hook runs whenever the matcher matches`,
    })
  }

  return {
    id: hookId(dialect, file, event, groupIdx, hookIdx),
    dialect,
    event,
    kind,
    spec,
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    ...(onError !== undefined ? { onError } : {}),
    ...(env !== undefined ? { env } : {}),
  }
}

/**
 * Parse one matcher group. `groupIdx` numbers the group inside its event.
 * Returns `undefined` when the group is unusable.
 */
function parseGroup(dialect, file, event, canonical, groupIdx, rawGroup, vars, diagnostics) {
  const group = asObject(rawGroup)
  if (!group) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}]: group is not an object` })
    return undefined
  }

  if (group.matcher !== undefined && typeof group.matcher !== 'string') {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}]: matcher must be a string` })
    return undefined
  }
  let matcher = group.matcher
  const diagnostic = matcherDiagnostic(matcher, DIALECTS[dialect].matcherMode)
  if (diagnostic !== undefined) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}]: ${diagnostic}` })
    return undefined
  }
  if (matcher !== undefined && EVENT_META[canonical].subject === undefined) {
    diagnostics.push({
      severity: 'warning',
      file,
      event,
      message: `hooks[${event}][${groupIdx}]: matcher has no effect on ${event} (no matcher subject)`,
    })
    matcher = undefined
  }

  if (!Array.isArray(group.hooks)) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}]: hooks must be an array` })
    return undefined
  }
  if (group.hooks.length === 0) {
    diagnostics.push({ severity: 'error', file, event, message: `hooks[${event}][${groupIdx}]: hooks must not be empty` })
    return undefined
  }

  const hooks = []
  group.hooks.forEach((rawHook, hookIdx) => {
    const hook = parseHook(dialect, file, event, groupIdx, hookIdx, rawHook, vars, diagnostics)
    if (hook) {
      hook.matcher = matcher
      hooks.push(hook)
    }
  })
  if (hooks.length === 0) return undefined

  return {
    dialect,
    event,
    canonical,
    ...(matcher !== undefined ? { matcher } : {}),
    hooks,
  }
}

/**
 * Parse a raw (already JSON-decoded) config document.
 * `vars` may carry `projectDir` / `pluginRoot` (or the token-named keys
 * directly); `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_ROOT}` in command
 * strings are replaced at parse time.
 * @returns `{ groups, diagnostics }` — `groups` are normalized matcher groups.
 */
export function parseConfigObject(raw, dialect, vars = {}, file = '') {
  const tokenVars = {
    ...(vars.projectDir !== undefined ? { CLAUDE_PROJECT_DIR: vars.projectDir } : {}),
    ...(vars.pluginRoot !== undefined ? { CLAUDE_PLUGIN_ROOT: vars.pluginRoot } : {}),
    ...vars,
  }
  const diagnostics = []
  const groups = []
  const root = asObject(raw)
  if (!root) {
    diagnostics.push({ severity: 'error', message: `config root must be a JSON object (${DIALECTS[dialect].label})` })
    return { groups, diagnostics }
  }
  const map = asObject(root[DIALECTS[dialect].key])
  if (!map) {
    diagnostics.push({ severity: 'error', message: `missing "${DIALECTS[dialect].key}" member (${DIALECTS[dialect].label})` })
    return { groups, diagnostics }
  }

  for (const [event, rawGroups] of Object.entries(map)) {
    let canonical
    if (dialect === 'native') {
      canonical = CANONICAL_EVENTS.includes(event) ? event : undefined
    } else {
      canonical = DIALECTS[dialect].events[event]
    }
    if (canonical === undefined) {
      diagnostics.push({ severity: 'warning', message: `unknown event ${JSON.stringify(event)} (ignored)` })
      continue
    }
    if (!Array.isArray(rawGroups)) {
      diagnostics.push({ severity: 'error', event, message: `hooks[${event}]: must be an array of matcher groups` })
      continue
    }
    rawGroups.forEach((rawGroup, groupIdx) => {
      const group = parseGroup(dialect, file, event, canonical, groupIdx, rawGroup, tokenVars, diagnostics)
      if (group) groups.push(group)
    })
  }
  return { groups, diagnostics }
}

/**
 * Parse a config document's text.
 * @returns `{ groups, diagnostics, raw }` — `raw` is the decoded JSON (for
 * settings-level flags like `disableAllHooks`), `undefined` on parse failure.
 */
export function parseConfigText(text, dialect, vars = {}, file = '') {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      groups: [],
      raw: undefined,
      diagnostics: [{ severity: 'error', file, message: `config is not valid JSON: ${error.message}` }],
    }
  }
  const { groups, diagnostics } = parseConfigObject(raw, dialect, vars, file)
  for (const d of diagnostics) d.file = file
  return { groups, diagnostics, raw }
}

/** Read and parse a config file. */
export function parseFile(file, dialect, vars = {}) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      groups: [],
      raw: undefined,
      diagnostics: [{ severity: 'error', file, message: `cannot read config: ${error.message}` }],
    }
  }
  return parseConfigText(text, dialect, vars, file)
}
