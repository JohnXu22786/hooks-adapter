/**
 * The stdio serve mode: a line-delimited JSON protocol that lets any host
 * (a harness, a script, a test) drive this runtime without importing it.
 * Protocol (one request per line on stdin, one response per line on stdout):
 *
 *   {"op":"ping"}                         -> {"ok":true,"pong":true}
 *   {"op":"dispatch","event":"PreToolUse","payload":{...}}
 *                                         -> {"ok":true,"outcome":{...},"runs":[...]}
 *   {"op":"reload"}                       -> {"ok":true,"diagnostics":[...]}
 *   {"op":"bye"}                          -> {"ok":true} then exit 0
 *
 * All logging goes to stderr so stdout stays machine-readable.
 * @module hooks-adapter/serve
 */

import readline from 'node:readline'
import { loadRuntime } from './config.js'
import { dispatchEvent } from './dispatch.js'

/** Serialize a dispatch run for the wire (no functions, no circularity). */
export function runToWire(run) {
  return {
    hook: {
      id: run.hook.id,
      dialect: run.hook.dialect,
      event: run.hook.event,
      kind: run.hook.kind,
      ...(run.hook.matcher !== undefined ? { matcher: run.hook.matcher } : {}),
    },
    outcome: run.outcome,
    durationMs: run.durationMs,
    ...(run.error !== undefined ? { error: run.error } : {}),
  }
}

/**
 * Serve the protocol until stdin closes or a `bye` arrives.
 * @param options - runtime options (reloadable); `io` defaults to process stdio.
 */
export async function serve(options = {}, io = process) {
  let runtime = loadRuntime(options)
  const lines = readline.createInterface({ input: io.stdin })

  const respond = (obj) => io.stdout.write(JSON.stringify(obj) + '\n')

  for await (const line of lines) {
    if (line.trim() === '') continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      respond({ ok: false, error: 'request is not valid JSON' })
      continue
    }
    try {
      const op = request?.op
      if (op === 'ping') {
        respond({ ok: true, pong: true })
      } else if (op === 'dispatch') {
        if (typeof request.event !== 'string') throw new Error('dispatch requires an event name')
        const payload = request.payload ?? {}
        const result = await dispatchEvent(runtime, request.event, payload, {
          subject: request.subject,
          cwd: request.cwd,
        })
        respond({
          ok: true,
          canonical: result.canonical,
          outcome: result.outcome,
          runs: result.runs.map(runToWire),
        })
      } else if (op === 'reload') {
        runtime = loadRuntime(options)
        respond({ ok: true, diagnostics: runtime.diagnostics })
      } else if (op === 'bye') {
        respond({ ok: true })
        return
      } else {
        throw new Error(`unknown op ${JSON.stringify(op)}`)
      }
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
