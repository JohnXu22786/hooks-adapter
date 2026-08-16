/**
 * The dispatch pipeline: match configured groups against an event, run the
 * selected hooks in order, fold their outcomes, and enforce the event's
 * blockability.
 * @module hooks-adapter/dispatch
 */

import { resolveEventName, EVENT_META, DIALECTS, namesFor, subjectFor, matches } from './events.js'
import { executeHook } from './execute.js'
import { foldOutcomes } from './contract.js'

/**
 * When one canonical event has several dialect spellings (claude's
 * PostToolUse / PostToolUseFailure both map onto `tool:after`), the spelling
 * used at dispatch selects which groups run: a group configured under a
 * different spelling stays quiet, and groups configured under the canonical
 * name itself always run. Single-spelling events run every group.
 */
function selectGroups(groups, eventName, canonical) {
  if (eventName === canonical) return groups
  const spellings = new Set([canonical])
  for (const dialect of Object.keys(DIALECTS)) {
    for (const name of namesFor(dialect, canonical)) spellings.add(name)
  }
  if (spellings.size <= 1) return groups
  return groups.filter((group) => group.event === eventName || group.event === canonical)
}

/**
 * Dispatch one event.
 * @param runtime - a runtime from `loadRuntime`
 * @param eventName - any accepted event name (canonical or dialect name);
 * every dialect's groups that map to the same canonical event run
 * @param payload - the event payload handed to the hooks on stdin
 * @param opts - `{ subject?, cwd?, signal?, onInvoke?, onResult? }`
 * @returns `{ outcome, runs, canonical, meta }` — `runs` records each hook
 * execution with its decoded outcome and duration.
 */
export async function dispatchEvent(runtime, eventName, payload, opts = {}) {
  const resolved = resolveEventName(eventName)
  if (!resolved) throw new Error(`unknown event ${JSON.stringify(eventName)}`)
  const canonical = resolved.canonical
  const meta = EVENT_META[canonical]
  const subject = opts.subject ?? subjectFor(canonical, payload ?? {})
  const groups = selectGroups(runtime.groups.get(canonical) ?? [], eventName, canonical)
  const runs = []

  for (const group of groups) {
    const mode = DIALECTS[group.dialect].matcherMode
    if (!matches(group.matcher, subject, mode)) continue
    for (const hook of group.hooks) {
      const invoke = { hook, subject, event: eventName, canonical }
      opts.onInvoke?.(invoke)
      const { outcome, durationMs, error } = await executeHook(runtime, hook, {
        payload,
        cwd: opts.cwd,
        // The discriminator a hook may claim in hookSpecificOutput is the
        // spelling the event fired under.
        expectedEvent: eventName,
        signal: opts.signal,
      })
      const run = { hook, outcome, durationMs, error }
      runs.push(run)
      opts.onResult?.(run)
    }
  }

  const outcome = foldOutcomes(
    runs.map((r) => r.outcome),
    meta,
  )
  let downgraded = false
  if (outcome.decision === 'deny' && !meta.blockable) {
    // The event cannot be stopped; keep the information, drop the block.
    outcome.rawDecision = 'deny'
    outcome.rawReason = outcome.reason
    outcome.decision = 'none'
    outcome.reason = undefined
    downgraded = true
  }
  outcome.downgraded = downgraded

  if (outcome.updateInputs.length > 0) {
    runtime.logger.warn(`hook requested updatedInput on ${eventName}, which is parsed but not honored`)
  }

  return { outcome, runs, canonical, meta }
}
