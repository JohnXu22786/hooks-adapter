/**
 * Runtime assembly: discover config files, parse them in precedence order,
 * honor the `disableAllHooks` settings flag, and build the merged matcher
 * group table used by dispatch.
 * @module hooks-adapter/config
 */

import { readFileSync } from 'node:fs'
import { discoverFiles, dialectForFile } from './discover.js'
import { parseConfigText } from './parse.js'
import { canonicalFor } from './events.js'
import { silentLogger } from './util.js'

/** Defaults applied to every runtime. */
export const DEFAULT_OPTIONS = {
  onError: 'warn',
  timeoutSec: undefined,
  llm: null,
  proxy: null,
  projectDir: undefined,
  pluginRoot: undefined,
  stderrCap: 500,
}

/**
 * Build a runtime from options:
 * - `configPath` — an explicit single config file (skips discovery)
 * - `discover` (default true) — scan the standard locations
 * - `cwd` / `homeDir` — where to look (defaults: process cwd / user home)
 * - `projectDir` / `pluginRoot` — substitution roots
 * - `llm` — { baseUrl, model, apiKey? } for oracle handlers
 * - `proxy` — { command } default runner for proxy handlers
 * - `onError` — global handler-failure policy (ignore/warn/block)
 * - `timeoutSec` — global timeout override for all handler kinds
 * - `logger` — logger used at dispatch time
 */
export function loadRuntime(options = {}) {
  const logger = options.logger ?? silentLogger
  const opts = { ...DEFAULT_OPTIONS, ...options }
  // Environment override equivalent to --config; an explicit option wins.
  if (opts.configPath === undefined && process.env.HOOKS_ADAPTER_CONFIG) {
    opts.configPath = process.env.HOOKS_ADAPTER_CONFIG
  }
  const diagnostics = []
  const groups = new Map()

  let enabled = true
  const sources = []

  if (opts.configPath !== undefined) {
    const entry = { file: opts.configPath, dialect: dialectForFile(opts.configPath), scope: 'explicit' }
    enabled = mergeSource(entry, opts, groups, sources, diagnostics, enabled)
  } else if (opts.discover !== false) {
    for (const entry of discoverFiles(opts)) {
      enabled = mergeSource(entry, opts, groups, sources, diagnostics, enabled)
    }
  }

  if (!enabled) {
    groups.clear()
    logger.info('hooks disabled by settings (disableAllHooks)')
  }

  return {
    enabled,
    groups,
    sources,
    options: opts,
    logger,
    diagnostics,
  }
}

/** Track `disableAllHooks` while parsing a source; returns the new enabled state. */
function mergeSource(entry, opts, groups, sources, diagnostics, enabled) {
  let text
  try {
    text = readFileSync(entry.file, 'utf8')
  } catch (error) {
    diagnostics.push({ severity: 'error', file: entry.file, message: `cannot read config: ${error.message}` })
    return enabled
  }
  const { groups: parsed, diagnostics: fileDiagnostics, raw } = parseConfigText(text, entry.dialect, {
    projectDir: opts.projectDir,
    pluginRoot: opts.pluginRoot,
  }, entry.file)
  diagnostics.push(...fileDiagnostics)
  // The disableAllHooks flag exists in claude settings files; a later file
  // overrides an earlier one (local > project > global).
  if (raw !== undefined && typeof raw === 'object' && raw !== null && typeof raw.disableAllHooks === 'boolean') {
    enabled = !raw.disableAllHooks
  }
  // Groups are bucketed by their CANONICAL event so that dispatch can run
  // every dialect's hooks for one event, whatever spelling it uses.
  for (const group of parsed) {
    const key = group.canonical ?? canonicalFor(group.dialect, group.event) ?? group.event
    const list = groups.get(key)
    if (list) list.push(group)
    else groups.set(key, [group])
  }
  sources.push({ file: entry.file, dialect: entry.dialect, scope: entry.scope, groups: parsed.length })
  return enabled
}
