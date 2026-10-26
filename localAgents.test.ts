import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentError, runLocalAgent } from './localAgents'
import type { LocalRunOptions } from './localAgents'
import type { Agent } from './src/types'

const directories: string[] = []
const previousOmp = process.env.OMP_COMMAND
const previousHermes = process.env.HERMES_COMMAND
const previousCodex = process.env.CODEX_COMMAND
const previousAntigravity = process.env.ANTIGRAVITY_COMMAND
const previousClaude = process.env.CLAUDE_COMMAND
const previousAnthropicKey = process.env.ANTHROPIC_API_KEY

// These real subprocess clocks exercise IPC chunk boundaries and OS process-group cleanup; parent fake timers cannot drive them.
const fixtureSource = String.raw`#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
let modelChosen = false
let promptId
let scenario = ''
let formsSupported = false
let scopedTarget = ''
let ompTargets = []
const sessionId = 'fixture-session'
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const update = update => send({ method: 'session/update', params: { sessionId, update } })
const answer = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const finish = (text, stopReason = 'end_turn') => { answer(text); send({ id: promptId, result: { stopReason } }) }
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (!m.method) {
    if (m.id === 'client-fs') {
      if (m.result) await Bun.write('forbidden-client-write', 'unexpected')
      finish(m.error ? 'Operasi client ditolak.' : 'Tidak aman.')
    } else if (m.id === 'generic-approval') {
      const value = m.result?.action === 'accept' ? m.result.content?.value : undefined
      const allowed = value === 'Approve' || value === 'Approve browser for this session'
      if (allowed) await Bun.write('approved-browser-action', value === 'Approve' ? 'opened once' : 'opened for the session')
      finish(allowed ? value === 'Approve' ? 'Browser dibuka dengan izin sekali.' : 'Browser dibuka untuk sesi ini.' : 'Browser tidak dibuka.')
    } else if (m.id === 'omp-file-approval') {
      const allowed = m.result?.action === 'accept' && m.result.content?.value === 'Approve'
      if (allowed && scenario !== 'omp-file-read') for (const path of ompTargets) await Bun.write(path, 'OMP approved once')
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'omp-file', status: 'completed' })
      finish(allowed ? scenario === 'omp-file-read' ? await Bun.file(ompTargets[0]).text() : 'OMP file approved.' : 'OMP file denied.')
    } else if (m.id === 'tool-permission' || m.id === 'scoped-permission') {
      const allowed = m.result?.outcome?.outcome === 'selected' && m.result.outcome.optionId === 'opaque-allow'
      if (allowed) await Bun.write(m.id === 'scoped-permission' ? scopedTarget : 'approved-action', 'approved once')
      finish(allowed ? 'Tindakan disetujui sekali.' : 'Tindakan ditolak.')
    }
    continue
  }
  if (m.method === 'initialize') {
    formsSupported = !!m.params.clientCapabilities?.elicitation?.form
    send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'test-fixture' } } })
  }
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId } })
  else if (m.method === 'session/set_config_option' || m.method === 'session/set_model') {
    const correct = (process.argv.includes('--cwd') || process.env.ANTIGRAVITY_COMMAND) ? m.method === 'session/set_config_option' && m.params.configId === 'model' : m.method === 'session/set_model'
    modelChosen = correct
    send(correct ? { id: m.id, result: {} } : { id: m.id, error: { code: -32601, message: 'wrong model protocol private-fixture-secret' } })
  } else if (m.method === 'session/set_mode') send({ id: m.id, result: {} })
  else if (m.method === 'session/prompt') {
    promptId = m.id
    scenario = m.params.prompt.at(-1).text
    if (scenario === 'malformed') { process.stdout.write('NOT JSON private-fixture-secret\n'); continue }
    if (scenario === 'crash') { process.stderr.write('private-fixture-secret\n'); process.exit(9) }
    if (scenario === 'rpc-error') { send({ id: m.id, error: { code: -32000, message: 'private-fixture-secret' } }); continue }
    if (scenario === 'oversized') { answer('x'.repeat(120001)); continue }
    if (scenario === 'truncated') { finish('Jawaban parsial.', 'max_tokens'); continue }
    if (scenario === 'progress') {
      for (const sessionUpdate of ['agent_thought_chunk', 'agent_message_chunk', 'tool_call']) {
        send({ method: 'session/update', params: { sessionId: 'foreign-session',
          update: { sessionUpdate, content: { type: 'text', text: 'foreign-private-reasoning' }, title: 'foreign-tool' } } })
      }
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })
      update({ sessionUpdate: 'unknown_notification' })
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private-reasoning' } })
      update({ sessionUpdate: 'tool_call', title: 'Read file', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', status: 'completed' })
      finish('Selesai.')
      continue
    }
    if (scenario === 'client-fs') { send({ id: 'client-fs', method: 'fs/write_text_file', params: { sessionId, path: process.cwd() + '/forbidden-client-write', content: 'blocked' } }); continue }
    if (scenario.startsWith('omp-file-')) {
      const path = scenario === 'omp-file-relative' ? 'approved-action' : process.cwd() + '/approved-action'
      let tool = 'write'
      let args = { path, content: 'OMP approved once' }
      let details = 'Path: ' + path + '\nContent:\nOMP approved once'
      let kind = 'edit'
      ompTargets = [path]
      if (scenario === 'omp-file-read') {
        tool = 'read'; kind = 'read'; args = { path }
        details = ''
        await Bun.write(path, 'Read OMP token 7291')
      } else if (scenario === 'omp-file-edit' || scenario === 'omp-file-move') {
        tool = 'edit'
        const other = process.cwd() + '/second-action'
        args = { input: '*** Begin Patch\n[' + path + '#ABCD]\nPUT 1.=1:\n+OMP approved once\n[' + other + '#EF12]\nPUT 1.=1:\n+OMP approved once\n*** End Patch\n' }
        if (scenario === 'omp-file-move') args.input = args.input.replace('*** End Patch', 'MV /tmp/outside-action\n*** End Patch')
        details = 'File: ' + path + '\nFile: ' + other
        ompTargets.push(other)
      } else if (scenario === 'omp-file-command') {
        args.command = 'touch /tmp/outside-action'
      } else if (scenario === 'omp-file-device') {
        args.path = 'xd://lsp'; kind = 'execute'
      } else if (scenario === 'omp-file-wrapped') {
        args.path = '[xd://lsp#ABCD]'
      } else if (scenario === 'omp-file-selector') {
        args.path += ':table'
      } else if (scenario === 'omp-file-spoof') {
        tool = 'eval'; kind = 'execute'; args = { language: 'js', code: 'writeOutside()' }
      }
      if (scenario !== 'omp-file-no-metadata') send({ method: 'session/update', params: {
        sessionId: scenario === 'omp-file-foreign' ? 'other-session' : sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'omp-file', title: tool + ': ' + path, kind, status: 'pending', rawInput: args },
      } })
      if (scenario === 'omp-file-completed') update({ sessionUpdate: 'tool_call_update', toolCallId: 'omp-file', status: 'completed' })
      if (scenario === 'omp-file-concurrent') update({ sessionUpdate: 'tool_call', toolCallId: 'other-tool', title: 'write: /tmp/outside-action', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/outside-action', content: 'unsafe' } })
      send({ id: 'omp-file-approval', method: 'elicitation/create', params: {
        sessionId, mode: 'form', message: scenario === 'omp-file-read' ? 'Allow tool: read' : 'Allow tool: ' + (scenario === 'omp-file-spoof' ? 'write' : tool) + '\nReason: Approval mode always-ask\n' + details,
        requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: ['Approve', 'Approve ' + tool + ' for this session', 'Deny'] } }, required: ['value'] },
      } })
      continue
    }
    if (scenario.startsWith('form-')) {
      if (!formsSupported) { finish('Browser tidak dibuka.'); continue }
      send({ id: 'generic-approval', method: 'elicitation/create', params: {
        sessionId: scenario === 'form-wrong-session' ? 'another-session' : sessionId,
        mode: 'form',
        message: 'Allow tool: browser\nOpen the local verification page.',
        requestedSchema: { type: 'object', properties: {
          value: scenario === 'form-input'
            ? { type: 'string', description: 'Enter a password' }
            : { type: 'string', enum: scenario === 'form-no-session' ? ['Approve', 'Deny'] : ['Approve', 'Approve browser for this session', 'Deny'] },
          ...(scenario === 'form-extra-field' ? { password: { type: 'string' } } : {}),
        }, required: ['value'] },
      } })
      continue
    }
    if (scenario === 'child-abort') {
      const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setTimeout(()=>Bun.write("orphan-action", "bad"),1600)'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const ready = Promise.withResolvers()
      worker.stdout.once('data', ready.resolve)
      await ready.promise
      update({ sessionUpdate: 'tool_call', title: 'fixture-child-started', status: 'in_progress' })
      continue
    }
    if (scenario.startsWith('scoped-')) {
      const path = scenario === 'scoped-outside' ? process.cwd() + '-outside-action' : process.cwd() + '/approved-action'
      scopedTarget = path
      const toolCall = {
        toolCallId: 'edit-approval-1', title: 'Approve edit: ' + path, kind: 'edit', status: 'pending',
        content: [{ type: 'diff', path, oldText: null, newText: 'approved once' }],
        rawInput: { tool: 'write_file', arguments: { path, content: 'approved once' } },
      }
      if (scenario === 'scoped-patch' || scenario === 'scoped-patch-default') {
        await Bun.write(path, 'before')
        toolCall.content[0].oldText = 'before'
        toolCall.rawInput = { tool: 'patch', arguments: { path, old_string: 'before', new_string: 'approved once',
          ...(scenario === 'scoped-patch' ? { mode: 'replace', replace_all: true } : {}) } }
      } else if (scenario === 'scoped-relative') {
        toolCall.rawInput.arguments.path = 'approved-action'
        toolCall.content[0].path = 'approved-action'
      } else if (scenario === 'scoped-command') {
        toolCall.rawInput.arguments.command = 'write outside-action'
      } else if (scenario === 'scoped-unknown-tool') {
        toolCall.rawInput.tool = 'terminal'
      } else if (scenario === 'scoped-opaque') {
        toolCall.rawInput = 'write approved-action'
      } else if (scenario === 'scoped-path-only') {
        toolCall.rawInput = { path, content: 'approved once' }
      } else if (scenario === 'scoped-locations-only') {
        toolCall.locations = [{ path }]
        delete toolCall.rawInput
        delete toolCall.content
      } else if (scenario === 'scoped-title-only') {
        delete toolCall.rawInput
        delete toolCall.content
      } else if (scenario === 'scoped-multi-diff') {
        toolCall.content.push({ type: 'diff', path: path + '-other', oldText: null, newText: 'other' })
      } else if (scenario === 'scoped-multi-args') {
        toolCall.rawInput.arguments.paths = [path, path + '-other']
      } else if (scenario === 'scoped-multi-patch') {
        toolCall.rawInput = { tool: 'patch', arguments: { mode: 'patch', path,
          patch: '*** Begin Patch\n*** Update File: ' + path + '\n*** Move File: ' + path + ' -> ' + path + '-outside\n*** End Patch' } }
      } else if (scenario === 'scoped-mismatch') {
        toolCall.content[0].path = path + '-other'
      } else if (scenario === 'scoped-content-mismatch') {
        toolCall.content[0].newText = 'different'
      } else if (scenario === 'scoped-missing-content') {
        delete toolCall.rawInput.arguments.content
      } else if (scenario === 'scoped-invalid-content') {
        toolCall.rawInput.arguments.content = 42
      } else if (scenario === 'scoped-missing-path') {
        delete toolCall.rawInput.arguments.path
      } else if (scenario === 'scoped-extra-input') {
        toolCall.rawInput.command = 'write outside-action'
      } else if (scenario === 'scoped-extra-diff') {
        toolCall.content[0].moveTo = path + '-outside'
      } else if (scenario === 'scoped-extra-envelope') {
        toolCall.command = 'write outside-action'
      } else if (scenario === 'scoped-large') {
        toolCall.rawInput.arguments.content = 'x'.repeat(15000)
        toolCall.content[0].newText = toolCall.rawInput.arguments.content
      }
      send({ id: 'scoped-permission', method: 'session/request_permission', params: { sessionId, toolCall,
        options: [{ optionId: 'opaque-allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'opaque-deny', name: 'Reject', kind: 'reject_once' }] } })
      continue
    }
    if (scenario.includes('permission')) {
      send({ id: 'tool-permission', method: 'session/request_permission', params: { sessionId,
        toolCall: { title: 'Write approved-action', kind: 'edit', rawInput: { path: 'approved-action', content: scenario === 'large-permission' ? 'x'.repeat(15000) : 'approved once' } },
        options: [
          { optionId: 'opaque-session', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'opaque-allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'opaque-deny', name: 'Reject', kind: 'reject_once' },
        ] } })
      continue
    }
    if (!modelChosen) { send({ id: m.id, error: { code: -32000, message: 'model not selected' } }); continue }
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private-reasoning' } })
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Halo 🌿' } } } }) + '\n')
    const split = payload.indexOf(Buffer.from('🌿')) + 1
    process.stdout.write(payload.subarray(0, split))
    await Bun.sleep(5)
    process.stdout.write(payload.subarray(split))
    finish(' — task selesai.')
  } else send({ id: m.id, error: { code: -32601, message: 'unknown method' } })
}
`

const codexFixtureSource = String.raw`#!/usr/bin/env bun
import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const threadId = crypto.randomUUID()
const turnId = 'fixture-turn'
let scenario = ''
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } })
const finish = (text, status = 'completed') => {
  notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Teks sementara.' })
  notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text } })
  notify('turn/completed', { turn: { id: turnId, status, error: status === 'failed' ? { message: 'private-fixture-secret' } : null } })
}
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.jsonrpc !== undefined) process.exit(3)
  if (!m.method) {
    if (m.id === 'approval') {
      if (m.result?.decision === 'accept') {
        await Bun.write('approved-action', 'approved once')
        finish('Diizinkan sekali.')
      } else {
        if (m.result?.decision === 'acceptForSession') await Bun.write('unsafe-session-grant', 'unsafe')
        finish('Ditolak.')
      }
    }
    continue
  }
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex-fixture' } })
  else if (m.method === 'initialized') continue
  else if (m.method === 'account/read') {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL) {
      send({ id: m.id, error: { code: -1, message: 'HTTP provider credentials leaked to subscription child' } })
      continue
    }
    const type = await Bun.file('account-type').text().catch(() => 'chatgpt')
    send({ id: m.id, result: { account: type === 'missing' ? null : { type, email: 'private-account@example.test' } } })
  } else if (m.method === 'thread/start') {
    await Bun.write('thread-started', 'started')
    send({ id: m.id, result: { thread: { id: threadId } } })
  } else if (m.method === 'turn/start') {
    scenario = m.params.input.at(-1).text
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } })
    send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    if (scenario === 'wait') { notify('item/started', { item: { id: 'tool', type: 'commandExecution', status: 'inProgress' } }); continue }
    if (scenario === 'failed') { finish('Hasil sebagian.', 'failed'); continue }
    if (scenario === 'oversized') { finish('x'.repeat(120001)); continue }
    if (scenario.startsWith('watchdog-')) {
      for (let index = 0; index < 11; index++) {
        await Bun.sleep(300)
        if (scenario === 'watchdog-plan-repeat') {
          notify('turn/plan/updated', { plan: [{ step: 'Private unchanged plan', status: 'inProgress' }] })
        } else {
          notify('item/mcpToolCall/progress', {
            threadId: scenario === 'watchdog-foreign' ? 'foreign-thread' : threadId,
            itemId: 'private-tool', message: 'private-progress-' + index,
          })
        }
      }
      finish('Task panjang selesai.')
      continue
    }
    if (scenario === 'progress') {
      notify('item/reasoning/textDelta', { threadId: 'foreign-thread', delta: 'foreign-private-reasoning' })
      notify('item/reasoning/textDelta', { turnId: 'foreign-turn', delta: 'foreign-private-reasoning' })
      notify('item/commandExecution/outputDelta', { turnId: 'foreign-turn', delta: 'foreign-tool-output' })
      notify('item/reasoning/textDelta', { delta: '' })
      notify('unknown_notification', {})
      notify('item/reasoning/textDelta', { delta: 'private-reasoning' })
      notify('item/reasoning/summaryTextDelta', { delta: 'private-summary' })
      notify('item/commandExecution/outputDelta', { delta: 'private-tool-output' })
      notify('item/started', { item: { type: 'commandExecution', status: 'inProgress' } })
      finish('Selesai.')
      continue
    }
    if (scenario.includes('permission')) {
      send({ id: 'approval', method: scenario === 'command-permission' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval',
        params: { threadId: scenario === 'other-thread-permission' ? 'foreign-thread' : threadId,
          turnId: scenario === 'other-turn-permission' ? 'foreign-turn' : turnId,
          itemId: 'write', command: 'write approved-action',
          reason: scenario === 'large-permission' ? 'x'.repeat(15000) : 'Write the approved file',
          availableDecisions: scenario === 'session-only-permission' ? ['acceptForSession', 'decline'] : ['accept', 'acceptForSession', 'decline'] } })
      continue
    }
    notify('item/reasoning/textDelta', { delta: 'private-reasoning' })
    notify('item/agentMessage/delta', { turnId: 'foreign-turn', itemId: 'foreign', delta: 'foreign-answer' })
    const payload = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'intro', delta: 'Konteks 🌿 siap.' } }) + '\n')
    const split = payload.indexOf(Buffer.from('🌿')) + 1
    process.stdout.write(payload.subarray(0, split))
    await Bun.sleep(5)
    process.stdout.write(payload.subarray(split))
    finish('Jawaban selesai.')
  } else send({ id: m.id, error: { code: -32601, message: 'Unsupported protocol private-fixture-secret' } })
}
`


// Claude Code fixture: reads stream-json from stdin, answers like `claude -p --output-format stream-json` and asks the host before writing.
const claudeFixtureSource = String.raw`#!/usr/bin/env bun
import { createInterface } from 'node:readline'
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const text = (value) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } })
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: 'selesai', ...extra })
let pendingPrompt = ''
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.type === 'user') {
    const prompt = m.message.content[0].text
    pendingPrompt = prompt
    out({ type: 'system', subtype: 'init', session_id: 's' })
    if (prompt.includes('auth')) {
      out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } })
      result({ is_error: true, result: 'Failed to authenticate: OAuth session expired with private-fixture-secret' })
    } else if (prompt.includes('env')) {
      out({ type: 'stream_event', event: { type: 'message_start' } })
      text(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null, args: process.argv.slice(2), cwd: process.cwd() }))
      result()
    } else if (prompt.includes('limit')) {
      result({ is_error: true, subtype: 'success', result: 'Claude usage limit reached. Resets at 5pm.' })
    } else if (prompt.includes('unstreamed')) {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tanpa delta.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] } })
      result()
    } else if (prompt.includes('write') || prompt.includes('large') || prompt.includes('bash')) {
      out({ type: 'stream_event', event: { type: 'message_start' } })
      text('Akan menulis.')
      const input = prompt.includes('bash') ? { command: 'touch approved-write' } : { file_path: process.cwd() + '/approved-write', content: prompt.includes('large') ? 'x'.repeat(20000) : 'ok' }
      out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: prompt.includes('bash') ? 'Bash' : 'Write', input, tool_use_id: 'tu1' } })
    } else {
      out({ type: 'stream_event', event: { type: 'message_start' } })
      text('Halo ')
      out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } })
      text('dunia 🌿.')
      result()
    }
  } else if (m.type === 'control_response') {
    const reply = m.response.response
    const allowed = reply.behavior === 'allow' && reply.updatedInput && typeof reply.updatedInput.file_path === 'string' || reply.behavior === 'allow' && reply.updatedInput?.command
    if (allowed && reply.updatedInput.file_path) await Bun.write(reply.updatedInput.file_path, reply.updatedInput.content)
    if (allowed && reply.updatedInput.command) await Bun.write('approved-write', 'bash ran')
    text(allowed ? ' Ditulis.' : ' Ditolak: ' + reply.message)
    result()
  }
}
`

async function setup(provider: 'omp' | 'hermes' | 'codex' | 'antigravity' | 'claude' = 'omp'): Promise<LocalRunOptions> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ruang local agent ')))
  directories.push(directory)
  const executable = join(directory, 'acp-fixture')
  await Bun.write(executable, provider === 'codex' ? codexFixtureSource : provider === 'claude' ? claudeFixtureSource : fixtureSource)
  chmodSync(executable, 0o700)
  process.env[`${provider.toUpperCase()}_COMMAND`] = executable
  const agent: Agent = {
    id: 'local-agent', name: 'Local', role: 'Asisten pengujian', provider,
    model: 'fixture-model', color: '#8c9eff', createdAt: new Date().toISOString(),
    workspace: directory, allowTools: true,
  }
  return { agent, prompt: 'unicode', history: [], signal: new AbortController().signal, onOutput: () => {}, onActivity: () => {}, onProgress: () => {}, onPermission: async () => null }
}

afterEach(() => {
  if (previousOmp === undefined) delete process.env.OMP_COMMAND
  else process.env.OMP_COMMAND = previousOmp
  if (previousHermes === undefined) delete process.env.HERMES_COMMAND
  else process.env.HERMES_COMMAND = previousHermes
  if (previousCodex === undefined) delete process.env.CODEX_COMMAND
  else process.env.CODEX_COMMAND = previousCodex
  if (previousAntigravity === undefined) delete process.env.ANTIGRAVITY_COMMAND
  else process.env.ANTIGRAVITY_COMMAND = previousAntigravity
  if (previousClaude === undefined) delete process.env.CLAUDE_COMMAND
  else process.env.CLAUDE_COMMAND = previousClaude
  if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousAnthropicKey
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('local ACP agents', () => {
  test.each(['omp', 'hermes', 'antigravity', 'codex'] as const)('%s reports only meaningful current-session progress without exposing reasoning', async (provider) => {
    const options = await setup(provider)
    let progress = 0
    const outputs: string[] = []
    const activities: string[] = []
    const result = await runLocalAgent({
      ...options, prompt: 'progress',
      onProgress: () => { progress++ },
      onOutput: (output) => { outputs.push(output) },
      onActivity: (activity) => { activities.push(activity) },
    })
    expect(result).toBe('Selesai.')
    expect(progress).toBe(provider === 'codex' ? 6 : 4)
    const visible = JSON.stringify({ outputs, activities })
    expect(visible).not.toContain('private')
    expect(visible).not.toContain('foreign')
  })

  test.each(['omp', 'hermes', 'antigravity'] as const)('%s streams split Unicode without exposing thought chunks', async (provider) => {
    const options = await setup(provider)
    const streamed: string[] = []
    const result = await runLocalAgent({ ...options, onOutput: (text) => { streamed.push(text) } })
    expect(result).toBe('Halo 🌿 — task selesai.')
    expect(streamed).toContain('Halo 🌿')
    expect(streamed.join('')).not.toContain('private-reasoning')
  })

  test('shows generic browser approval and executes only after the user grants it once', async () => {
    const options = await setup()
    let asked = false
    const result = await runLocalAgent({ ...options, prompt: 'form-browser', onPermission: async (permission, filePaths) => {
      asked = true
      expect(permission.details).toContain('Allow tool: browser')
      expect(filePaths).toBeUndefined()
      expect(permission.options.map((option) => option.id).sort()).toEqual(['allow_once', 'allow_session', 'reject_once'])
      expect(await Bun.file(join(options.agent.workspace, 'approved-browser-action')).exists()).toBe(false)
      return 'allow_once'
    } })
    expect(asked).toBe(true)
    expect(result).toBe('Browser dibuka dengan izin sekali.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-browser-action')).text()).toBe('opened once')
  })

  test('lets the user approve a generic OMP tool for the rest of the session, naming the tool and never the wider scope', async () => {
    const options = await setup()
    let labels: string[] = []
    const result = await runLocalAgent({ ...options, prompt: 'form-browser', onPermission: async (permission) => {
      labels = permission.options.map((option) => option.label)
      return 'allow_session'
    } })
    expect(labels).toEqual(['Tolak', 'Izinkan sekali', 'Izinkan browser untuk sesi ini'])
    expect(result).toBe('Browser dibuka untuk sesi ini.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-browser-action')).text()).toBe('opened for the session')
  })

  test('offers no session approval when OMP does not offer one', async () => {
    const options = await setup()
    let ids: string[] = []
    await runLocalAgent({ ...options, prompt: 'form-no-session', onPermission: async (permission) => {
      ids = permission.options.map((option) => option.id)
      return null
    } })
    expect(ids).toEqual(['reject_once', 'allow_once'])
  })

  test('honors rejection of generic browser access without remembering an approval', async () => {
    const options = await setup()
    let asked = false
    const result = await runLocalAgent({ ...options, prompt: 'form-browser', onPermission: async (_permission, filePaths) => {
      asked = true
      expect(filePaths).toBeUndefined()
      return filePaths?.length ? 'allow_once' : null
    } })
    expect(asked).toBe(true)
    expect(result).toBe('Browser tidak dibuka.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-browser-action')).exists()).toBe(false)
  })

  test.each(['form-input', 'form-extra-field', 'form-wrong-session'])('declines unsupported or unrelated ACP form %s', async (prompt) => {
    const options = await setup()
    let asked = false
    const result = await runLocalAgent({ ...options, prompt, onPermission: async () => {
      asked = true
      return 'allow_once'
    } })
    expect(asked).toBe(false)
    expect(result).toBe('Browser tidak dibuka.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-browser-action')).exists()).toBe(false)
  })

  test.each(['write', 'relative', 'read', 'edit'])('automatically approves scoped OMP %s with complete active tool metadata', async (scenario) => {
    const options = await setup()
    const result = await runLocalAgent({ ...options, prompt: `omp-file-${scenario}`, onPermission: async (_permission, targets) => {
      expect(targets).toEqual(scenario === 'edit'
        ? [join(options.agent.workspace, 'approved-action'), join(options.agent.workspace, 'second-action')]
        : [scenario === 'relative' ? 'approved-action' : join(options.agent.workspace, 'approved-action')])
      return targets?.length ? 'allow_once' : null
    } })
    expect(result).toBe(scenario === 'read' ? 'Read OMP token 7291' : 'OMP file approved.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).text()).toBe(scenario === 'read' ? 'Read OMP token 7291' : 'OMP approved once')
    if (scenario === 'edit') expect(await Bun.file(join(options.agent.workspace, 'second-action')).text()).toBe('OMP approved once')
  })

  test.each(['move', 'command', 'device', 'wrapped', 'selector', 'spoof', 'no-metadata', 'foreign', 'completed', 'concurrent'])(
    'keeps ambiguous or unsafe OMP %s approvals manual', async (scenario) => {
      const options = await setup()
      const result = await runLocalAgent({ ...options, prompt: `omp-file-${scenario}`, onPermission: async (_permission, targets) => {
        expect(targets).toBeUndefined()
        return targets?.length ? 'allow_once' : null
      } })
      expect(result).toBe('OMP file denied.')
      expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
    },
  )

  test('waits for explicit one-shot permission before a tool changes the workspace', async () => {
    const options = await setup()
    const approval = Promise.withResolvers<string | null>()
    const requested = Promise.withResolvers<void>()
    const task = runLocalAgent({ ...options, prompt: 'permission', onPermission: async (permission) => {
      expect(permission.options.map((option) => option.id).sort()).toEqual(['allow_once', 'reject_once'])
      expect(permission.details).toContain('approved-action')
      requested.resolve()
      return approval.promise
    } })
    await requested.promise
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
    approval.resolve('allow_once')
    expect(await task).toBe('Tindakan disetujui sekali.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).text()).toBe('approved once')
  })

  test.each([null, 'reject_once', 'allow_always'])('never executes a rejected or unrecognized permission (%s)', async (selection) => {
    const options = await setup()
    const result = await runLocalAgent({ ...options, prompt: 'permission', onPermission: async () => selection })
    expect(result).toBe('Tindakan ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test('does not offer approval when action details are truncated', async () => {
    const options = await setup()
    await runLocalAgent({ ...options, prompt: 'large-permission', onPermission: async (permission) => {
      expect(permission.options).toEqual([{ id: 'reject_once', label: 'Tolak' }])
      return 'allow_once'
    } })
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test.each(['scoped-write', 'scoped-patch', 'scoped-patch-default'])('provides complete Hermes direct-file targets for %s', async (prompt) => {
    const options = await setup('hermes')
    const target = join(options.agent.workspace, 'approved-action')
    let asked = false
    const result = await runLocalAgent({ ...options, prompt, onPermission: async (permission, filePaths) => {
      asked = true
      expect(filePaths).toEqual([target])
      expect(permission).not.toHaveProperty('filePaths')
      expect(await Bun.file(target).exists()).toBe(prompt !== 'scoped-write')
      return filePaths?.length ? 'allow_once' : null
    } })
    expect(asked).toBe(true)
    expect(result).toBe('Tindakan disetujui sekali.')
    expect(await Bun.file(target).text()).toBe('approved once')
  })

  test('preserves an absolute outside Hermes target for the server to reject', async () => {
    const options = await setup('hermes')
    const outside = `${options.agent.workspace}-outside-action`
    directories.push(outside)
    let asked = false
    const result = await runLocalAgent({ ...options, prompt: 'scoped-outside', onPermission: async (_permission, filePaths) => {
      asked = true
      expect(filePaths).toEqual([outside])
      return null
    } })
    expect(asked).toBe(true)
    expect(result).toBe('Tindakan ditolak.')
    expect(await Bun.file(outside).exists()).toBe(false)
  })

  test.each([
    'scoped-relative', 'scoped-command', 'scoped-unknown-tool', 'scoped-opaque', 'scoped-path-only',
    'scoped-locations-only', 'scoped-title-only', 'scoped-multi-diff', 'scoped-multi-args', 'scoped-multi-patch',
    'scoped-mismatch', 'scoped-content-mismatch', 'scoped-missing-content', 'scoped-invalid-content',
    'scoped-missing-path', 'scoped-extra-input', 'scoped-extra-diff', 'scoped-extra-envelope', 'scoped-large',
  ])('keeps unsafe or incomplete Hermes metadata manual for %s', async (prompt) => {
    const options = await setup('hermes')
    let asked = false
    const result = await runLocalAgent({ ...options, prompt, onPermission: async (_permission, filePaths) => {
      asked = true
      expect(filePaths).toBeUndefined()
      return filePaths?.length ? 'allow_once' : null
    } })
    expect(asked).toBe(true)
    expect(result).toBe('Tindakan ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test.each(['omp', 'antigravity'] as const)('does not interpret a Hermes-shaped request from %s as scoped', async (provider) => {
    const options = await setup(provider)
    const result = await runLocalAgent({ ...options, prompt: 'scoped-write', onPermission: async (_permission, filePaths) => {
      expect(filePaths).toBeUndefined()
      return filePaths?.length ? 'allow_once' : null
    } })
    expect(result).toBe('Tindakan ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test('rejects client filesystem operations instead of exposing a file-writing bridge', async () => {
    const options = await setup()
    expect(await runLocalAgent({ ...options, prompt: 'client-fs' })).toBe('Operasi client ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'forbidden-client-write')).exists()).toBe(false)
  })

  test.each(['malformed', 'crash', 'rpc-error', 'oversized', 'truncated'])('fails safely for %s', async (scenario) => {
    const options = await setup()
    try {
      await runLocalAgent({ ...options, prompt: scenario })
      throw new Error('Expected runtime failure')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAgentError)
      expect((error as Error).message).not.toContain('private-fixture-secret')
    }
  })

  test('aborting terminates the CLI process group including a tool that ignores SIGTERM', async () => {
    const options = await setup()
    const controller = new AbortController()
    const task = runLocalAgent({ ...options, prompt: 'child-abort', signal: controller.signal, onActivity: (activity) => {
      if (activity.includes('fixture-child-started')) controller.abort()
    } })
    await expect(task).rejects.toBeInstanceOf(LocalAgentError)
    await Bun.sleep(1000)
    expect(await Bun.file(join(options.agent.workspace, 'orphan-action')).exists()).toBe(false)
  }, 5000)

  test('does not start a local runtime without explicit tools consent', async () => {
    const options = await setup()
    await expect(runLocalAgent({ ...options, agent: { ...options.agent, allowTools: false } })).rejects.toBeInstanceOf(LocalAgentError)
    await expect(runLocalAgent({ ...options, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(LocalAgentError)
  })
})

test.each(['watchdog-progress', 'watchdog-foreign', 'watchdog-plan-repeat'] as const)(
  'Codex %s keeps live work but never disguises foreign or repeated state as progress', async (scenario) => {
    const options = await setup('codex')
    const controller = new AbortController()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const output: string[] = []
    const progress = (): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => controller.abort(), 2000)
    }
    try {
      progress()
      const task = runLocalAgent({
        ...options, prompt: scenario, signal: controller.signal, onProgress: progress, onActivity: progress,
        onOutput(value): void { output.push(value); progress() },
      })
      if (scenario === 'watchdog-progress') {
        expect(await task).toBe('Task panjang selesai.')
        expect(controller.signal.aborted).toBe(false)
        expect(output.join('')).not.toContain('private')
      } else {
        await expect(task).rejects.toBeInstanceOf(LocalAgentError)
        expect(controller.signal.aborted).toBe(true)
        expect(output).toEqual([])
      }
    } finally {
      clearTimeout(watchdog)
      controller.abort()
    }
  }, 10_000,
)

describe('Codex subscription client', () => {
  test('streams separate messages and uses authoritative text without reasoning or other-turn output', async () => {
    const options = await setup('codex')
    const streamed: string[] = []
    const answer = await runLocalAgent({ ...options, onOutput: (output) => { streamed.push(output) } })
    expect(answer).toBe('Konteks 🌿 siap.\n\nJawaban selesai.')
    expect(streamed).toContain('Konteks 🌿 siap.\n\nTeks sementara.')
    expect(streamed.join('')).not.toContain('private-reasoning')
    expect(answer).not.toContain('foreign-answer')
    expect(answer).not.toContain('private-account')
  })

  test.each(['apiKey', 'missing'])('rejects %s authentication before starting a model thread', async (type) => {
    const options = await setup('codex')
    await Bun.write(join(options.agent.workspace, 'account-type'), type)
    await expect(runLocalAgent(options)).rejects.toThrow('login ChatGPT')
    expect(await Bun.file(join(options.agent.workspace, 'thread-started')).exists()).toBe(false)
  })

  test('waits for one-shot command approval before changing a file', async () => {
    const options = await setup('codex')
    const approval = Promise.withResolvers<string | null>()
    const requested = Promise.withResolvers<void>()
    const task = runLocalAgent({ ...options, prompt: 'command-permission', onPermission: async (permission, filePaths) => {
      expect(permission.options.map((option) => option.id)).toEqual(['reject_once', 'allow_once'])
      expect(filePaths).toBeUndefined()
      requested.resolve()
      return approval.promise
    } })
    await requested.promise
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
    approval.resolve('allow_once')
    expect(await task).toBe('Diizinkan sekali.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).text()).toBe('approved once')
    expect(await Bun.file(join(options.agent.workspace, 'unsafe-session-grant')).exists()).toBe(false)
  })

  test.each(['other-thread-permission', 'other-turn-permission'])('rejects stale %s without asking the user', async (prompt) => {
    const options = await setup('codex')
    let asked = false
    const result = await runLocalAgent({ ...options, prompt, onPermission: async () => { asked = true; return 'allow_once' } })
    expect(result).toBe('Ditolak.')
    expect(asked).toBe(false)
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test.each(['session-only-permission', 'large-permission'])('cannot grant %s even if a caller returns allow_once', async (prompt) => {
    const options = await setup('codex')
    const result = await runLocalAgent({ ...options, prompt, onPermission: async (permission) => {
      expect(permission.options).toEqual([{ id: 'reject_once', label: 'Tolak' }])
      return 'allow_once'
    } })
    expect(result).toBe('Ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
  })

  test('honors explicit file-change rejection without persistent permission', async () => {
    const options = await setup('codex')
    const result = await runLocalAgent({ ...options, prompt: 'file-permission', onPermission: async (_permission, filePaths) => {
      expect(filePaths).toBeUndefined()
      return filePaths?.length ? 'allow_once' : null
    } })
    expect(result).toBe('Ditolak.')
    expect(await Bun.file(join(options.agent.workspace, 'approved-action')).exists()).toBe(false)
    expect(await Bun.file(join(options.agent.workspace, 'unsafe-session-grant')).exists()).toBe(false)
  })

  test.each(['failed', 'oversized'])('fails safely on %s without leaking runtime diagnostics', async (prompt) => {
    const options = await setup('codex')
    try {
      await runLocalAgent({ ...options, prompt })
      throw new Error('Expected Codex failure')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAgentError)
      expect((error as Error).message).not.toContain('private-fixture-secret')
    }
  })

  test('cancellation releases a pending Codex turn instead of waiting forever', async () => {
    const options = await setup('codex')
    const controller = new AbortController()
    await expect(runLocalAgent({ ...options, prompt: 'wait', signal: controller.signal, onActivity: (activity) => {
      if (activity.includes('commandExecution')) controller.abort()
    } })).rejects.toBeInstanceOf(LocalAgentError)
  })
})

describe('Claude Code adapter', () => {
  test('streams text blocks as separate paragraphs and gives the CLI the role, model and workspace', async () => {
    const options = await setup('claude')
    const outputs: string[] = []
    expect(await runLocalAgent({ ...options, prompt: 'halo', onOutput: (value) => outputs.push(value) })).toBe('Halo \n\ndunia 🌿.')
    expect(outputs.at(-1)).toBe('Halo \n\ndunia 🌿.')
    const environment = JSON.parse(await runLocalAgent({ ...options, prompt: 'env' })) as { args: string[]; cwd: string }
    expect(environment.cwd).toBe(options.agent.workspace)
    expect(environment.args).toContain('--permission-prompt-tool')
    expect(environment.args).toContain('stdio')
    expect(environment.args[environment.args.indexOf('--model') + 1]).toBe('fixture-model')
    expect(environment.args[environment.args.indexOf('--append-system-prompt') + 1]).toContain('Asisten pengujian')
  })

  test('never hands the app API-provider key or endpoint to Claude Code', async () => {
    const options = await setup('claude')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-private-app-key'
    const environment = JSON.parse(await runLocalAgent({ ...options, prompt: 'env' })) as { key: string | null; base: string | null }
    expect(environment).toMatchObject({ key: null, base: null })
  })

  test('runs a write only after the user allows it once and offers its absolute file path for scoped approval', async () => {
    const options = await setup('claude')
    let seen: { title: string; options: string[]; paths?: readonly string[] } | undefined
    const result = await runLocalAgent({ ...options, prompt: 'write', onPermission: async (permission, paths) => {
      seen = { title: permission.title, options: permission.options.map((option) => option.id), paths }
      expect(await Bun.file(join(options.agent.workspace, 'approved-write')).exists()).toBe(false)
      return 'allow_once'
    } })
    expect(result).toBe('Akan menulis. Ditulis.')
    expect(seen).toEqual({ title: 'Claude Code meminta izin: Write', options: ['reject_once', 'allow_once'], paths: [join(options.agent.workspace, 'approved-write')] })
    expect(await Bun.file(join(options.agent.workspace, 'approved-write')).text()).toBe('ok')
  })

  test.each([null, 'reject_once', 'allow_always'])('never runs a tool that was rejected or answered with %s', async (selection) => {
    const options = await setup('claude')
    const result = await runLocalAgent({ ...options, prompt: 'write', onPermission: async () => selection })
    expect(result).toContain('Ditolak')
    expect(await Bun.file(join(options.agent.workspace, 'approved-write')).exists()).toBe(false)
  })

  test('keeps shell commands manual and refuses to approve details that were truncated', async () => {
    const options = await setup('claude')
    let shellPaths: readonly string[] | undefined = ['unset']
    await runLocalAgent({ ...options, prompt: 'bash', onPermission: async (_permission, paths) => { shellPaths = paths; return null } })
    expect(shellPaths).toBeUndefined()
    let offered: string[] = []
    const result = await runLocalAgent({ ...options, prompt: 'large write', onPermission: async (permission) => {
      offered = permission.options.map((option) => option.id)
      return 'allow_once'
    } })
    expect(offered).toEqual(['reject_once'])
    expect(result).toContain('Ditolak')
    expect(await Bun.file(join(options.agent.workspace, 'approved-write')).exists()).toBe(false)
  })

  test('reports a missing login and usage limits without leaking raw CLI output', async () => {
    const options = await setup('claude')
    const auth = await runLocalAgent({ ...options, prompt: 'auth' }).catch((error: unknown) => error)
    expect(auth).toBeInstanceOf(LocalAgentError)
    expect((auth as Error).message).toBe('Claude Code belum login atau sesi login kedaluwarsa. Jalankan claude auth login di terminal server.')
    expect((auth as Error).message).not.toContain('private-fixture-secret')
    const limit = await runLocalAgent({ ...options, prompt: 'limit' }).catch((error: unknown) => error)
    expect((limit as Error).message).toBe('Claude Code: Claude usage limit reached. Resets at 5pm.')
  })

  test('falls back to complete assistant messages when no text deltas were streamed', async () => {
    const options = await setup('claude')
    const activities: string[] = []
    expect(await runLocalAgent({ ...options, prompt: 'unstreamed', onActivity: (value) => activities.push(value) })).toBe('Tanpa delta.')
    expect(activities).toContain('Claude Code · Read: /tmp/x')
  })

  test('is stopped when the task is cancelled and when the CLI is missing', async () => {
    const options = await setup('claude')
    const controller = new AbortController()
    const asked = Promise.withResolvers<void>()
    const pending = runLocalAgent({ ...options, prompt: 'write', signal: controller.signal, onPermission: () => {
      asked.resolve()
      return new Promise(() => {})
    } })
    await asked.promise
    controller.abort()
    await expect(pending).rejects.toThrow('dihentikan')
    process.env.CLAUDE_COMMAND = join(options.agent.workspace, 'missing-claude')
    await expect(runLocalAgent({ ...options, prompt: 'halo' })).rejects.toThrow('Claude Code tidak ditemukan')
  })
})
