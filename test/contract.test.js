import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeOutcome, foldOutcomes, buildPayload, applyStructuredFields } from '../lib/contract.js'

test('decode: exit 0 with structured JSON decision', () => {
  const out = decodeOutcome(0, JSON.stringify({ decision: 'block', reason: 'no way' }), '', 'PreToolUse')
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'no way')
  assert.equal(out.stop, false)
})

test('decode: exit 0 with permissionDecision and reason', () => {
  const out = decodeOutcome(
    0,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'destructive',
      },
    }),
    '',
    'PreToolUse',
  )
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'destructive')
})

test('decode: hookEventName mismatch discards event-scoped fields', () => {
  const out = decodeOutcome(
    0,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        permissionDecision: 'deny',
        additionalContext: 'should be dropped',
      },
    }),
    '',
    'PreToolUse',
  )
  assert.equal(out.decision, undefined)
  assert.deepEqual(out.contexts, [])
})

test('decode: continue:false with stopReason', () => {
  const out = decodeOutcome(0, JSON.stringify({ continue: false, stopReason: 'not done' }), '', 'Stop')
  assert.equal(out.stop, true)
  assert.equal(out.stopReason, 'not done')
})

test('decode: additionalContext and systemMessage are collected', () => {
  const out = decodeOutcome(
    0,
    JSON.stringify({ additionalContext: 'context text', systemMessage: 'heads up' }),
    '',
    'Stop',
  )
  assert.deepEqual(out.contexts, ['context text'])
  assert.deepEqual(out.messages, ['heads up'])
})

test('decode: exit 2 blocks with stderr as reason', () => {
  const out = decodeOutcome(2, 'ignored', 'blocked by hook', 'PreToolUse')
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'blocked by hook')
})

test('decode: exit 2 without stderr uses a default reason', () => {
  const out = decodeOutcome(2, '', '', 'PreToolUse')
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'blocked by hook')
})

test('decode: exit 3 is a non-blocking error', () => {
  const out = decodeOutcome(3, '', 'something broke', 'PreToolUse')
  assert.equal(out.decision, undefined)
  assert.equal(out.stderr, 'something broke')
})

test('decode: exit 0 with plain stdout keeps the text', () => {
  const out = decodeOutcome(0, 'just some context', '', 'SessionStart')
  assert.equal(out.stdout, 'just some context')
  assert.equal(out.decision, undefined)
})

test('decode: malformed JSON on exit 0 is plain text, not a crash', () => {
  const out = decodeOutcome(0, '{oops', '', 'PreToolUse')
  assert.equal(out.decision, undefined)
  assert.equal(out.stdout, '{oops')
})

test('decode: missing exit code (infra failure) is a non-blocking error', () => {
  const out = decodeOutcome(undefined, '', 'spawn failed', 'PreToolUse')
  assert.equal(out.decision, undefined)
  assert.equal(out.stderr, 'spawn failed')
})

test('applyStructuredFields: ok:false maps to deny with reason', () => {
  const out = {}
  applyStructuredFields(out, { ok: false, reason: 'model says no' }, 'PreToolUse')
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'model says no')
})

test('applyStructuredFields: ok:true leaves no decision', () => {
  const out = {}
  applyStructuredFields(out, { ok: true }, 'PreToolUse')
  assert.equal(out.decision, undefined)
})

test('fold: deny beats ask beats allow, reasons of the winner are joined', () => {
  const folded = foldOutcomes([
    decodeOutcome(0, JSON.stringify({ decision: 'approve', reason: 'fine' }), '', 'PreToolUse'),
    decodeOutcome(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'maybe' } }), '', 'PreToolUse'),
    decodeOutcome(0, JSON.stringify({ decision: 'block', reason: 'no1' }), '', 'PreToolUse'),
    decodeOutcome(0, JSON.stringify({ decision: 'block', reason: 'no2' }), '', 'PreToolUse'),
  ])
  assert.equal(folded.decision, 'deny')
  assert.equal(folded.reason, 'no1\n\nno2')
})

test('fold: allow alone yields allow', () => {
  const folded = foldOutcomes([
    decodeOutcome(0, JSON.stringify({ decision: 'approve' }), '', 'PreToolUse'),
  ])
  assert.equal(folded.decision, 'allow')
})

test('fold: no decisions yield none', () => {
  const folded = foldOutcomes([decodeOutcome(0, 'plain', '', 'SessionStart'), decodeOutcome(3, '', 'err', 'SessionStart')])
  assert.equal(folded.decision, 'none')
})

test('fold: first stop is sticky, contexts accumulate in hook order', () => {
  const folded = foldOutcomes([
    decodeOutcome(0, JSON.stringify({ continue: false, stopReason: 'first' }), '', 'Stop'),
    decodeOutcome(0, JSON.stringify({ continue: false, stopReason: 'second' }), '', 'Stop'),
    decodeOutcome(0, JSON.stringify({ additionalContext: 'a' }), '', 'Stop'),
    decodeOutcome(0, JSON.stringify({ additionalContext: 'b' }), '', 'Stop'),
  ])
  assert.equal(folded.stop, true)
  assert.equal(folded.stopReason, 'first')
  assert.deepEqual(folded.contexts, ['a', 'b'])
})

test('fold: plain stdout becomes context when the event wants it', () => {
  const folded = foldOutcomes([decodeOutcome(0, 'git status output', '', 'SessionStart')], { contextFromStdout: true })
  assert.deepEqual(folded.contexts, ['git status output'])
  const notWanted = foldOutcomes([decodeOutcome(0, 'git status output', '', 'SessionStart')], { contextFromStdout: false })
  assert.deepEqual(notWanted.contexts, [])
})

test('buildPayload: claude dialect tool payload matches the reference field names', () => {
  const payload = buildPayload('claude', 'tool:before', {
    sessionId: 's1',
    cwd: '/work',
    transcriptPath: '/work/transcript.jsonl',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolUseId: 'call_1',
  })
  assert.deepEqual(payload, {
    session_id: 's1',
    transcript_path: '/work/transcript.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 'call_1',
  })
})

test('buildPayload: claude prompt payload carries the prompt text', () => {
  const payload = buildPayload('claude', 'prompt:submit', { sessionId: 's1', cwd: '/w', prompt: 'hello' })
  assert.equal(payload.hook_event_name, 'UserPromptSubmit')
  assert.equal(payload.prompt, 'hello')
})

test('buildPayload: subagent events carry agent fields', () => {
  const payload = buildPayload('claude', 'subagent:start', { sessionId: 's1', cwd: '/w', agentId: 'a9', agentType: 'general-purpose' })
  assert.equal(payload.hook_event_name, 'SubagentStart')
  assert.equal(payload.agent_id, 'a9')
  assert.equal(payload.agent_type, 'general-purpose')
})

test('buildPayload: codex and opencode reuse the claude field shape', () => {
  const codex = buildPayload('codex', 'tool:before', { sessionId: 's', cwd: '/w', toolName: 'Bash', toolInput: {} })
  assert.equal(codex.hook_event_name, 'PreToolUse')
  assert.equal(codex.tool_name, 'Bash')
  const oc = buildPayload('opencode', 'tool:before', { sessionId: 's', cwd: '/w', toolName: 'Bash', toolInput: {} })
  assert.equal(oc.hook_event_name, 'tool.execute.before')
  assert.equal(oc.session_id, 's')
  assert.equal(oc.permission_mode, 'default')
})

test('buildPayload: native dialect uses the envelope shape', () => {
  const payload = buildPayload('native', 'tool:before', {
    sessionId: 's1',
    cwd: '/w',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  })
  assert.equal(payload.event, 'tool:before')
  assert.equal(payload.session_id, 's1')
  assert.equal(typeof payload.ts, 'string')
  assert.equal(payload.tool_name, 'Bash')
  assert.deepEqual(payload.tool_input, { command: 'ls' })
})
