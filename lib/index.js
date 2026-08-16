#!/usr/bin/env node
/**
 * hooks-adapter CLI and programmatic entry.
 *
 * Commands:
 *   validate [--config FILE] [--strict] [--json]   check configs, exit 0/1
 *   run --event NAME [--payload FILE] [--subject S] [--config FILE]
 *                                                  dispatch once, exit 0/2/1
 *   listen [--config FILE]                          serve the stdio protocol
 *   dump [--config FILE]                            print the merged config
 *   list                                            print discovered files
 *
 * The JSON result of a command is written as one line on stdout; logs and
 * human diagnostics go to stderr, so stdout stays machine-readable.
 * @module hooks-adapter
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadRuntime } from './config.js'
import { dispatchEvent } from './dispatch.js'
import { serve, runToWire } from './serve.js'
import { discoverFiles } from './discover.js'
import { DIALECTS, CANONICAL_EVENTS } from './events.js'
import { createLogger } from './util.js'

export {
  loadRuntime,
  dispatchEvent,
  serve,
  discoverFiles,
  DIALECTS,
  CANONICAL_EVENTS,
}
export * from './parse.js'
export * from './contract.js'
export * from './execute.js'
export * from './events.js'
export * from './config.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function usage() {
  return `hooks-adapter ${VERSION} — run harness hooks configs on this harness

usage: hooks-adapter <command> [flags]

commands:
  validate  check every discoverable config file; exit 1 on problems
  run       dispatch one event with a payload; exit 2 when denied
  listen    serve the line-delimited JSON protocol over stdio
  dump      print the merged effective configuration as JSON
  list      print the config files discovery found
  help      show this text
  version   print the version

flags:
  --config FILE   use exactly this config file instead of discovery
  --home DIR      home directory used for discovery
  --cwd DIR       working directory used for discovery
  --event NAME    event to dispatch (run)
  --payload FILE  payload JSON file for the event (run; default: stdin)
  --subject S     matcher subject override (run)
  --strict        treat warnings as errors (validate)
  --json          machine-readable output (validate)
  --timeout N     global default timeout in seconds
  --llm-base-url URL  LLM endpoint for oracle hooks (run; needs --llm-model)
  --llm-model NAME    model name for oracle hooks (run)
  --llm-key KEY       API key for the LLM endpoint (run; optional)
  --help, -h      show this text
`
}

/** Minimal flag parsing: `--name value` or `--name=value`. */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const name = arg.slice(2)
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[name] = argv[++i]
        } else {
          flags[name] = true
        }
      }
    } else if (arg === '-h') {
      flags.help = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function runtimeOptions(flags) {
  const options = {
    ...(typeof flags.config === 'string' ? { configPath: flags.config } : {}),
    ...(typeof flags.home === 'string' ? { homeDir: flags.home } : {}),
    ...(typeof flags.cwd === 'string' ? { cwd: flags.cwd } : {}),
    logger: createLogger(process.stderr),
  }
  if (typeof flags.timeout === 'string') {
    const value = Number(flags.timeout)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid --timeout value ${JSON.stringify(flags.timeout)}`)
    }
    options.timeoutSec = value
  }
  const llmBase = flags['llm-base-url']
  const llmModel = flags['llm-model']
  if (llmBase !== undefined || llmModel !== undefined) {
    if (typeof llmBase !== 'string' || typeof llmModel !== 'string') {
      throw new Error('--llm-base-url and --llm-model must be provided together')
    }
    options.llm = {
      baseUrl: llmBase,
      model: llmModel,
      ...(typeof flags['llm-key'] === 'string' ? { apiKey: flags['llm-key'] } : {}),
    }
  }
  return options
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = flags.version ? 'version' : flags.help ? 'help' : positional[0] ?? 'help'
  const logger = createLogger(process.stderr)

  if (command === 'help' || command === 'version') {
    process.stdout.write(command === 'help' ? usage() : `${VERSION}\n`)
    return 0
  }

  if (command === 'validate') {
    const runtime = loadRuntime(runtimeOptions(flags))
    if (flags.json) {
      process.stdout.write(JSON.stringify({ diagnostics: runtime.diagnostics }) + '\n')
    } else {
      for (const d of runtime.diagnostics) {
        logger.warn(`[${d.severity}] ${d.file ? `${d.file}: ` : ''}${d.message}`)
      }
      if (runtime.diagnostics.length === 0) logger.info('no problems found')
    }
    const errors = runtime.diagnostics.filter((d) => d.severity === 'error').length
    const warnings = runtime.diagnostics.filter((d) => d.severity === 'warning').length
    return errors > 0 || (flags.strict && warnings > 0) ? 1 : 0
  }

  if (command === 'run') {
    if (typeof flags.event !== 'string') {
      logger.error('run requires --event <name>')
      return 1
    }
    let payloadText
    if (typeof flags.payload === 'string') {
      try {
        payloadText = readFileSync(flags.payload, 'utf8')
      } catch (err) {
        logger.error(`cannot read payload ${flags.payload}: ${err.message}`)
        return 1
      }
    } else {
      payloadText = readFileSync(0, 'utf8')
    }
    let payload
    try {
      payload = JSON.parse(payloadText)
    } catch (err) {
      logger.error(`payload is not valid JSON: ${err.message}`)
      return 1
    }
    const runtime = loadRuntime(runtimeOptions(flags))
    for (const d of runtime.diagnostics) {
      if (d.severity === 'error') logger.error(`[error] ${d.file ? `${d.file}: ` : ''}${d.message}`)
    }
    try {
      const result = await dispatchEvent(runtime, flags.event, payload, {
        subject: flags.subject,
        cwd: flags.cwd,
      })
      process.stdout.write(JSON.stringify({ outcome: result.outcome, runs: result.runs.map(runToWire), canonical: result.canonical }) + '\n')
      return result.outcome.decision === 'deny' ? 2 : 0
    } catch (err) {
      logger.error(String(err instanceof Error ? err.message : err))
      return 1
    }
  }

  if (command === 'listen') {
    await serve(runtimeOptions(flags))
    return 0
  }

  if (command === 'dump') {
    const runtime = loadRuntime(runtimeOptions(flags))
    const groups = Object.fromEntries(
      [...runtime.groups.entries()].map(([event, list]) => [event, list.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h })) }))]),
    )
    process.stdout.write(JSON.stringify({ enabled: runtime.enabled, sources: runtime.sources, groups }) + '\n')
    return 0
  }

  if (command === 'list') {
    for (const entry of discoverFiles(runtimeOptions(flags))) {
      process.stdout.write(`${entry.scope}\t${entry.dialect}\t${entry.file}\n`)
    }
    return 0
  }

  logger.error(`unknown command ${JSON.stringify(command)}\n${usage()}`)
  return 1
}

// Only run the CLI when this module is the entry point; importing it
// programmatically must not parse the host's argv. Windows paths compare
// case-insensitively so `node .\LIB\index.js` still counts as the entry.
const isEntry =
  process.argv[1] !== undefined &&
  (() => {
    const here = import.meta.url
    const invoked = pathToFileURL(process.argv[1]).href
    return process.platform === 'win32' ? here.toLowerCase() === invoked.toLowerCase() : here === invoked
  })()
if (isEntry) {
  try {
    process.exitCode = await main()
  } catch (err) {
    createLogger(process.stderr).error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
