import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isLocalProvider } from './src/types'
import type { Agent, ConversationMessage, RuntimeStatus, TaskPermission } from './src/types'

export interface LocalRunOptions {
  agent: Agent
  prompt: string
  history: ConversationMessage[]
  signal: AbortSignal
  onOutput: (output: string) => void
  onActivity: (activity: string) => void
  onProgress: () => void
  onPermission: (permission: TaskPermission, filePaths?: readonly string[]) => Promise<string | null>
}

export class LocalAgentError extends Error {}

const MAX_FRAME = 1_048_576
const MAX_OUTPUT = 120_000
const MAX_PERMISSION = 12_000
const CODEX_WORK_ITEMS: Record<string, true> = {
  agentMessage: true, plan: true, reasoning: true, commandExecution: true, fileChange: true,
  mcpToolCall: true, dynamicToolCall: true, collabAgentToolCall: true, subAgentActivity: true,
  webSearch: true, imageView: true, imageGeneration: true, contextCompaction: true, sleep: true,
}

function findAntigravityExecutable(): string | null {
  const direct = process.env.ANTIGRAVITY_COMMAND || 'antigravity-acp'
  if (Bun.which(direct)) return direct
  const home = process.env.HOME || ''
  const zedRegistry = join(home, 'Library/Application Support/Zed/external_agents/registry/antigravity-acp')
  try {
    for (const dir of readdirSync(zedRegistry)) {
      const candidate = join(zedRegistry, dir, 'agy_acp_server.par')
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
  } catch {
    // Return null if Zed registry is missing or unreadable.
  }
  return null
}

export function getRuntimeStatus(): RuntimeStatus {
  return {
    workspace: process.cwd(),
    runtimes: (['omp', 'hermes', 'codex', 'antigravity', 'claude'] as const).map((provider) => {
      const command = provider === 'antigravity'
        ? findAntigravityExecutable()
        : (process.env[`${provider.toUpperCase()}_COMMAND`] || provider)
      const available = command !== null && Bun.which(command) !== null
      return {
        provider,
        available,
        message: available
          ? 'Executable tersedia. Login dan model diperiksa saat task dijalankan.'
          : `Executable ${provider} tidak ditemukan. Install CLI lalu atur PATH atau ${provider.toUpperCase()}_COMMAND pada server.`,
      }
    }),
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hermesFileTargets(toolCall: unknown): readonly string[] | undefined {
  // Hermes edit_approval.py emits a singleton diff plus the exact direct-file arguments.
  if (!object(toolCall) || toolCall.kind !== 'edit' || toolCall.status !== 'pending' ||
    Object.keys(toolCall).some((key) => !['toolCallId', 'title', 'kind', 'status', 'content', 'rawInput'].includes(key)) ||
    !Array.isArray(toolCall.content) || toolCall.content.length !== 1 || !object(toolCall.rawInput)) return undefined
  const input = toolCall.rawInput
  const args = input.arguments
  const diff = toolCall.content[0]
  if (Object.keys(input).some((key) => key !== 'tool' && key !== 'arguments') || !object(args) ||
    typeof args.path !== 'string' || !isAbsolute(args.path) || args.path.includes('\0') ||
    !object(diff) || diff.type !== 'diff' || diff.path !== args.path || typeof diff.newText !== 'string' ||
    (diff.oldText !== null && typeof diff.oldText !== 'string') ||
    Object.keys(diff).some((key) => !['type', 'path', 'oldText', 'newText'].includes(key)) ||
    (args.cross_profile !== undefined && typeof args.cross_profile !== 'boolean')) return undefined
  // Relative paths can follow Hermes's live terminal cwd, not the stored office workspace.
  if (input.tool === 'write_file' && typeof args.content === 'string' && diff.newText === args.content &&
    Object.keys(args).every((key) => ['path', 'content', 'cross_profile'].includes(key))) return [args.path]
  if (input.tool === 'patch' && (args.mode === undefined || args.mode === 'replace') &&
    typeof args.old_string === 'string' && typeof args.new_string === 'string' && typeof diff.oldText === 'string' &&
    (args.replace_all === undefined || typeof args.replace_all === 'boolean') &&
    Object.keys(args).every((key) => ['mode', 'path', 'old_string', 'new_string', 'replace_all', 'cross_profile'].includes(key))) return [args.path]
  return undefined
}

function ompFileTargets(params: unknown, toolCall: unknown, workspace: string): readonly string[] | undefined {
  if (!object(params) || typeof params.message !== 'string' || !object(toolCall) ||
    toolCall.status !== 'pending' || !object(toolCall.rawInput)) return undefined
  const tool = /^Allow tool: (read|write|edit)(?:\n|$)/.exec(params.message)?.[1]
  const args = toolCall.rawInput
  const keys = Object.keys(args).filter((key) => key !== 'i')
  // OMP expands aliases, selectors and Unicode spaces; only unambiguous filesystem paths qualify.
  const plainPath = (path: unknown): path is string => typeof path === 'string' && /^[A-Za-z0-9_./ -]+$/.test(path)
  if (tool === 'read' && toolCall.kind === 'read' && keys.length === 1 && keys[0] === 'path' && plainPath(args.path) &&
    existsSync(resolve(workspace, args.path))) return [args.path]
  if (tool === 'write' && toolCall.kind === 'edit' && keys.length === 2 && keys.includes('path') && keys.includes('content') &&
    plainPath(args.path) && typeof args.content === 'string') return [args.path]
  if (tool !== 'edit' || toolCall.kind !== 'edit' || keys.length !== 1 || keys[0] !== 'input' || typeof args.input !== 'string') return undefined
  const lines = args.input.trimEnd().split('\n')
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return undefined
  const paths: string[] = []
  for (const line of lines.slice(1, -1)) {
    const header = /^\[([^#\]]+)#[A-Fa-f0-9]{4}\]$/.exec(line)
    if (header && plainPath(header[1])) paths.push(header[1])
    else if (!paths.length || (!line.startsWith('+') &&
      !/^(?:REM|(?:PUT|CUT) (?:[<>]?[1-9]\d*\*?|[1-9]\d*\.=[1-9]\d*|>\$)(?::|(?: @[A-Za-z0-9_-]+)?))$/.test(line))) return undefined
  }
  // shortcut: moves and non-hashline edit formats stay manual until their full target grammar is supported.
  return paths.length ? paths : undefined
}

export async function runLocalAgent(options: LocalRunOptions): Promise<string> {
  const { agent, signal, onOutput, onActivity, onPermission } = options
  if (!isLocalProvider(agent.provider) || !agent.workspace || agent.allowTools !== true) {
    throw new LocalAgentError('Agent lokal memerlukan direktori kerja dan persetujuan akses tools eksplisit.')
  }
  if (signal.aborted) throw new LocalAgentError('Task agent lokal dihentikan.')
  if (agent.provider === 'claude') return runClaude(options)
  const codex = agent.provider === 'codex'
  const antigravity = agent.provider === 'antigravity'
  const label = agent.provider === 'omp' ? 'OMP' : codex ? 'Codex' : antigravity ? 'Antigravity' : 'Hermes'
  const protocol = codex ? 'app-server' : 'ACP'
  const command = antigravity
    ? findAntigravityExecutable()
    : (process.env[`${agent.provider.toUpperCase()}_COMMAND`] || agent.provider)
  const executable = command ? Bun.which(command) : null
  if (!executable) throw new LocalAgentError(`${label} tidak ditemukan. Periksa instalasi CLI dan PATH server.`)
  const args = agent.provider === 'omp'
    ? ['acp', '--cwd', agent.workspace, '--approval-mode', 'always-ask', '--no-extensions', '--no-lsp', '--no-title']
    : codex ? ['app-server', '-c', 'model_provider="openai"']
    : antigravity ? []
    : ['acp']
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' }
  if (codex) {
    delete environment.OPENAI_API_KEY
    delete environment.CODEX_API_KEY
    delete environment.OPENAI_BASE_URL
  }
  const child = spawn(executable, args, {
    cwd: agent.workspace,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    shell: false,
  })
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: LocalAgentError) => void
    timer: NodeJS.Timeout | undefined
  }>()
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let sequence = 0
  let sessionId = ''
  let turnId = ''
  const completion = codex ? Promise.withResolvers<LocalAgentError | null>() : null
  const messages = codex ? new Map<string, string>() : null
  let answer = ''
  let receivedBytes = 0
  let failure: LocalAgentError | null = null
  let stopping = false
  let termination: Promise<void> | undefined
  let permissionQueue = Promise.resolve()
  const progressSnapshots = new Map<string, string>()
  const ompTools = new Map<string, unknown>()

  function changedProgress(key: string, value: unknown): void {
    const snapshot = JSON.stringify(value)
    if (snapshot !== undefined && progressSnapshots.get(key) !== snapshot) {
      progressSnapshots.set(key, snapshot)
      options.onProgress()
    }
  }

  function terminate(): void {
    if (stopping) return
    stopping = true
    if (!child.pid) return
    const pid = child.pid
    try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    // A child tool can outlive the CLI; kill its process group after the grace period too.
    termination = Bun.sleep(800).then(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* The process group already exited. */ }
    })
  }

  function fail(error: LocalAgentError): void {
    if (failure) return
    failure = error
    completion?.resolve(error)
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    terminate()
  }

  function send(message: Record<string, unknown>): void {
    if (stopping || failure) return
    if (codex) delete message.jsonrpc
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !stopping) fail(new LocalAgentError(`Koneksi ke ${label} terputus.`))
    })
  }

  function request(method: string, params: Record<string, unknown>, timeout: number | null = 60_000): Promise<unknown> {
    if (failure) return Promise.reject(failure)
    if (stopping) return Promise.reject(new LocalAgentError(`${label} telah dihentikan.`))
    const id = ++sequence
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = timeout === null ? undefined : setTimeout(() => {
      fail(new LocalAgentError(`${label} tidak merespons protokol ${protocol}. Periksa versi CLI, login, dan model di terminal.`))
    }, timeout)
    pending.set(id, { resolve, reject, timer })
    send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  async function permission(message: Record<string, unknown>, ompTargets?: readonly string[]): Promise<void> {
    if (stopping || signal.aborted) return
    const params = message.params
    if (codex) {
      const valid = object(params) && params.threadId === sessionId && params.turnId === turnId && Boolean(turnId)
      const details = valid ? JSON.stringify(params, null, 2) : ''
      const canAccept = valid && details.length <= MAX_PERMISSION &&
        (params.availableDecisions === undefined || (Array.isArray(params.availableDecisions) && params.availableDecisions.includes('accept')))
      if (!valid) {
        send({ id: message.id, result: { decision: 'decline' } })
        return
      }
      onActivity('Menunggu persetujuan tindakan Codex di kantor.')
      const selected = await onPermission({
        requestId: crypto.randomUUID(), title: 'Persetujuan tools Codex',
        details: details.length <= MAX_PERMISSION ? details : `${details.slice(0, MAX_PERMISSION)}\n[Detail terlalu panjang; hanya penolakan tersedia.]`,
        options: [
          { id: 'reject_once', label: 'Tolak' },
          ...(canAccept ? [{ id: 'allow_once', label: 'Izinkan sekali' }] : []),
        ],
      })
      if (stopping || signal.aborted) return
      send({ id: message.id, result: { decision: canAccept && selected === 'allow_once' ? 'accept' : 'decline' } })
      onActivity(canAccept && selected === 'allow_once' ? 'Izin sekali diberikan; Codex melanjutkan.' : 'Tindakan Codex ditolak.')
      return
    }
    const form = message.method === 'elicitation/create'
    if (!sessionId || !object(params) || params.sessionId !== sessionId) {
      send({ jsonrpc: '2.0', id: message.id, result: form ? { action: 'decline' } : { outcome: { outcome: 'cancelled' } } })
      return
    }
    const choices = new Map<string, string>()
    let sessionSubject = ''
    let title: string
    let details: string
    if (form) {
      const schema = params.requestedSchema
      const properties = object(schema) && object(schema.properties) ? schema.properties : null
      const value = properties && object(properties.value) ? properties.value : null
      if (agent.provider !== 'omp' || params.mode !== 'form' || typeof params.message !== 'string' || !params.message.trim() ||
        !object(schema) || schema.type !== 'object' || !properties || Object.keys(properties).length !== 1 ||
        !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== 'value' ||
        !value || value.type !== 'string' || !Array.isArray(value.enum) || !value.enum.includes('Approve') || !value.enum.includes('Deny')) {
        send({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } })
        return
      }
      title = 'Persetujuan tools OMP'
      details = params.message
      choices.set('reject_once', 'Deny')
      // OMP offers "Approve <tool> for this session" for prompts it can remember; Ruang's session is one task run.
      const sessionChoice = value.enum.find((entry): entry is string => typeof entry === 'string' && /^Approve [\w .:/-]{1,60} for this session$/.test(entry))
      if (details.length <= MAX_PERMISSION) {
        choices.set('allow_once', 'Approve')
        if (sessionChoice) {
          choices.set('allow_session', sessionChoice)
          sessionSubject = sessionChoice.slice('Approve '.length, -' for this session'.length)
        }
      }
    } else {
      if (!object(params.toolCall) || !Array.isArray(params.options)) {
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
        return
      }
      title = typeof params.toolCall.title === 'string' ? params.toolCall.title.slice(0, 200) : `${label} meminta izin tools`
      details = JSON.stringify(params.toolCall, null, 2)
      for (const option of params.options) {
        if (!object(option) || typeof option.optionId !== 'string') continue
        if (option.kind === 'reject_once' && !choices.has('reject_once')) choices.set('reject_once', option.optionId)
        if (option.kind === 'allow_once' && details.length <= MAX_PERMISSION && !choices.has('allow_once')) {
          choices.set('allow_once', option.optionId)
        }
      }
    }
    const prompt: TaskPermission = {
      requestId: crypto.randomUUID(),
      title,
      details: details.length <= MAX_PERMISSION ? details : `${details.slice(0, MAX_PERMISSION)}\n[Detail terlalu panjang; hanya penolakan tersedia.]`,
      options: [...choices.keys()].map((id) => ({ id, label: id === 'allow_once' ? 'Izinkan sekali' : id === 'allow_session' ? `Izinkan ${sessionSubject} untuk sesi ini` : 'Tolak' })),
    }
    onActivity('Menunggu persetujuan tindakan di kantor.')
    const filePaths = choices.has('allow_once')
      ? form && agent.provider === 'omp' ? ompTargets
        : !form && agent.provider === 'hermes' ? hermesFileTargets(params.toolCall) : undefined
      : undefined
    const selected = await onPermission(prompt, filePaths)
    if (stopping || signal.aborted) return
    const optionId = selected === null ? undefined : choices.get(selected)
    const result = form
      ? optionId === 'Approve' || selected === 'allow_session' ? { action: 'accept', content: { value: optionId } } : { action: 'decline' }
      : { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
    send({ jsonrpc: '2.0', id: message.id, result })
    onActivity(optionId && selected === 'allow_session' ? `Izin ${sessionSubject} untuk sesi ini diberikan; agent melanjutkan.` : optionId && selected === 'allow_once' ? 'Izin sekali diberikan; agent melanjutkan.' : 'Tindakan ditolak; agent melanjutkan jika memungkinkan.')
  }

  function receive(message: unknown): void {
    if (!object(message) || (message.jsonrpc !== '2.0' && !(codex && message.jsonrpc === undefined))) {
      fail(new LocalAgentError(`${label} mengirim format ${protocol} yang tidak valid.`))
      return
    }
    if (typeof message.method === 'string') {
      if (codex) {
        if ((message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') &&
          (typeof message.id === 'number' || typeof message.id === 'string')) {
          permissionQueue = permissionQueue.then(() => permission(message)).catch(() => {
            fail(new LocalAgentError('Permintaan izin Codex tidak dapat diproses. Task dihentikan tanpa persetujuan otomatis.'))
          })
        } else if (typeof message.id === 'number' || typeof message.id === 'string') {
          send({ id: message.id, error: { code: -32601, message: 'Kantor tidak menyediakan operasi client ini.' } })
        } else if (object(message.params) && message.params.threadId === sessionId && sessionId) {
          const params = message.params
          if (message.method === 'turn/started' && object(params.turn) && typeof params.turn.id === 'string' && !turnId) {
            turnId = params.turn.id
          } else if (message.method === 'turn/completed' && object(params.turn) && params.turn.id === turnId && turnId) {
            if (params.turn.status === 'completed') completion?.resolve(null)
            else {
              const turnError = object(params.turn.error) ? params.turn.error : null
              const isUsage = turnError?.codexErrorInfo === 'usageLimitExceeded' || (typeof turnError?.message === 'string' && turnError.message.includes('usage limit'))
              fail(new LocalAgentError(isUsage && typeof turnError?.message === 'string'
                ? `Codex: ${turnError.message}`
                : 'Codex menghentikan task sebelum selesai. Periksa login ChatGPT, kuota, dan model di terminal.'))
            }
          } else if (params.turnId === turnId && turnId && messages) {
            let changed = false
            if (message.method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
              messages.set(params.itemId, (messages.get(params.itemId) ?? '') + params.delta)
              changed = true
            } else if ((message.method === 'item/completed' || message.method === 'item/started') && object(params.item)) {
              const item = params.item
              if (message.method === 'item/completed' && item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
                messages.set(item.id, item.text)
                changed = true
              } else if (typeof item.type === 'string' && Object.hasOwn(CODEX_WORK_ITEMS, item.type)) {
                onActivity(`Codex · ${item.type} · ${typeof item.status === 'string' ? item.status : message.method === 'item/completed' ? 'completed' : 'inProgress'}`)
                options.onProgress()
              }
            } else if ((message.method === 'item/reasoning/textDelta' || message.method === 'item/reasoning/summaryTextDelta' ||
              message.method === 'item/commandExecution/outputDelta' || message.method === 'item/plan/delta') && typeof params.delta === 'string' && params.delta.length) {
              options.onProgress()
            } else if (message.method === 'item/mcpToolCall/progress' && typeof params.itemId === 'string' && params.itemId &&
              typeof params.message === 'string' && params.message.trim()) {
              options.onProgress()
            } else if (message.method === 'item/commandExecution/terminalInteraction' && typeof params.itemId === 'string' &&
              typeof params.processId === 'string' && typeof params.stdin === 'string' && params.stdin.length) {
              options.onProgress()
            } else if (message.method === 'item/reasoning/summaryPartAdded' && typeof params.itemId === 'string' &&
              typeof params.summaryIndex === 'number' && Number.isInteger(params.summaryIndex) && params.summaryIndex >= 0) {
              changedProgress(`summary:${params.itemId}`, params.summaryIndex)
            } else if (message.method === 'turn/plan/updated' && Array.isArray(params.plan) &&
              params.plan.every((step) => object(step) && typeof step.step === 'string' &&
                (step.status === 'pending' || step.status === 'inProgress' || step.status === 'completed'))) {
              changedProgress('plan', params.plan)
            } else if (message.method === 'turn/diff/updated' && typeof params.diff === 'string') {
              changedProgress('diff', params.diff)
            } else if (message.method === 'item/fileChange/patchUpdated' && typeof params.itemId === 'string' &&
              Array.isArray(params.changes) && params.changes.every((change) => object(change) && typeof change.path === 'string' && typeof change.diff === 'string')) {
              changedProgress(`patch:${params.itemId}`, params.changes)
            }
            if (changed) {
              const output = [...messages.values()].join('\n\n')
              if (output.length > MAX_OUTPUT) {
                fail(new LocalAgentError('Jawaban agent lokal melampaui batas 120.000 karakter.'))
                return
              }
              if (answer !== output) options.onProgress()
              answer = output
              onOutput(answer)
            }
          }
        }
        return
      }
      if (message.method === 'session/update' && object(message.params) && sessionId && message.params.sessionId === sessionId) {
        const update = message.params.update
        if (!object(update)) return
        if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) && update.content.type === 'text' && typeof update.content.text === 'string') {
          if (!update.content.text.length) return
          if (answer.length + update.content.text.length > MAX_OUTPUT) {
            fail(new LocalAgentError('Jawaban agent lokal melampaui batas 120.000 karakter.'))
            return
          }
          answer += update.content.text
          options.onProgress()
          onOutput(answer)
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          if (agent.provider === 'omp' && typeof update.toolCallId === 'string') {
            if (update.status === 'completed' || update.status === 'failed') ompTools.delete(update.toolCallId)
            else if (update.sessionUpdate === 'tool_call') ompTools.set(update.toolCallId, update)
            else if (update.rawInput !== undefined) ompTools.set(update.toolCallId, null)
          }
          const title = typeof update.title === 'string' ? update.title.slice(0, 200) : 'Tools agent'
          const status = typeof update.status === 'string' ? update.status : 'in_progress'
          onActivity(`${title} · ${status}`)
          options.onProgress()
        } else if (update.sessionUpdate === 'agent_thought_chunk' && object(update.content) &&
          update.content.type === 'text' && typeof update.content.text === 'string' && update.content.text.length) {
          // Only the existence of reasoning is reported; its content stays private.
          options.onProgress()
        } else if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) &&
          update.content.type === 'image' && typeof update.content.data === 'string' && update.content.data.length &&
          typeof update.content.mimeType === 'string') {
          options.onProgress()
        } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries) &&
          update.entries.every((entry) => object(entry) && typeof entry.content === 'string' &&
            (entry.status === 'pending' || entry.status === 'in_progress' || entry.status === 'completed'))) {
          changedProgress('plan', update.entries)
        }
      } else if ((message.method === 'session/request_permission' || message.method === 'elicitation/create') && (typeof message.id === 'number' || typeof message.id === 'string')) {
        // Form elicitation has no tool-call ID: bind only a sole active call, at arrival, once.
        let targets: readonly string[] | undefined
        if (agent.provider === 'omp' && message.method === 'elicitation/create' && object(message.params) &&
          message.params.sessionId === sessionId && sessionId && ompTools.size === 1) {
          const [id, toolCall] = ompTools.entries().next().value!
          targets = ompFileTargets(message.params, toolCall, agent.workspace)
          ompTools.set(id, null)
        }
        permissionQueue = permissionQueue.then(() => permission(message, targets)).catch(() => {
          fail(new LocalAgentError('Permintaan izin agent lokal tidak dapat diproses. Task dihentikan tanpa persetujuan otomatis.'))
        })
      } else if (typeof message.id === 'number' || typeof message.id === 'string') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Kantor tidak menyediakan operasi client ini.' } })
      }
      return
    }
    if (typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(message.id)
    if (object(message.error)) {
      entry.reject(new LocalAgentError(`${label} menolak operasi ${protocol}. Periksa login, ID model, dan kompatibilitas versi CLI di terminal.`))
    } else if ('result' in message) entry.resolve(message.result)
    else entry.reject(new LocalAgentError(`${label} mengirim respons ${protocol} yang tidak lengkap.`))
  }

  function abort(): void {
    fail(new LocalAgentError('Task agent lokal dihentikan. Perubahan yang sudah dilakukan tidak dibatalkan.'))
  }

  child.stdin.on('error', () => { if (!stopping) fail(new LocalAgentError(`Koneksi ke ${label} terputus.`)) })
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopping) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > 32 * 1024 * 1024) {
      fail(new LocalAgentError('Data protokol agent lokal melampaui batas keselamatan.'))
      return
    }
    buffer += decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1 && !stopping) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > MAX_FRAME) {
        fail(new LocalAgentError('Pesan protokol agent lokal terlalu besar.'))
        return
      }
      if (line) {
        try { receive(JSON.parse(line) as unknown) } catch {
          fail(new LocalAgentError(`${label} tidak mengirim JSON-RPC ${protocol} yang valid. Periksa launcher CLI.`))
        }
      }
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_FRAME) fail(new LocalAgentError('Pesan protokol agent lokal terlalu besar.'))
  })
  // Drain diagnostics without returning potentially secret-bearing stderr to the browser.
  child.stderr.resume()
  child.on('error', () => fail(new LocalAgentError(`${label} gagal dimulai. Periksa executable, direktori kerja, dan izin sistem.`)))
  child.on('close', () => { if (!stopping) fail(new LocalAgentError(`${label} berhenti sebelum task selesai. Pastikan ${agent.provider} --version berhasil, lalu periksa login dan konfigurasi CLI di terminal.`)) })
  signal.addEventListener('abort', abort, { once: true })

  try {
    if (signal.aborted) abort()
    onActivity(`Memulai ${label} dan menghubungkan ${protocol}…`)
    const initialized = await request('initialize', {
      ...(!codex ? {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(agent.provider === 'omp' ? { elicitation: { form: {} } } : {}),
        },
      } : {}),
      clientInfo: { name: 'ruang-office', title: 'Ruang AI Office', version: '1.0.0' },
    })
    if (!codex && (!object(initialized) || initialized.protocolVersion !== 1)) throw new LocalAgentError(`${label} tidak mendukung versi ACP aplikasi ini.`)
    if (codex) {
      send({ method: 'initialized', params: {} })
      const account = await request('account/read', { refreshToken: false })
      if (!object(account) || !object(account.account) || account.account.type !== 'chatgpt') {
        throw new LocalAgentError('Codex memerlukan login ChatGPT. Jalankan codex login di terminal server; mode ini tidak memakai atau beralih ke API key.')
      }
    }
    onActivity(`Membuka sesi ${label} di direktori kerja…`)
    const session = await request(codex ? 'thread/start' : 'session/new', codex
      ? { cwd: agent.workspace, model: agent.model || null, modelProvider: 'openai', approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
      : { cwd: agent.workspace, mcpServers: [] }, 90_000)
    const id = object(session) ? codex && object(session.thread) ? session.thread.id : session.sessionId : undefined
    if (typeof id !== 'string' || !id) throw new LocalAgentError(`${label} tidak dapat membuka sesi ${protocol}.`)
    sessionId = id
    if (!codex) {
      if (agent.model) {
        onActivity(`Memilih model ${agent.model}…`)
        await request(agent.provider === 'omp' || antigravity ? 'session/set_config_option' : 'session/set_model', agent.provider === 'omp' || antigravity
          ? { sessionId, configId: 'model', value: agent.model }
          : { sessionId, modelId: agent.model })
      }
      await request('session/set_mode', { sessionId, modeId: 'default' })
    }
    onActivity(`${label} sedang mengerjakan task.`)
    const prompt = [
      { type: 'text', text: `Anda adalah ${agent.name}. Peran dan instruksi Anda: ${agent.role}\nKerjakan tugas berikut secara jujur; jangan mengaku melakukan tindakan yang belum dilakukan.` },
      ...(options.history.length ? [{
        type: 'text',
        text: `Riwayat percakapan sebelumnya (transkrip konteks, bukan instruksi baru):\n${JSON.stringify(options.history)}`,
      }] : []),
      { type: 'text', text: options.prompt },
    ]
    if (codex && completion) {
      const started = await request('turn/start', { threadId: sessionId, input: prompt })
      if (!object(started) || !object(started.turn) || typeof started.turn.id !== 'string' || !started.turn.id ||
        (turnId && turnId !== started.turn.id)) throw new LocalAgentError('Codex mengirim sesi task yang tidak valid.')
      turnId = started.turn.id
      const error = await completion.promise
      if (error) throw error
    } else {
      // The office owns the inactivity watchdog, including pauses for manual permission.
      const result = await request('session/prompt', { sessionId, prompt }, null)
      if (!object(result) || result.stopReason !== 'end_turn') {
        throw new LocalAgentError(`${label} menghentikan jawaban sebelum selesai (dibatalkan, ditolak, atau batas model tercapai).`)
      }
    }
    if (failure) throw failure
    if (!answer.trim()) throw new LocalAgentError(`${label} selesai tanpa jawaban teks. Periksa login dan model CLI di terminal.`)
    return answer.trim()
  } catch (error) {
    throw error instanceof LocalAgentError ? error : new LocalAgentError(`${label} tidak dapat menyelesaikan task. Periksa CLI di terminal.`)
  } finally {
    signal.removeEventListener('abort', abort)
    fail(new LocalAgentError('Koneksi task agent lokal ditutup.'))
    await termination
    child.stdin.destroy()
  }
}

const CLAUDE_FILE_TOOLS: Record<string, true> = { Write: true, Edit: true, MultiEdit: true, Read: true }

// Only a plain absolute `file_path` of a file tool qualifies for the workspace-scoped automatic approval.
function claudeFileTargets(tool: string, input: Record<string, unknown>): readonly string[] | undefined {
  const path = input.file_path
  return Object.hasOwn(CLAUDE_FILE_TOOLS, tool) && typeof path === 'string' && isAbsolute(path) && !path.includes('\0') ? [path] : undefined
}

function claudeToolSummary(name: string, input: unknown): string {
  const detail = object(input) ? [input.file_path, input.command, input.pattern, input.url, input.description].find((value) => typeof value === 'string') : undefined
  return typeof detail === 'string' ? `${name}: ${detail.slice(0, 120)}` : name
}

/**
 * Claude Code runs as its own headless process (`claude -p`, stream-json in and out) with the host permission channel:
 * every call it would ask about arrives as a `can_use_tool` control request and is answered from the office dialog.
 */
async function runClaude(options: LocalRunOptions): Promise<string> {
  const { agent, signal, onOutput, onActivity, onProgress, onPermission } = options
  const label = 'Claude Code'
  const executable = Bun.which(process.env.CLAUDE_COMMAND || 'claude')
  if (!executable) throw new LocalAgentError('Claude Code tidak ditemukan. Periksa instalasi CLI dan PATH server.')
  // The app's own API-provider settings must not redirect or bill Claude Code: it uses the login made in the terminal.
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete environment[key]
  const child = spawn(executable, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--no-session-persistence',
    '--append-system-prompt', `Anda adalah ${agent.name}. Peran dan instruksi Anda: ${agent.role}\nKerjakan tugas secara jujur; jangan mengaku melakukan tindakan yang belum dilakukan.`,
    ...(agent.model ? ['--model', agent.model] : []),
  ], { cwd: agent.workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false })
  const decoder = new StringDecoder('utf8')
  const done = Promise.withResolvers<void>()
  let buffer = ''
  let receivedBytes = 0
  let answer = ''
  let streamed = false
  let finalText = ''
  let authFailed = false
  let failure: LocalAgentError | null = null
  let stopping = false
  let termination: Promise<void> | undefined
  let permissionQueue = Promise.resolve()

  function terminate(): void {
    if (stopping) return
    stopping = true
    if (!child.pid) return
    const pid = child.pid
    try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    termination = Bun.sleep(800).then(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* The process group already exited. */ }
    })
  }

  function fail(error: LocalAgentError): void {
    if (failure) return
    failure = error
    done.resolve()
    terminate()
  }

  function send(message: Record<string, unknown>): void {
    if (stopping || failure) return
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !stopping) fail(new LocalAgentError(`Koneksi ke ${label} terputus.`))
    })
  }

  function append(text: string): void {
    if (!text) return
    if (answer.length + text.length > MAX_OUTPUT) {
      fail(new LocalAgentError('Jawaban agent lokal melampaui batas 120.000 karakter.'))
      return
    }
    answer += text
    onOutput(answer)
  }

  async function ask(id: string, request: Record<string, unknown>): Promise<void> {
    const tool = typeof request.tool_name === 'string' ? request.tool_name : 'tool'
    const input = object(request.input) ? request.input : {}
    const details = JSON.stringify({ tool, input }, null, 2)
    const fits = details.length <= MAX_PERMISSION
    const prompt: TaskPermission = {
      requestId: crypto.randomUUID(),
      title: `${label} meminta izin: ${tool}`.slice(0, 200),
      details: fits ? details : `${details.slice(0, MAX_PERMISSION)}\n[Detail terlalu panjang; hanya penolakan tersedia.]`,
      options: [{ id: 'reject_once', label: 'Tolak' }, ...(fits ? [{ id: 'allow_once', label: 'Izinkan sekali' }] : [])],
    }
    onActivity('Menunggu persetujuan tindakan di kantor.')
    const selected = await onPermission(prompt, fits ? claudeFileTargets(tool, input) : undefined)
    if (stopping || signal.aborted) return
    const allowed = fits && selected === 'allow_once'
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        // Recent CLI versions reject an allow without the (unchanged) input echoed back.
        response: allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Pengguna menolak tindakan ini di kantor.' },
      },
    })
    onActivity(allowed ? `Izin sekali diberikan; ${label} melanjutkan.` : `Tindakan ditolak; ${label} melanjutkan jika memungkinkan.`)
  }

  function receive(message: unknown): void {
    if (!object(message) || typeof message.type !== 'string') {
      fail(new LocalAgentError(`${label} mengirim format stream-json yang tidak valid.`))
      return
    }
    onProgress()
    if (message.type === 'control_request' && typeof message.request_id === 'string' && object(message.request)) {
      if (message.request.subtype === 'can_use_tool') {
        const id = message.request_id
        const request = message.request
        permissionQueue = permissionQueue.then(() => ask(id, request)).catch(() => {
          fail(new LocalAgentError('Permintaan izin Claude Code tidak dapat diproses. Task dihentikan tanpa persetujuan otomatis.'))
        })
      } else {
        send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Kantor tidak menyediakan operasi client ini.' } })
      }
    } else if (message.type === 'system' && message.subtype === 'init') {
      onActivity(`${label} sedang mengerjakan task.`)
    } else if (message.type === 'stream_event' && object(message.event)) {
      const event = message.event
      if (event.type === 'message_start') streamed = false
      else if (event.type === 'content_block_start' && object(event.content_block)) {
        if (event.content_block.type === 'text' && answer && !answer.endsWith('\n\n')) append('\n\n')
      } else if (event.type === 'content_block_delta' && object(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
        streamed = true
        append(event.delta.text)
      }
    } else if (message.type === 'assistant' && object(message.message)) {
      if (message.error === 'authentication_failed') authFailed = true
      const content = Array.isArray(message.message.content) ? message.message.content : []
      for (const block of content) {
        if (!object(block)) continue
        if (block.type === 'tool_use' && typeof block.name === 'string') onActivity(`${label} · ${claudeToolSummary(block.name, block.input)}`)
        else if (block.type === 'text' && typeof block.text === 'string' && !streamed && message.error === undefined) {
          if (answer && !answer.endsWith('\n\n')) append('\n\n')
          append(block.text)
        }
      }
    } else if (message.type === 'result') {
      if (message.is_error === true || message.subtype !== 'success') {
        const text = typeof message.result === 'string' ? message.result : ''
        fail(new LocalAgentError(authFailed || /authenticate|OAuth|log ?in/i.test(text)
          ? 'Claude Code belum login atau sesi login kedaluwarsa. Jalankan claude auth login di terminal server.'
          : /usage limit|rate limit/i.test(text) ? `Claude Code: ${text.slice(0, 200)}`
          : `Claude Code menghentikan task (${typeof message.subtype === 'string' ? message.subtype.slice(0, 40) : 'error'}). Periksa login, kuota, dan model di terminal.`))
        return
      }
      finalText = typeof message.result === 'string' ? message.result : ''
      done.resolve()
    }
  }

  function abort(): void {
    fail(new LocalAgentError('Task agent lokal dihentikan. Perubahan yang sudah dilakukan tidak dibatalkan.'))
  }

  child.stdin.on('error', () => { if (!stopping) fail(new LocalAgentError(`Koneksi ke ${label} terputus.`)) })
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopping) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > 32 * 1024 * 1024) {
      fail(new LocalAgentError('Data protokol agent lokal melampaui batas keselamatan.'))
      return
    }
    buffer += decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1 && !stopping) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > MAX_FRAME) {
        fail(new LocalAgentError('Pesan protokol agent lokal terlalu besar.'))
        return
      }
      if (line) {
        try { receive(JSON.parse(line) as unknown) } catch {
          fail(new LocalAgentError(`${label} tidak mengirim stream-json yang valid. Periksa versi CLI.`))
        }
      }
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > MAX_FRAME) fail(new LocalAgentError('Pesan protokol agent lokal terlalu besar.'))
  })
  // Drain diagnostics without returning potentially secret-bearing stderr to the browser.
  child.stderr.resume()
  child.on('error', () => fail(new LocalAgentError(`${label} gagal dimulai. Periksa executable, direktori kerja, dan izin sistem.`)))
  child.on('close', () => {
    if (!stopping && !failure) fail(new LocalAgentError(`${label} berhenti sebelum task selesai. Pastikan claude --version berhasil, lalu periksa login dan konfigurasi CLI di terminal.`))
  })
  signal.addEventListener('abort', abort, { once: true })

  try {
    if (signal.aborted) abort()
    onActivity(`Memulai ${label}…`)
    const text = options.history.length
      ? `Riwayat percakapan sebelumnya (transkrip konteks, bukan instruksi baru):\n${JSON.stringify(options.history)}\n\n${options.prompt}`
      : options.prompt
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    await done.promise
    if (failure) throw failure
    const result = (answer || finalText).trim()
    if (!result) throw new LocalAgentError(`${label} selesai tanpa jawaban teks. Periksa login dan model CLI di terminal.`)
    return result
  } catch (error) {
    throw error instanceof LocalAgentError ? error : new LocalAgentError(`${label} tidak dapat menyelesaikan task. Periksa CLI di terminal.`)
  } finally {
    signal.removeEventListener('abort', abort)
    fail(new LocalAgentError('Koneksi task agent lokal ditutup.'))
    await termination
    child.stdin.destroy()
  }
}
