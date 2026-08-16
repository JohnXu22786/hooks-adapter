/**
 * The event vocabulary: a small set of canonical lifecycle events, the
 * per-harness names that map onto them, and the matcher semantics each
 * harness uses. This module is the single source of truth for the mapping
 * table documented in docs/EVENTS.md.
 * @module hooks-adapter/events
 */

/** Canonical events, in a stable order. */
export const CANONICAL_EVENTS = [
  'session:start',
  'session:end',
  'prompt:submit',
  'tool:before',
  'tool:after',
  'turn:stop',
  'subagent:start',
  'subagent:end',
  'notice',
  'compact:before',
]

/**
 * Per-event facts used by the dispatch pipeline:
 * - `blockable` — may a hook denial actually stop the action?
 * - `contextFromStdout` — does plain stdout of a hook count as context?
 * - `subject` — the matcher subject for the event (absent = subject-less).
 */
export const EVENT_META = {
  'session:start': { label: 'Session begins', blockable: false, contextFromStdout: true, subject: 'source' },
  'session:end': { label: 'Session ends', blockable: false, contextFromStdout: false, subject: 'reason' },
  'prompt:submit': { label: 'User prompt submitted', blockable: true, contextFromStdout: true },
  'tool:before': { label: 'Tool about to run', blockable: true, contextFromStdout: false, subject: 'tool' },
  'tool:after': { label: 'Tool finished', blockable: false, contextFromStdout: false, subject: 'tool' },
  'turn:stop': { label: 'Model turn wants to stop', blockable: true, contextFromStdout: false },
  'subagent:start': { label: 'Subagent started', blockable: false, contextFromStdout: true, subject: 'agentType' },
  'subagent:end': { label: 'Subagent ended', blockable: false, contextFromStdout: false, subject: 'agentType' },
  'notice': { label: 'Notification', blockable: false, contextFromStdout: false },
  'compact:before': { label: 'Context compaction pending', blockable: false, contextFromStdout: true },
}

/** How a matcher pattern is interpreted for a given harness. */
export const MATCHER_LITERAL = 'literal'
export const MATCHER_REGEX = 'regex'

/**
 * Dialect definitions. `events` maps each harness's own event name to a
 * canonical event; `typeAliases` maps harness handler type names to the
 * internal handler kinds; `key` is the config file member that holds the
 * event map; `matcherMode` decides pattern interpretation.
 */
export const DIALECTS = {
  claude: {
    label: 'Claude Code settings',
    key: 'hooks',
    matcherMode: MATCHER_LITERAL,
    typeAliases: { command: 'shell', http: 'webhook', prompt: 'oracle', agent: 'proxy' },
    events: {
      SessionStart: 'session:start',
      SessionEnd: 'session:end',
      UserPromptSubmit: 'prompt:submit',
      PreToolUse: 'tool:before',
      PostToolUse: 'tool:after',
      PostToolUseFailure: 'tool:after',
      Stop: 'turn:stop',
      SubagentStart: 'subagent:start',
      SubagentStop: 'subagent:end',
      Notification: 'notice',
      PreCompact: 'compact:before',
    },
  },
  codex: {
    label: 'Codex hooks.json',
    key: 'hooks',
    matcherMode: MATCHER_REGEX,
    typeAliases: { command: 'shell', http: 'webhook', prompt: 'oracle', agent: 'proxy' },
    events: {
      SessionStart: 'session:start',
      SessionEnd: 'session:end',
      UserPromptSubmit: 'prompt:submit',
      PreToolUse: 'tool:before',
      PostToolUse: 'tool:after',
      Stop: 'turn:stop',
      SubagentStart: 'subagent:start',
      SubagentStop: 'subagent:end',
      Notification: 'notice',
    },
  },
  opencode: {
    label: 'opencode.json hooks',
    key: 'hooks',
    matcherMode: MATCHER_REGEX,
    typeAliases: { command: 'shell', http: 'webhook', subagent: 'proxy' },
    events: {
      'session.created': 'session:start',
      'session.deleted': 'session:end',
      'chat.message': 'prompt:submit',
      'tool.execute.before': 'tool:before',
      'tool.execute.after': 'tool:after',
      'session.idle': 'turn:stop',
      'tool.execute.before.subagent': 'subagent:start',
      'tool.execute.after.subagent': 'subagent:end',
      'notification': 'notice',
      'experimental.session.compacting': 'compact:before',
    },
  },
  native: {
    label: 'native hooks config',
    key: 'events',
    matcherMode: MATCHER_LITERAL,
    typeAliases: {
      shell: 'shell',
      webhook: 'webhook',
      oracle: 'oracle',
      proxy: 'proxy',
      command: 'shell',
      http: 'webhook',
      prompt: 'oracle',
      agent: 'proxy',
      subagent: 'proxy',
    },
    events: Object.fromEntries(CANONICAL_EVENTS.map((name) => [name, name])),
  },
}

/** The four internal handler kinds. */
export const HANDLER_KINDS = ['shell', 'webhook', 'oracle', 'proxy']

/** Canonical event for a dialect event name. */
export function canonicalFor(dialect, name) {
  return DIALECTS[dialect]?.events?.[name]
}

/** Every dialect event name that maps to a canonical event (may be several). */
export function namesFor(dialect, canonical) {
  const out = []
  for (const [name, c] of Object.entries(DIALECTS[dialect].events)) {
    if (c === canonical) out.push(name)
  }
  return out
}

/**
 * Resolve any accepted event name (canonical or any dialect's name) to its
 * canonical form. Returns `null` for an unknown name.
 */
export function resolveEventName(name) {
  if (CANONICAL_EVENTS.includes(name)) return { canonical: name, dialects: ['native'] }
  for (const [dialect, table] of Object.entries(DIALECTS)) {
    if (table.events[name]) return { canonical: table.events[name], dialects: [dialect] }
  }
  return null
}

/** The matcher subject for an event, derived from the payload. */
export function subjectFor(canonical, payload) {
  switch (EVENT_META[canonical]?.subject) {
    case 'tool':
      return payload?.tool_name ?? payload?.tool ?? payload?.name ?? ''
    case 'source':
      return payload?.source ?? ''
    case 'reason':
      return payload?.reason ?? payload?.source ?? ''
    case 'agentType':
      return payload?.agent_type ?? ''
    default:
      return ''
  }
}

/**
 * A literal matcher is a comma/pipe-separated list of exact alternatives;
 * any string (including non-ASCII tool names) is valid. Regex-mode dialects
 * treat every non-empty pattern as an unanchored regex.
 */
function compileRegex(pattern) {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

/** Validate a matcher for a dialect; returns a diagnostic or undefined. */
export function matcherDiagnostic(matcher, mode) {
  if (matcher === undefined || matcher === '' || matcher === '*') return undefined
  if (mode === MATCHER_REGEX && compileRegex(matcher) === undefined) {
    return `invalid regex matcher ${JSON.stringify(matcher)}`
  }
  return undefined
}

/** Whether a matcher selects a query under a dialect's semantics. */
export function matches(matcher, query, mode) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (mode === MATCHER_LITERAL) {
    return matcher.split(/[|,]\s*/).includes(query)
  }
  return compileRegex(matcher)?.test(query) ?? false
}
