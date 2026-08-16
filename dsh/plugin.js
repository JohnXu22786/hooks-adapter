/**
 * The dsh (DeepSeek Harness) plugin entry.
 *
 * This module is what the harness loads: a Cordis plugin with `name`,
 * optional `inject`, and `apply(ctx, config)`. It subscribes to the harness
 * extension points, maps them onto the hooks events, runs the configured
 * hooks, and maps the folded decisions back onto the harness extension
 * points (reject / deny / ask / block / steer / inject).
 *
 * Mapping (harness event -> hooks event):
 *   agent/session-start        -> SessionStart   (inject context)
 *   session/disposed           -> SessionEnd     (observe)
 *   agent/pre-step (waterfall) -> UserPromptSubmit (reject or add context)
 *   tools/pre-execute          -> PreToolUse     (deny / ask)
 *   tools/post-execute         -> PostToolUse / PostToolUseFailure (block, add context)
 *   agent/turn-stopping        -> Stop           (steer to continue)
 *   subagent/start|end         -> SubagentStart / SubagentStop
 *
 * Configuration (the plugin row's `config`):
 *   configPath   explicit single config file (default: discovery)
 *   discover     scan the standard locations (default true)
 *   cwd, homeDir discovery roots
 *   projectDir, pluginRoot    ${CLAUDE_PROJECT_DIR} / ${CLAUDE_PLUGIN_ROOT}
 *   llm          { baseUrl, model, apiKey? } for oracle hooks
 *   proxy        { command } default runner for proxy hooks
 *   timeoutSec, onError, stderrCap   runtime defaults
 */

import { randomUUID } from 'node:crypto'
import { loadRuntime } from '../lib/config.js'
import { dispatchEvent } from '../lib/dispatch.js'
import { buildPayload } from '../lib/contract.js'
import { canonicalFor } from '../lib/events.js'

export const name = 'hooks-adapter'
// No hard service dependencies: optional services are looked up lazily via
// ctx.get so the plugin also loads on a minimal deployment.
export const inject = []

/** The agent_type reported for subagent hooks (harness subagents carry no kind label). */
const SUBAGENT_TYPE = 'general-purpose'

/** Stable id of the source stamped on injected context. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

export function apply(ctx, config = {}) {
  const options = {
    cwd: process.cwd(),
    ...config,
    logger: loggerOf(ctx),
  }
  const runtime = loadRuntime(options)
  const diagnostics = runtime.diagnostics
  for (const d of diagnostics) {
    ctx.logger.warn(`hooks-adapter: [${d.severity}] ${d.file ? `${d.file}: ` : ''}${d.message}`)
  }

  // Track detached runs so disposal aborts them and drains continuations.
  const controller = new AbortController()
  const inflight = new Set()
  const track = (promise) => {
    inflight.add(promise)
    const settled = () => inflight.delete(promise)
    void promise.then(settled, settled)
  }
  ctx.effect(() => async () => {
    controller.abort(new Error('hooks-adapter disposed'))
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }, 'hooks-adapter: drain detached hook runs')

  // Subagent children are retained through their paired end so stop hooks
  // keep the child's session workspace after it unregisters.
  const subagentChildren = new Map()

  /** Make a user-role message for inject/steer; falls back to a plain shape. */
  let messageFactory
  const userMessage = async (content) => {
    if (!messageFactory) {
      try {
        const llm = await import('@deepseek-ai/dsh-llm')
        messageFactory = llm.createUserMessage
      } catch {
        messageFactory = ({ content: blocks, source }) => ({
          id: `msg_${randomUUID()}`,
          role: 'user',
          content: blocks,
          source,
        })
      }
    }
    return messageFactory({ content, source: PLUGIN_SOURCE })
  }

  const blocks = (texts) => texts.map((text) => ({ type: 'text', text }))

  /** The last open turn number in the agent's log, or 0. */
  const lastTurn = (agent) => {
    if (!agent?.session?.events) return 0
    let turn = 0
    for (const event of agent.session.events) {
      if (event.type === 'turn/start') turn = event.data.turn
    }
    return turn
  }

  /** Transcript path when session persistence exposes one. */
  const transcriptPath = (session) => {
    try {
      return ctx.get('sessionPersistence')?.locate?.(session.header)?.path ?? ''
    } catch {
      return ''
    }
  }

  const baseData = (agent) => {
    const header = agent?.session?.header ?? {}
    return {
      sessionId: header.id ?? '',
      cwd: header.cwd ?? process.cwd(),
      transcriptPath: agent?.session ? transcriptPath(agent.session) : '',
    }
  }

  /** Record a hook invocation/result pair on the session log when possible. */
  const recordInvoke = (agent, turn, info) => {
    const session = agent?.session
    if (!session?.append || typeof turn !== 'number' || turn <= 0) return
    try {
      session.append('hook/invoked', {
        turn,
        point: info.event,
        dialect: 'adapter',
        handlerId: info.hook.id,
        ...(info.hook.matcher !== undefined ? { matcher: info.hook.matcher } : {}),
      })
    } catch {
      // log-only record; never break the session for it
    }
  }
  const recordResult = (agent, turn, info) => {
    const session = agent?.session
    if (!session?.append || typeof turn !== 'number' || turn <= 0) return
    const cap = runtime.options.stderrCap ?? 500
    const summary = info.outcome.stderr.trim()
    try {
      session.append('hook/result', {
        turn,
        point: info.event,
        handlerId: info.hook.id,
        decision: info.outcome.decision ?? (info.outcome.stop ? 'stop' : 'pass'),
        ...(info.outcome.exitCode !== undefined ? { exitCode: info.outcome.exitCode } : {}),
        ...(summary.length > 0 ? { stderrSummary: summary.length > cap ? `${summary.slice(0, cap)}…` : summary } : {}),
        durationMs: info.durationMs,
      })
    } catch {
      // log-only record; never break the session for it
    }
  }

  /** Run every hook configured for a point; fold; optionally record the runs. */
  async function runPoint(point, subject, payload, { agent, turn, signal }) {
    const result = await dispatchEvent(runtime, point, payload, {
      subject,
      cwd: agent?.session?.header?.cwd ?? process.cwd(),
      expectedEvent: point,
      signal: signal ?? controller.signal,
      onInvoke: (info) => recordInvoke(agent, turn, info),
      onResult: (info) => recordResult(agent, turn, info),
    })
    return result
  }

  const contextMessage = async (result) => {
    if (result.outcome.contexts.length === 0) return undefined
    return userMessage(blocks(result.outcome.contexts))
  }

  // --- SessionStart: inject context when the hook resolves ---
  ctx.on('agent/session-start', ({ agent, source }) => {
    if (!agent) return
    const payload = buildPayload('claude', canonicalFor('claude', 'SessionStart'), { ...baseData(agent), source: source ?? '' })
    track(
      runPoint('SessionStart', source ?? '', payload, { agent, signal: controller.signal })
        .then(async (result) => {
          const message = await contextMessage(result)
          if (message) agent.inject(message)
        })
        .catch((err) => ctx.logger.warn(`hooks-adapter: SessionStart hook failed: ${String(err)}`)),
    )
  })

  // --- SessionEnd: observe only ---
  ctx.on('session/disposed', (session) => {
    if (!session?.header) return
    const payload = buildPayload('claude', canonicalFor('claude', 'SessionEnd'), {
      sessionId: session.header.id ?? '',
      cwd: session.header.cwd ?? process.cwd(),
      transcriptPath: transcriptPath(session),
      // The harness does not expose the end reason on this event; a matcher
      // on reason can only be satisfied by match-all groups here.
      reason: '',
    })
    track(
      runPoint('SessionEnd', '', payload, { signal: controller.signal }).catch((err) =>
        ctx.logger.warn(`hooks-adapter: SessionEnd hook failed: ${String(err)}`),
      ),
    )
  })

  // --- UserPromptSubmit: reject or add context ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (!messages || messages.length === 0) return next()
    const text = blocksToText(messages.flatMap((m) => m.content ?? []))
    const payload = buildPayload('claude', canonicalFor('claude', 'UserPromptSubmit'), { ...baseData(agent), prompt: text })
    const result = await runPoint('UserPromptSubmit', '', payload, { agent, turn, signal })
    if (result.outcome.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const message = await contextMessage(result)
    if (!message || downstream.kind !== 'enter') return downstream
    return { kind: 'enter', messages: [...downstream.messages, message] }
  })

  // --- PreToolUse: deny / ask ---
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec) return next()
    const payload = buildPayload('claude', canonicalFor('claude', 'PreToolUse'), {
      ...baseData(exec.agent),
      toolName: exec.name,
      toolInput: exec.arguments,
      toolUseId: exec.callId,
    })
    const result = await runPoint('PreToolUse', exec.name ?? '', payload, {
      agent: exec.agent,
      turn: lastTurn(exec.agent),
      signal: exec.signal,
    })
    if (result.outcome.decision === 'deny') {
      return { kind: 'deny', reason: result.outcome.reason ?? 'blocked by PreToolUse hook' }
    }
    if (result.outcome.decision === 'ask') {
      return { kind: 'ask', ...(result.outcome.reason !== undefined ? { reason: result.outcome.reason } : {}) }
    }
    return next()
  })

  // --- PostToolUse / PostToolUseFailure: block or add context ---
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!exec) return next()
    const failed = result?.isError === true
    const point = failed ? 'PostToolUseFailure' : 'PostToolUse'
    const payload = buildPayload('claude', canonicalFor('claude', point), {
      ...baseData(exec.agent),
      toolName: exec.name,
      toolInput: exec.arguments,
      toolUseId: exec.callId,
      toolResponse: blocksToText(result?.content ?? []),
    })
    const outcome = await runPoint(point, exec.name ?? '', payload, {
      agent: exec.agent,
      turn: lastTurn(exec.agent),
      signal: exec.signal,
    })
    const message = await contextMessage(outcome)
    // tool:after cannot stop the tool (it already ran), so dispatch downgrades
    // a denial to `none` and keeps the raw decision; on this extension point
    // the denial maps to replacing the recorded result with feedback.
    const denied = outcome.outcome.decision === 'deny' || outcome.outcome.rawDecision === 'deny'
    if (denied) {
      const reason = outcome.outcome.reason ?? outcome.outcome.rawReason ?? `blocked by ${point} hook`
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: reason }],
        ...(message ? { additionalContexts: [message] } : {}),
      }
    }
    const downstream = await next()
    if (!message) return downstream
    return { ...downstream, additionalContexts: [message, ...(downstream.additionalContexts ?? [])] }
  })

  // --- Stop: steer to continue when denied ---
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!agent) return
    const payload = buildPayload('claude', canonicalFor('claude', 'Stop'), { ...baseData(agent), stopHookActive: false })
    const result = await runPoint('Stop', '', payload, { agent, turn, signal })
    if (result.outcome.decision === 'deny') {
      const text = result.outcome.reason ?? 'continue: blocked by Stop hook'
      agent.steer(await userMessage(blocks([text])))
    }
  })

  // --- SubagentStart / SubagentStop ---
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info?.id)
    if (child !== undefined) subagentChildren.set(info?.runId, child)
    const payload = buildPayload('claude', canonicalFor('claude', 'SubagentStart'), {
      ...baseData(child),
      agentId: info?.id,
      agentType: SUBAGENT_TYPE,
    })
    track(
      runPoint('SubagentStart', SUBAGENT_TYPE, payload, { agent: child, signal: controller.signal })
        .then(async (result) => {
          const message = await contextMessage(result)
          if (message && child) child.inject(message)
        })
        .catch((err) => ctx.logger.warn(`hooks-adapter: SubagentStart hook failed: ${String(err)}`)),
    )
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info?.runId) ?? ctx.get('agents')?.get(info?.id)
    subagentChildren.delete(info?.runId)
    const payload = buildPayload('claude', canonicalFor('claude', 'SubagentStop'), {
      ...baseData(child),
      agentId: info?.id,
      agentType: SUBAGENT_TYPE,
      stopHookActive: false,
    })
    track(
      runPoint('SubagentStop', SUBAGENT_TYPE, payload, { agent: child, signal: controller.signal }).catch((err) =>
        ctx.logger.warn(`hooks-adapter: SubagentStop hook failed: ${String(err)}`),
      ),
    )
  })
}

/** Flatten content blocks to the text a hook payload carries. */
function blocksToText(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** A logger adapting to the harness context when present. */
function loggerOf(ctx) {
  return {
    debug: (...args) => ctx.logger?.debug?.(...args),
    info: (...args) => ctx.logger?.info?.(...args),
    warn: (...args) => ctx.logger?.warn?.(...args),
    error: (...args) => ctx.logger?.error?.(...args),
  }
}
