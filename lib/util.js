/**
 * Small shared helpers: token interpolation, env expansion, logging, ids.
 * @module hooks-adapter/util
 */

import { randomUUID } from 'node:crypto'

/** Replace `${TOKEN}` occurrences with `vars[TOKEN]`; unknown tokens stay verbatim. */
export function substituteTokens(text, vars) {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
}

/** Expand `$NAME` / `${NAME}` from `env` (defaults to process.env); unknown names stay verbatim. */
export function expandEnv(text, env = process.env) {
  return text.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (whole, braced, bare) => {
    const name = braced ?? bare
    return name in env ? String(env[name]) : whole
  })
}

/** A tiny leveled logger writing to a stream (stderr by default). */
export function createLogger(stream = process.stderr) {
  const write = (level, parts) => {
    stream.write(`[hooks-adapter:${level}] ${parts.map(String).join(' ')}\n`)
  }
  return {
    debug: (...parts) => write('debug', parts),
    info: (...parts) => write('info', parts),
    warn: (...parts) => write('warn', parts),
    error: (...parts) => write('error', parts),
  }
}

/** A logger that swallows everything (used when the caller logs itself). */
export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** A short unique id for hook invocations. */
export function randomId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}
