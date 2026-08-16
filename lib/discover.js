/**
 * Config file discovery: the standard locations for each harness dialect,
 * resolved against a home directory and a working directory.
 * @module hooks-adapter/discover
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** All candidate locations, in application order (later wins on merge). */
export function candidateFiles(options) {
  const home = options.homeDir ?? process.env.HOOKS_ADAPTER_HOME ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const configHome = join(home, '.config')
  return [
    { file: join(home, '.claude', 'settings.json'), dialect: 'claude', scope: 'global' },
    { file: join(home, '.codex', 'hooks.json'), dialect: 'codex', scope: 'global' },
    { file: join(configHome, 'opencode', 'opencode.json'), dialect: 'opencode', scope: 'global' },
    { file: join(configHome, 'hooks-adapter', 'hooks.json'), dialect: 'native', scope: 'global' },
    { file: join(cwd, '.claude', 'settings.json'), dialect: 'claude', scope: 'project' },
    { file: join(cwd, '.codex', 'hooks.json'), dialect: 'codex', scope: 'project' },
    { file: join(cwd, 'opencode.json'), dialect: 'opencode', scope: 'project' },
    { file: join(cwd, '.dsh-hooks.json'), dialect: 'native', scope: 'project' },
    { file: join(cwd, '.claude', 'settings.local.json'), dialect: 'claude', scope: 'local' },
  ]
}

/** The files that actually exist, in application order (deduplicated). */
export function discoverFiles(options) {
  const seen = new Set()
  const out = []
  for (const entry of candidateFiles(options)) {
    if (seen.has(entry.file)) continue
    seen.add(entry.file)
    if (existsSync(entry.file)) out.push(entry)
  }
  return out
}

/** Guess the dialect of an explicitly configured file from its name. */
export function dialectForFile(file) {
  const name = file.replace(/\\/g, '/').split('/').pop()
  if (name === 'settings.json' || name === 'settings.local.json') return 'claude'
  if (name === 'hooks.json') return 'codex'
  if (name === 'opencode.json' || name === 'opencode.jsonc') return 'opencode'
  if (name === '.dsh-hooks.json' || name === 'dsh-hooks.json') return 'native'
  return 'claude'
}
