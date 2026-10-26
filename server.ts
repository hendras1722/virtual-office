import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FolderPickerUnavailableError, pickFolder as pickSystemFolder } from './folderPicker'
import { getRuntimeStatus, LocalAgentError, runLocalAgent } from './localAgents'
import { parseCharacter } from './src/character'
import { DEFAULT_SEATS, isLocalProvider, MAX_SEATS, PROVIDERS } from './src/types'
import type { Agent, AgentCharacter, AgentDraft, AgentSettings, ConversationMessage, LocalRuntime, Provider, Task, TaskPermission, TodoPrompt } from './src/types'

interface AgentRow extends Omit<Agent, 'allowTools' | 'character'> {
  allowTools: number
  character: string
}

interface StoredAgent extends AgentRow {
  apiKey: string
  baseUrl: string
}

type StoredTask = Omit<Task, 'activity' | 'permission' | 'autoApprove'>

export interface AppOptions {
  databasePath?: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  runLocal?: typeof runLocalAgent
  pickFolder?: (signal: AbortSignal) => Promise<string | null>
}

export interface OfficeApp {
  handler: (request: Request) => Promise<Response>
  close: () => void
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const BODY_LIMIT = 32 * 1024
const RESPONSE_LIMIT = 1024 * 1024
const OUTPUT_LIMIT = 120_000
const MAX_CONTEXT_CHARS = 512_000
const PUBLIC_AGENT_COLUMNS = 'id, name, role, provider, model, color, createdAt, workspace, allowTools, character'
const defaultUrls: Record<Exclude<Provider, LocalRuntime['provider']>, string> = {
  openai: process.env.OPENAI_BASE_URL || '',
  anthropic: process.env.ANTHROPIC_BASE_URL || '',
  gemini: process.env.GEMINI_BASE_URL || '',
  deepseek: process.env.DEEPSEEK_BASE_URL || '',
  ollama: process.env.OLLAMA_BASE_URL || '',
  custom: '',
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RequestError(400, `${field} harus diisi, maksimal ${max} karakter.`)
  }
  return value.trim()
}

function fileInsideWorkspace(workspace: string, filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') ||
    filePath.endsWith(sep) || filePath.split(sep).includes('..')) return false
  const inside = (target: string): boolean => {
    const path = relative(workspace, target)
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  }
  const target = resolve(workspace, filePath)
  if (target === workspace || !inside(target)) return false
  try {
    if (realpathSync(workspace) !== workspace || !statSync(workspace).isDirectory()) return false
    const segments = relative(workspace, target).split(sep)
    let current = workspace
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      try {
        lstatSync(current)
      } catch (error: unknown) {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      }
      if (!inside(realpathSync(current))) return false
      const stat = statSync(current)
      if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false
    }
    return true
  } catch {
    return false
  }
}

function baseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RequestError(400, 'Base URL tidak valid.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash) {
    throw new RequestError(400, 'Base URL harus HTTPS (HTTP hanya untuk localhost), tanpa kredensial, query, atau fragmen.')
  }
  return url.href.replace(/\/+$/, '')
}

function requireRuntime(provider: LocalRuntime['provider']): void {
  if (!getRuntimeStatus().runtimes.some((runtime) => runtime.provider === provider && runtime.available)) {
    throw new RequestError(503, `${provider === 'omp' ? 'OMP' : provider === 'codex' ? 'Codex' : provider === 'antigravity' ? 'Antigravity' : provider === 'claude' ? 'Claude Code' : 'Hermes'} belum tersedia. Pastikan runtime lokal terpasang dan perintahnya dapat ditemukan.`)
  }
}

function storedCharacter(raw: string): AgentCharacter | null {
  try {
    return parseCharacter(JSON.parse(raw))
  } catch {
    return null
  }
}

function toAgent(row: AgentRow): Agent {
  return { ...row, allowTools: row.allowTools === 1, character: storedCharacter(row.character) }
}

// Omitted keeps the saved look on update (null on create); null picks the id-derived look; anything else must be a full valid look.
function characterInput(value: unknown, previous?: StoredAgent): AgentCharacter | null {
  if (value === undefined) return previous ? storedCharacter(previous.character) : null
  if (value === null) return null
  const character = parseCharacter(value)
  if (!character) throw new RequestError(400, 'Karakter tidak valid.')
  return character
}

function agentDraft(value: unknown, previous?: StoredAgent): AgentDraft {
  if (!isObject(value)) throw new RequestError(400, 'Data agen tidak valid.')
  const provider = value.provider
  if (typeof provider !== 'string' || !PROVIDERS.some((entry) => entry.id === provider)) {
    throw new RequestError(400, 'Provider tidak dikenal.')
  }
  const selectedProvider = provider as Provider
  const color = text(value.color, 'Warna', 7)
  if (!/^#[\da-f]{6}$/i.test(color)) throw new RequestError(400, 'Warna harus berupa hex enam digit.')
  const character = characterInput(value.character, previous)
  if (isLocalProvider(selectedProvider)) {
    if (value.allowTools !== true) {
      throw new RequestError(400, 'Agen lokal memerlukan persetujuan eksplisit untuk membaca, menulis, dan menjalankan perintah di komputer ini.')
    }
    const workspace = text(value.workspace, 'Workspace', 4096)
    if (!isAbsolute(workspace)) throw new RequestError(400, 'Workspace harus berupa path absolut ke direktori yang sudah ada.')
    let canonical: string
    try {
      canonical = realpathSync(workspace)
      if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new RequestError(400, 'Workspace harus berupa direktori yang sudah ada dan dapat diakses.')
    }
    const draft: AgentDraft = {
      name: text(value.name, 'Nama', 40), role: text(value.role, 'Peran', 1000),
      provider: selectedProvider, model: text(value.model, 'Model', 150, true), color,
      apiKey: '', baseUrl: '', workspace: canonical, allowTools: true, character,
    }
    requireRuntime(selectedProvider)
    return draft
  }
  const override = text(value.baseUrl, 'Base URL', 2048, selectedProvider !== 'custom')
  const endpoint = override || defaultUrls[selectedProvider]
  if (!endpoint) throw new RequestError(400, 'Base URL provider belum diatur. Isi variabel environment sesuai .env.example.')
  const normalizedEndpoint = baseUrl(endpoint)
  const retainedKey = previous?.provider === selectedProvider && baseUrl(previous.baseUrl) === normalizedEndpoint
    ? previous.apiKey : ''
  return {
    name: text(value.name, 'Nama', 40),
    role: text(value.role, 'Peran', 1000),
    model: text(value.model, 'Model', 150),
    provider: selectedProvider,
    color,
    apiKey: text(value.apiKey === undefined || value.apiKey === '' ? retainedKey : value.apiKey, 'API key', 1000, selectedProvider === 'ollama'),
    baseUrl: normalizedEndpoint,
    workspace: '',
    allowTools: false,
    character,
  }
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number, tooLarge: string): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new RequestError(413, tooLarge)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Gunakan Content-Type application/json.')
  }
  if (Number(request.headers.get('content-length')) > BODY_LIMIT) throw new RequestError(413, 'Permintaan terlalu besar.')
  const source = await readLimited(request.body, BODY_LIMIT, 'Permintaan terlalu besar.')
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new RequestError(400, 'JSON tidak valid.')
  }
}

function json(data: unknown, status = 200, message = ''): Response {
  return Response.json({ success: status < 400, data, message }, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

function localOrigins(): Set<string> {
  const configured = new URL(process.env.APP_ORIGIN || 'http://localhost:5173')
  if (!['localhost', '127.0.0.1'].includes(configured.hostname) ||
    !['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password ||
    configured.pathname !== '/' || configured.search || configured.hash) {
    throw new Error('APP_ORIGIN must be a localhost or 127.0.0.1 origin.')
  }
  const alternate = new URL(configured)
  alternate.hostname = configured.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  return new Set([configured.origin, alternate.origin, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`])
}

const PORT = 29417

function providerFailure(status: number): string {
  if (status === 401 || status === 403) return 'Autentikasi provider ditolak. Periksa API key dan izin model.'
  if (status === 429) return 'Batas penggunaan atau kuota provider tercapai. Coba lagi nanti.'
  if (status === 404) return 'Model atau endpoint provider tidak ditemukan. Periksa model dan Base URL.'
  if (status >= 500) return 'Provider sedang mengalami gangguan. Coba lagi nanti.'
  return `Provider menolak permintaan (HTTP ${status}). Periksa konfigurasi model.`
}

function extractOutput(value: unknown, provider: Provider): string {
  if (!isObject(value)) throw new Error('invalid response')
  let output: unknown
  if (provider === 'anthropic' && Array.isArray(value.content)) {
    const parts: string[] = []
    for (const item of value.content as unknown[]) {
      if (isObject(item) && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    }
    output = parts.join('\n')
  } else if (Array.isArray(value.choices)) {
    const first: unknown = value.choices[0]
    if (isObject(first) && isObject(first.message)) output = first.message.content
  }
  if (typeof output !== 'string' || !output.trim() || output.length > OUTPUT_LIMIT) throw new Error('invalid output')
  return output.trim()
}

export function createApp(options: AppOptions = {}): OfficeApp {
  const origins = localOrigins()
  const hosts = new Set([...origins].map((origin) => new URL(origin).host))
  const databasePath = resolve(options.databasePath || 'data/office.sqlite')
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(databasePath), 0o700)
  closeSync(openSync(databasePath, 'a', 0o600))
  chmodSync(databasePath, 0o600)
  const db = new Database(databasePath)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, color TEXT NOT NULL, createdAt TEXT NOT NULL,
      apiKey TEXT NOT NULL, baseUrl TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, completedAt TEXT, replyToId TEXT
    );
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_task ON tasks(agentId) WHERE status = 'running';
  `)
  const agentColumns = db.query<{ name: string }, []>('PRAGMA table_info(agents)').all()
  if (!agentColumns.some((column) => column.name === 'workspace')) {
    db.exec("ALTER TABLE agents ADD COLUMN workspace TEXT NOT NULL DEFAULT ''")
  }
  if (!agentColumns.some((column) => column.name === 'allowTools')) {
    db.exec('ALTER TABLE agents ADD COLUMN allowTools INTEGER NOT NULL DEFAULT 0')
  }
  if (!agentColumns.some((column) => column.name === 'character')) {
    db.exec("ALTER TABLE agents ADD COLUMN character TEXT NOT NULL DEFAULT ''")
  }
  const taskColumns = db.query<{ name: string }, []>('PRAGMA table_info(tasks)').all()
  if (!taskColumns.some((column) => column.name === 'replyToId')) {
    db.exec('ALTER TABLE tasks ADD COLUMN replyToId TEXT')
  }
  const seatCount = (): number => {
    const stored = Number(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'seats'").get()?.value)
    return Number.isInteger(stored) && stored >= 1 && stored <= MAX_SEATS ? stored : DEFAULT_SEATS
  }
  const interrupt = db.query("UPDATE tasks SET status = 'failed', error = ?, completedAt = ? WHERE status = 'running'")
  interrupt.run('Tugas terhenti karena server dimulai ulang atau dihentikan. Silakan kirim ulang.', new Date().toISOString())
  const upstreamFetch = options.fetch || fetch
  const runLocal = options.runLocal || runLocalAgent
  const pickFolder = options.pickFolder || pickSystemFolder
  const controllers = new Map<string, AbortController>()
  const activities = new Map<string, string>()
  const autoApprovals = new Set<string>()
  const permissions = new Map<string, { permission: TaskPermission; resolve: (optionId: string | null) => void }>()
  let closed = false
  let picking = false

  function resolvePermission(taskId: string, optionId: string | null = null): void {
    const pending = permissions.get(taskId)
    if (!pending) return
    permissions.delete(taskId)
    pending.resolve(optionId)
  }

  function publicTask(task: StoredTask): Task {
    return { ...task, activity: activities.get(task.id) || '', permission: permissions.get(task.id)?.permission || null, autoApprove: autoApprovals.has(task.id) }
  }

  function conversation(taskId: string, agentId?: string): StoredTask[] {
    const chain: StoredTask[] = []
    const seen = new Set<string>()
    let ancestorId: string | null = taskId
    while (ancestorId !== null) {
      if (seen.has(ancestorId)) throw new RequestError(409, 'Rantai percakapan tidak valid. Mulai task baru.')
      seen.add(ancestorId)
      const ancestor = db.query<StoredTask, [string]>('SELECT * FROM tasks WHERE id = ?').get(ancestorId)
      if (!ancestor) throw new RequestError(chain.length ? 409 : 404, 'Task asal atau riwayat percakapan tidak ditemukan.')
      if (agentId === undefined) agentId = ancestor.agentId
      if (ancestor.agentId !== agentId) {
        throw new RequestError(chain.length ? 409 : 400, 'Balasan hanya dapat memakai percakapan agent yang sama.')
      }
      if ((chain.length && ancestor.status === 'running') ||
        !['running', 'completed', 'failed'].includes(ancestor.status)) {
        throw new RequestError(409, 'Rantai percakapan memuat task yang belum selesai atau tidak valid.')
      }
      chain.push(ancestor)
      ancestorId = ancestor.replyToId
    }
    return chain.reverse()
  }

  async function execute(task: Task, agent: StoredAgent, history: ConversationMessage[]): Promise<void> {
    const controller = new AbortController()
    controllers.set(task.id, controller)
    const local = isLocalProvider(agent.provider)
    let timeout: NodeJS.Timeout | undefined
    function progress(): void {
      if (!local || closed || controller.signal.aborted || !controllers.has(task.id) || permissions.has(task.id)) return
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort('timeout'), 600_000)
    }
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolvePermission(task.id)
    }, { once: true })
    if (local) progress()
    else timeout = setTimeout(() => controller.abort('timeout'), 120_000)
    let output = ''
    let error = ''
    let lastOutputWrite = -Infinity
    try {
      if (local) {
        output = await runLocal({
          agent: { ...agent, allowTools: agent.allowTools === 1, character: storedCharacter(agent.character) }, prompt: task.prompt, history, signal: controller.signal,
          onOutput(value): void {
            if (closed || controller.signal.aborted || !controllers.has(task.id)) return
            if (value.length > OUTPUT_LIMIT) throw new LocalAgentError('Jawaban agen lokal terlalu besar.')
            if (value !== output) progress()
            output = value
            const now = performance.now()
            if (now - lastOutputWrite < 200) return
            lastOutputWrite = now
            db.query("UPDATE tasks SET output = ? WHERE id = ? AND status = 'running'").run(output, task.id)
          },
          onProgress: progress,
          onActivity(activity): void {
            if (closed || controller.signal.aborted || !controllers.has(task.id)) return
            progress()
            activities.set(task.id, activity)
          },
          onPermission(permission, filePaths): Promise<string | null> {
            if (closed || controller.signal.aborted || !controllers.has(task.id) || permissions.has(task.id)) return Promise.resolve(null)
            db.query("UPDATE tasks SET output = ? WHERE id = ? AND status = 'running'").run(output, task.id)
            if (autoApprovals.has(task.id) && permission.options.some((option) => option.id === 'allow_once') &&
              filePaths?.length && filePaths.every((filePath) => fileInsideWorkspace(agent.workspace, filePath))) {
              progress()
              return Promise.resolve('allow_once')
            }
            const { promise, resolve } = Promise.withResolvers<string | null>()
            clearTimeout(timeout)
            permissions.set(task.id, {
              permission: { ...permission, requestId: crypto.randomUUID() },
              resolve(optionId): void {
                progress()
                resolve(optionId)
              },
            })
            return promise
          },
        })
      } else {
        const system = `Anda adalah ${agent.name}, asisten AI di kantor virtual. Peran Anda: ${agent.role}\nBantu pengguna secara jujur dan jelas. Jangan mengaku telah menjalankan kode atau tindakan yang tidak benar-benar Anda lakukan.`
        const anthropic = agent.provider === 'anthropic'
        const messages: ConversationMessage[] = [...history, { role: 'user', content: task.prompt }]
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (anthropic) {
          headers['x-api-key'] = agent.apiKey
          headers['anthropic-version'] = '2023-06-01'
        } else if (agent.apiKey) headers.Authorization = `Bearer ${agent.apiKey}`
        const response = await upstreamFetch(`${agent.baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`, {
          method: 'POST', headers, signal: controller.signal, redirect: 'error',
          body: JSON.stringify(anthropic
            ? { model: agent.model, max_tokens: 4096, system, messages }
            : { model: agent.model, stream: false, messages: [{ role: 'system', content: system }, ...messages] }),
        })
        if (!response.ok) {
          error = providerFailure(response.status)
          await response.body?.cancel()
        } else {
          const source = await readLimited(response.body, RESPONSE_LIMIT, 'Respons terlalu besar.')
          output = extractOutput(JSON.parse(source) as unknown, agent.provider)
        }
      }
      if (controller.signal.aborted) throw new Error('aborted')
    } catch (caught: unknown) {
      error = controller.signal.aborted
        ? controller.signal.reason === 'cancelled'
          ? 'Task dihentikan. Perubahan yang telah dilakukan agen tidak dapat dibatalkan.'
          : local
            ? 'Agen lokal tidak menunjukkan aktivitas selama 10 menit. Task dihentikan; hasil sebagian tetap disimpan. Anda dapat melanjutkan percakapan.'
            : 'Provider tidak merespons dalam 120 detik. Silakan coba lagi.'
        : local
          ? caught instanceof LocalAgentError ? caught.message : 'Agen lokal gagal menjalankan tugas. Periksa autentikasi CLI, model, dan workspace.'
          : 'Tidak dapat membaca jawaban provider. Periksa koneksi, Base URL, dan format respons model.'
    } finally {
      clearTimeout(timeout)
      controllers.delete(task.id)
      autoApprovals.delete(task.id)
      activities.delete(task.id)
      resolvePermission(task.id)
    }
    if (!closed) {
      db.query('UPDATE tasks SET status = ?, output = ?, error = ?, completedAt = ? WHERE id = ? AND status = ?')
        .run(error ? 'failed' : 'completed', output, error, new Date().toISOString(), task.id, 'running')
    }
  }

  const dist = resolve(import.meta.dir, 'dist')
  async function staticFile(pathname: string): Promise<Response> {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return json(null, 400, 'Path tidak valid.')
    }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) {
      return json(null, 404, 'Tidak ditemukan.')
    }
    let target = resolve(dist, `.${decoded}`)
    if (!target.startsWith(`${dist}${sep}`) && target !== dist) return json(null, 404, 'Tidak ditemukan.')
    try {
      if (statSync(target).isDirectory()) target = resolve(target, 'index.html')
      if (!statSync(target).isFile()) throw new Error('not a file')
    } catch {
      if (extname(decoded)) return json(null, 404, 'Tidak ditemukan.')
      target = resolve(dist, 'index.html')
    }
    try {
      const canonical = realpathSync(target)
      if (!canonical.startsWith(`${dist}${sep}`)) return json(null, 404, 'Tidak ditemukan.')
      const file = Bun.file(canonical)
      if (!(await file.exists())) return json(null, 404, 'Tidak ditemukan.')
      return new Response(file, { headers: { 'Content-Type': file.type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
    } catch {
      return json(null, 404, 'Frontend belum dibangun. Jalankan bun run build lalu buka aplikasi Vite atau server ini.')
    }
  }

  async function handler(request: Request): Promise<Response> {
    try {
      if (closed) return json(null, 503, 'Server telah dihentikan.')
      const url = new URL(request.url)
      if (!hosts.has(request.headers.get('host') || url.host)) return json(null, 403, 'Host tidak diizinkan.')
      const origin = request.headers.get('origin')
      if (origin !== null && !origins.has(origin)) return json(null, 403, 'Origin tidak diizinkan.')
      const path = url.pathname
      if (request.method === 'GET' && path === '/api/health') return json({ status: 'ok' })
      if (request.method === 'GET' && path === '/api/runtimes') return json(getRuntimeStatus())
      if (request.method === 'POST' && path === '/api/pick-folder') {
        if (picking) throw new RequestError(409, 'Pemilih folder sedang terbuka.')
        picking = true
        try {
          let chosen: string | null
          try {
            chosen = await pickFolder(request.signal)
          } catch (error: unknown) {
            if (error instanceof FolderPickerUnavailableError) throw new RequestError(501, error.message)
            throw error
          }
          if (chosen === null) return json({ path: null })
          try {
            const canonical = realpathSync(chosen)
            if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
            return json({ path: canonical })
          } catch {
            throw new RequestError(400, 'Folder yang dipilih tidak dapat diakses.')
          }
        } finally {
          picking = false
        }
      }
      if (path === '/api/office' && (request.method === 'GET' || request.method === 'PUT')) {
        const agentCount = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agents').get()?.count || 0
        if (request.method === 'PUT') {
          const value = await body(request)
          const seats = isObject(value) ? value.seats : undefined
          if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) {
            throw new RequestError(400, `Jumlah bangku harus bilangan bulat 1 sampai ${MAX_SEATS}.`)
          }
          if (seats < agentCount) throw new RequestError(409, `Ada ${agentCount} agen. Hapus agen dulu sebelum mengurangi bangku menjadi ${seats}.`)
          db.query("INSERT INTO settings (key, value) VALUES ('seats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(seats))
        }
        return json({ seats: seatCount() })
      }
      if (request.method === 'GET' && path === '/api/agents') {
        return json(db.query<AgentRow, []>(`SELECT ${PUBLIC_AGENT_COLUMNS} FROM agents ORDER BY createdAt, rowid`).all().map(toAgent))
      }
      if (request.method === 'POST' && path === '/api/agents') {
        const draft = agentDraft(await body(request))
        const count = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agents').get()?.count || 0
        if (count >= seatCount()) throw new RequestError(409, `Kantor penuh. Maksimal ${seatCount()} agen. Tambah bangku atau hapus agen.`)
        const agent: Agent = {
          id: crypto.randomUUID(), name: draft.name, role: draft.role, provider: draft.provider,
          model: draft.model, color: draft.color, createdAt: new Date().toISOString(),
          workspace: draft.workspace, allowTools: draft.allowTools, character: draft.character ?? null,
        }
        db.query('INSERT INTO agents (id,name,role,provider,model,color,createdAt,apiKey,baseUrl,workspace,allowTools,character) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(agent.id, agent.name, agent.role, agent.provider, agent.model, agent.color, agent.createdAt, draft.apiKey, draft.baseUrl, agent.workspace, Number(agent.allowTools), agent.character ? JSON.stringify(agent.character) : '')
        return json(agent, 201, 'Agen ditambahkan.')
      }
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
      if (request.method === 'GET' && agentMatch) {
        const agent = db.query<StoredAgent, [string]>('SELECT * FROM agents WHERE id = ?').get(agentMatch[1]!)
        if (!agent) throw new RequestError(404, 'Agen tidak ditemukan.')
        const settings: AgentSettings = {
          id: agent.id, name: agent.name, role: agent.role, provider: agent.provider,
          model: agent.model, color: agent.color, createdAt: agent.createdAt,
          workspace: agent.workspace, allowTools: agent.allowTools === 1, character: storedCharacter(agent.character),
          baseUrl: agent.baseUrl, hasApiKey: Boolean(agent.apiKey),
        }
        return json(settings)
      }
      if (request.method === 'PUT' && agentMatch) {
        const value = await body(request)
        const current = db.query<StoredAgent, [string]>('SELECT * FROM agents WHERE id = ?').get(agentMatch[1]!)
        if (!current) throw new RequestError(404, 'Agen tidak ditemukan.')
        if (db.query("SELECT id FROM tasks WHERE agentId = ? AND status = 'running'").get(current.id)) {
          throw new RequestError(409, 'Agen masih mengerjakan tugas.')
        }
        const draft = agentDraft(value, current)
        const agent: Agent = {
          id: current.id, name: draft.name, role: draft.role, provider: draft.provider,
          model: draft.model, color: draft.color, createdAt: current.createdAt,
          workspace: draft.workspace, allowTools: draft.allowTools, character: draft.character ?? null,
        }
        db.query('UPDATE agents SET name = ?, role = ?, provider = ?, model = ?, color = ?, apiKey = ?, baseUrl = ?, workspace = ?, allowTools = ?, character = ? WHERE id = ?')
          .run(agent.name, agent.role, agent.provider, agent.model, agent.color, draft.apiKey, draft.baseUrl, agent.workspace, Number(agent.allowTools), agent.character ? JSON.stringify(agent.character) : '', agent.id)
        return json(agent, 200, 'Agen diperbarui.')
      }
      if (request.method === 'DELETE' && agentMatch) {
        const id = agentMatch[1]!
        if (!db.query('SELECT id FROM agents WHERE id = ?').get(id)) throw new RequestError(404, 'Agen tidak ditemukan.')
        if (db.query("SELECT id FROM tasks WHERE agentId = ? AND status = 'running'").get(id)) {
          throw new RequestError(409, 'Agen masih mengerjakan tugas.')
        }
        db.query('DELETE FROM agents WHERE id = ?').run(id)
        return json(null, 200, 'Agen dan riwayat tugas dihapus.')
      }
      if (request.method === 'GET' && path === '/api/todos') {
        return json(db.query<TodoPrompt, []>('SELECT * FROM todos ORDER BY createdAt, rowid').all())
      }
      if (request.method === 'POST' && path === '/api/todos') {
        const value = await body(request)
        if (!isObject(value)) throw new RequestError(400, 'Data Todo tidak valid.')
        const agentId = text(value.agentId, 'Agen', 100)
        const prompt = text(value.prompt, 'Instruksi', 12000)
        if (!db.query('SELECT id FROM agents WHERE id = ?').get(agentId)) throw new RequestError(404, 'Agen tidak ditemukan.')
        const todo: TodoPrompt = { id: crypto.randomUUID(), agentId, prompt, createdAt: new Date().toISOString() }
        db.query('INSERT INTO todos (id,agentId,prompt,createdAt) VALUES (?,?,?,?)')
          .run(todo.id, todo.agentId, todo.prompt, todo.createdAt)
        return json(todo, 201, 'Prompt disimpan ke Todo tanpa menjalankan agen.')
      }
      if (request.method === 'GET' && path === '/api/tasks') {
        return json(db.query<StoredTask, []>("SELECT * FROM tasks WHERE status = 'running' OR id IN (SELECT id FROM tasks ORDER BY createdAt DESC, rowid DESC LIMIT 100) ORDER BY createdAt DESC, rowid DESC").all().map(publicTask))
      }
      const taskConversation = path.match(/^\/api\/tasks\/([^/]+)\/conversation$/)
      if (request.method === 'GET' && taskConversation) {
        return json(conversation(text(taskConversation[1], 'Task percakapan', 100)).map(publicTask))
      }
      if (request.method === 'POST' && path === '/api/tasks') {
        const value = await body(request)
        if (!isObject(value)) throw new RequestError(400, 'Data tugas tidak valid.')
        const todoId = value.todoId === undefined ? null : text(value.todoId, 'Todo', 100)
        const todo = todoId === null ? null : db.query<TodoPrompt, [string]>('SELECT * FROM todos WHERE id = ?').get(todoId)
        if (todoId !== null && !todo) throw new RequestError(404, 'Todo tidak ditemukan atau sudah dijalankan.')
        if (todo && (value.autoApprove === true || (value.replyToId !== undefined && value.replyToId !== null))) {
          throw new RequestError(400, 'Todo harus dijalankan sebagai task baru dengan persetujuan tools manual.')
        }
        const agentId = todo ? todo.agentId : text(value.agentId, 'Agen', 100)
        const prompt = todo ? todo.prompt : text(value.prompt, 'Instruksi', 12000)
        const agent = db.query<StoredAgent, [string]>('SELECT * FROM agents WHERE id = ?').get(agentId)
        if (!agent) throw new RequestError(404, 'Agen tidak ditemukan.')
        if (value.autoApprove !== undefined && typeof value.autoApprove !== 'boolean') {
          throw new RequestError(400, 'Izinkan otomatis harus berupa boolean.')
        }
        if (value.autoApprove === true && !isLocalProvider(agent.provider)) {
          throw new RequestError(400, 'Izinkan otomatis hanya tersedia untuk agent lokal.')
        }
        if (db.query("SELECT id FROM tasks WHERE agentId = ? AND status = 'running'").get(agentId)) {
          throw new RequestError(409, 'Agen masih mengerjakan tugas. Tunggu sampai selesai.')
        }
        const replyToId = value.replyToId === undefined || value.replyToId === null
          ? null : text(value.replyToId, 'Task asal balasan', 100)
        const chain = replyToId === null ? [] : conversation(replyToId, agentId)
        const history: ConversationMessage[] = []
        let contextChars = prompt.length
        for (const turn of chain) {
          if (turn.status !== 'failed' && (turn.status !== 'completed' || !turn.output.trim())) {
            throw new RequestError(409, 'Balasan memerlukan task yang sudah selesai dengan jawaban atau task yang gagal.')
          }
          const content = turn.status === 'failed'
            ? `${turn.prompt}\n\n[Application task status: failed]\nThe previous execution failed or was interrupted and did not complete. Any assistant output for this turn is partial, not a completed result.\nStored error (JSON): ${JSON.stringify(turn.error)}\n[/Application task status]`
            : turn.prompt
          history.push({ role: 'user', content })
          if (turn.output) history.push({ role: 'assistant', content: turn.output })
          contextChars += content.length + turn.output.length
          if (contextChars > MAX_CONTEXT_CHARS) throw new RequestError(413, 'Percakapan melebihi 512.000 karakter konteks. Mulai task baru.')
        }
        if (isLocalProvider(agent.provider)) {
          if (agent.allowTools !== 1) throw new RequestError(400, 'Agen lokal belum memiliki persetujuan akses tools. Tambahkan ulang agen dengan persetujuan eksplisit.')
          requireRuntime(agent.provider)
        }
        const task: Task = {
          id: todo ? todo.id : crypto.randomUUID(), agentId, replyToId, prompt, status: 'running', output: '', error: '',
          createdAt: new Date().toISOString(), completedAt: null, activity: '', permission: null, autoApprove: value.autoApprove === true,
        }
        db.transaction(() => {
          db.query('INSERT INTO tasks (id,agentId,replyToId,prompt,status,createdAt) VALUES (?,?,?,?,?,?)')
            .run(task.id, task.agentId, task.replyToId, task.prompt, task.status, task.createdAt)
          if (todo) db.query('DELETE FROM todos WHERE id = ?').run(todo.id)
        })()
        if (task.autoApprove) autoApprovals.add(task.id)
        void execute(task, agent, history)
        return json(publicTask(task), 202, replyToId ? 'Balasan dikirim ke agen dengan konteks percakapan.' : 'Task baru dikirim ke agen tanpa konteks riwayat.')
      }
      const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(permission|cancel)$/)
      if (request.method === 'POST' && taskAction) {
        const id = taskAction[1]!
        const task = db.query<StoredTask, [string]>('SELECT * FROM tasks WHERE id = ?').get(id)
        if (!task) throw new RequestError(404, 'Tugas tidak ditemukan.')
        const controller = controllers.get(id)
        if (task.status !== 'running' || !controller || controller.signal.aborted) {
          throw new RequestError(409, 'Tugas tidak lagi aktif.')
        }
        if (taskAction[2] === 'cancel') {
          controller.abort('cancelled')
          resolvePermission(id)
          return json(publicTask(task), 200, 'Task dihentikan. Perubahan yang sudah dilakukan tidak dapat dibatalkan.')
        }
        const value = await body(request)
        if (!isObject(value) || typeof value.requestId !== 'string' ||
          !(value.optionId === null || typeof value.optionId === 'string')) {
          throw new RequestError(400, 'Jawaban izin harus berisi requestId dan optionId yang valid atau null untuk menolak.')
        }
        const pending = permissions.get(id)
        if (!pending || pending.permission.requestId !== value.requestId) {
          throw new RequestError(409, 'Permintaan izin sudah tidak berlaku.')
        }
        if (value.optionId !== null && (
          (value.optionId !== 'allow_once' && value.optionId !== 'allow_session' && value.optionId !== 'reject_once') ||
          !pending.permission.options.some((option) => option.id === value.optionId)
        )) {
          throw new RequestError(400, 'Pilihan izin tidak tersedia.')
        }
        resolvePermission(id, value.optionId)
        return json(publicTask(task), 200, 'Jawaban izin dikirim.')
      }
      if (path === '/api' || path.startsWith('/api/')) return json(null, 404, 'Endpoint tidak ditemukan.')
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(null, 405, 'Metode tidak diizinkan.')
      const response = await staticFile(path)
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
    } catch (error: unknown) {
      return error instanceof RequestError
        ? json(null, error.status, error.message)
        : json(null, 500, 'Server tidak dapat memproses permintaan.')
    }
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const controller of controllers.values()) controller.abort('shutdown')
    for (const id of permissions.keys()) resolvePermission(id)
    activities.clear()
    autoApprovals.clear()
    interrupt.run('Tugas terhenti karena server dihentikan. Silakan kirim ulang.', new Date().toISOString())
    db.close()
  }
  return { handler, close }
}

if (import.meta.main) {
  const app = createApp()
  // The native folder dialog can stay open for minutes, so give idle requests the maximum Bun allows.
  const hostname = process.env.HOST || '127.0.0.1'
  const server = Bun.serve({ hostname, port: PORT, fetch: app.handler, maxRequestBodySize: BODY_LIMIT, idleTimeout: 255 })
  console.log(`Kantor AI berjalan di http://${hostname}:${PORT}`)
  const shutdown = (): void => {
    app.close()
    void server.stop(true)
    process.exitCode = 0
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
