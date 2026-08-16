/**
 * The wire contract: how hook output (exit code + stdout + stderr) is
 * decoded into a decision, how multiple hook outcomes are folded into one,
 * and how per-event payloads are built for hook stdin. Documented in
 * docs/CONTRACT.md.
 * @module hooks-adapter/contract
 */

import { DIALECTS, EVENT_META, CANONICAL_EVENTS, namesFor } from './events.js'

const BLOCKING_EXIT_CODE = 2

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * Fold the structured fields of a decoded JSON object into an outcome.
 * Honored fields:
 * - `continue` (false stops) + `stopReason`
 * - `systemMessage` (surfaced to the user)
 * - top-level `decision` (legacy approve/block) + `reason`
 * - `hookSpecificOutput.hookEventName` — when it names a different event
 *   than the one firing, the event-scoped fields are discarded
 * - `hookSpecificOutput.permissionDecision` (allow/deny/ask) + reason
 * - `hookSpecificOutput.additionalContext` / top-level `additionalContext`
 * - `hookSpecificOutput.updatedInput` (parsed, not honored yet)
 * - `ok: false` — an evaluation handler denying, with `reason`
 */
export function applyStructuredFields(outcome, obj, expectedEvent) {
  const stop = typeof obj.continue === 'boolean' ? obj.continue : undefined
  if (stop === false) {
    outcome.stop = true
    const reason = asString(obj.stopReason)
    if (reason !== undefined) outcome.stopReason = reason
  }

  const systemMessage = asString(obj.systemMessage)
  if (systemMessage !== undefined) outcome.messages.push(systemMessage)

  const legacy = asString(obj.decision)
  if (legacy === 'approve') {
    outcome.decision = 'allow'
  } else if (legacy === 'block') {
    outcome.decision = 'deny'
  }
  const topReason = asString(obj.reason)
  if (topReason !== undefined) outcome.reason = topReason

  const topContext = asString(obj.additionalContext)
  if (topContext !== undefined && topContext.length > 0) outcome.contexts.push(topContext)

  const scoped = asObject(obj.hookSpecificOutput)
  if (scoped) {
    const claimedEvent = asString(scoped.hookEventName)
    // A block that names a different event cannot affect this one.
    if (expectedEvent !== undefined && claimedEvent !== undefined && claimedEvent !== expectedEvent) {
      return
    }
    const permission = asString(scoped.permissionDecision)
    if (permission === 'allow') outcome.decision = 'allow'
    if (permission === 'deny' || permission === 'ask') outcome.decision = permission === 'deny' ? 'deny' : 'ask'
    const permissionReason = asString(scoped.permissionDecisionReason)
    if (permissionReason !== undefined) outcome.reason = permissionReason
    const scopedContext = asString(scoped.additionalContext)
    if (scopedContext !== undefined && scopedContext.length > 0) outcome.contexts.push(scopedContext)
    const updated = asObject(scoped.updatedInput)
    if (updated !== undefined) outcome.updateInput = updated
  }

  // Evaluation handlers (oracle) answer `{ok: false, reason}`.
  if (obj.ok === false) {
    outcome.decision = 'deny'
    if (outcome.reason === undefined) outcome.reason = asString(obj.reason) ?? 'denied by evaluation'
  }
}

/**
 * Decode one hook process outcome. Total: malformed output can never throw.
 * @param exitCode - process exit code, or `undefined` when the hook could
 * not run at all (infrastructure failure).
 */
export function decodeOutcome(exitCode, stdout, stderr, expectedEvent) {
  const trimmedErr = (stderr ?? '').trim()
  const trimmedOut = (stdout ?? '').trim()
  const outcome = {
    exitCode,
    stderr: trimmedErr,
    stdout: trimmedOut,
    decision: undefined,
    reason: undefined,
    stop: false,
    stopReason: undefined,
    contexts: [],
    messages: [],
    updateInput: undefined,
  }

  if (exitCode === BLOCKING_EXIT_CODE) {
    outcome.decision = 'deny'
    outcome.reason = trimmedErr.length > 0 ? trimmedErr : 'blocked by hook'
  } else if (exitCode === 0 && trimmedOut.startsWith('{')) {
    let parsed
    try {
      parsed = asObject(JSON.parse(trimmedOut))
    } catch {
      parsed = undefined // malformed JSON on a clean exit = plain text
    }
    if (parsed) applyStructuredFields(outcome, parsed, expectedEvent)
  }
  return outcome
}

/** Rank a decision for the deny > ask > allow precedence. */
function rank(decision) {
  if (decision === 'deny') return 3
  if (decision === 'ask') return 2
  if (decision === 'allow') return 1
  return 0
}

/**
 * Fold every matched hook's decoded outcome into a single result.
 * - decision: the strictest expressed decision (deny > ask > allow)
 * - reason: the joined reasons of the winning rank
 * - stop: sticky on the first `continue: false`
 * - contexts / messages: accumulated in hook order
 * - `meta.contextFromStdout` events also contribute plain stdout
 */
export function foldOutcomes(outcomes, meta = {}) {
  let maxRank = 0
  const reasonsByRank = new Map()
  let stop = false
  let stopReason
  const contexts = []
  const messages = []
  const updateInputs = []

  for (const out of outcomes) {
    const r = rank(out.decision)
    if (r > maxRank) maxRank = r
    if ((r === 3 || r === 2) && out.reason !== undefined && out.reason.length > 0) {
      const list = reasonsByRank.get(r) ?? []
      list.push(out.reason)
      reasonsByRank.set(r, list)
    }
    if (out.stop && !stop) {
      stop = true
      if (out.stopReason !== undefined) stopReason = out.stopReason
    }
    contexts.push(...out.contexts)
    messages.push(...out.messages)
    if (out.updateInput !== undefined) updateInputs.push(out.updateInput)
    if (meta.contextFromStdout && out.stdout.length > 0) contexts.push(out.stdout)
  }

  return {
    decision: maxRank === 3 ? 'deny' : maxRank === 2 ? 'ask' : maxRank === 1 ? 'allow' : 'none',
    ...(maxRank > 0 && reasonsByRank.get(maxRank)?.length ? { reason: reasonsByRank.get(maxRank).join('\n\n') } : {}),
    stop,
    ...(stopReason !== undefined ? { stopReason } : {}),
    contexts,
    messages,
    updateInputs,
  }
}

/**
 * Build the stdin payload a hook receives for a canonical event.
 * `eventName` may be a canonical name or any of the dialect's own names.
 * Harness dialects get the shared reference shape (session_id, cwd,
 * hook_event_name, ...); the native dialect gets an envelope with the
 * canonical event name and a timestamp.
 */
export function buildPayload(dialect, eventName, data = {}) {
  const events = DIALECTS[dialect].events
  let canonical = events[eventName]
  if (canonical === undefined && CANONICAL_EVENTS.includes(eventName)) canonical = eventName
  if (canonical === undefined) throw new Error(`unknown event ${JSON.stringify(eventName)} for dialect ${dialect}`)
  // The hook_event_name a hook sees is the spelling the event fired under
  // when one was given, or the dialect's own name for the canonical event.
  const hookEvent =
    events[eventName] !== undefined ? eventName : dialect === 'native' ? canonical : namesFor(dialect, canonical)[0] ?? eventName
  const base = {
    session_id: data.sessionId ?? '',
    transcript_path: data.transcriptPath ?? '',
    cwd: data.cwd ?? process.cwd(),
    hook_event_name: hookEvent,
  }
  if (dialect !== 'native') base.permission_mode = 'default'

  const extra = {}
  if (canonical === 'tool:before' || canonical === 'tool:after') {
    if (data.toolName !== undefined) extra.tool_name = data.toolName
    if (data.toolInput !== undefined) extra.tool_input = data.toolInput
    if (data.toolUseId !== undefined) extra.tool_use_id = data.toolUseId
    if (canonical === 'tool:after' && data.toolResponse !== undefined) extra.tool_response = data.toolResponse
  } else if (canonical === 'prompt:submit') {
    if (data.prompt !== undefined) extra.prompt = data.prompt
  } else if (canonical === 'session:start') {
    if (data.source !== undefined) extra.source = data.source
  } else if (canonical === 'session:end') {
    if (data.reason !== undefined) extra.reason = data.reason
  } else if (canonical === 'turn:stop') {
    extra.stop_hook_active = data.stopHookActive ?? false
  } else if (canonical === 'subagent:start' || canonical === 'subagent:end') {
    if (data.agentId !== undefined) extra.agent_id = data.agentId
    if (data.agentType !== undefined) extra.agent_type = data.agentType
    if (canonical === 'subagent:end') extra.stop_hook_active = data.stopHookActive ?? false
  }

  if (dialect === 'native') {
    return { event: canonical, ts: new Date().toISOString(), ...base, ...extra }
  }
  return { ...base, ...extra }
}

/** Convenience: the meta entry for a canonical event. */
export function metaFor(canonical) {
  return EVENT_META[canonical]
}
