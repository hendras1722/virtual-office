import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createApp } from './server'
import { FolderPickerUnavailableError } from './folderPicker'
import { LocalAgentError } from './localAgents'
import type { AppOptions, OfficeApp } from './server'
import type { LocalRunOptions } from './localAgents'
import type { Agent, AgentDraft, AgentSettings, ApiResponse, RuntimeStatus, Task, TaskPermission, TodoPrompt } from './src/types'

const fixtures: { app: OfficeApp; directory: string }[] = []
const runtimeCommands = new Map<string, string | undefined>()
const timerRestorations: (() => void)[] = []

function taskClock(): { advance: (milliseconds: number) => Promise<void>; pending: () => number } {
  let now = 0
  const timers = new Map<unknown, { timer: NodeJS.Timeout; due: number; run: () => void }>()
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const schedule = Object.assign((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]): NodeJS.Timeout => {
    if (delay !== 600_000 && delay !== 120_000) return originalSet(callback, delay, ...args)
    const timer = originalSet(() => {}, 2_000_000_000)
    timers.set(timer, { timer, due: now + delay, run: () => callback(...args) })
    return timer
  }, originalSet)
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(schedule)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    timers.delete(timer)
    originalClear(timer as NodeJS.Timeout | undefined)
  })
  timerRestorations.push(() => {
    for (const entry of timers.values()) originalClear(entry.timer)
    timers.clear()
    set.mockRestore()
    clear.mockRestore()
  })
  return {
    async advance(milliseconds): Promise<void> {
      const target = now + milliseconds
      for (;;) {
        const next = [...timers.values()].filter((entry) => entry.due <= target).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        now = next.due
        timers.delete(next.timer)
        originalClear(next.timer)
        next.run()
        await Promise.resolve()
      }
      now = target
      await Promise.resolve()
    },
    pending: () => timers.size,
  }
}

function setup(upstream?: AppOptions['fetch'], runLocal?: AppOptions['runLocal'], pickFolder?: AppOptions['pickFolder']): { app: OfficeApp; directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'virtual-office-test-'))
  const databasePath = join(directory, 'office.sqlite')
  const app = createApp({ databasePath, fetch: upstream || (async () => { throw new Error('Unexpected upstream request') }), runLocal, pickFolder })
  fixtures.push({ app, directory })
  return { app, directory, databasePath }
}

function setRuntimeCommand(provider: 'omp' | 'hermes' | 'codex' | 'antigravity' | 'claude', command: string): void {
  const key = `${provider.toUpperCase()}_COMMAND`
  if (!runtimeCommands.has(key)) runtimeCommands.set(key, process.env[key])
  process.env[key] = command
}

function request(app: OfficeApp, method: string, path: string, value?: unknown, headers?: HeadersInit): Promise<Response> {
  const requestHeaders = new Headers(headers)
  if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json')
  return app.handler(new Request(`http://127.0.0.1:29417${path}`, {
    method,
    headers: requestHeaders,
    body: value === undefined ? undefined : JSON.stringify(value),
  }))
}

const draft: AgentDraft = {
  name: 'Mira', role: 'Engineer yang teliti', provider: 'openai', model: 'test-model',
  color: '#8c9eff', apiKey: 'private-fixture-key', baseUrl: 'https://fixture.example/v1',
  workspace: '', allowTools: false,
}

async function addAgent(app: OfficeApp, changes: Partial<AgentDraft> = {}): Promise<Agent> {
  const response = await request(app, 'POST', '/api/agents', { ...draft, ...changes })
  expect(response.status).toBe(201)
  return ((await response.json()) as ApiResponse<Agent>).data
}

async function addTodo(app: OfficeApp, agentId: string, prompt: string): Promise<TodoPrompt> {
  const response = await request(app, 'POST', '/api/todos', { agentId, prompt })
  expect(response.status).toBe(201)
  return ((await response.json()) as ApiResponse<TodoPrompt>).data
}

async function settledTask(app: OfficeApp, id: string): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(app, 'GET', '/api/tasks')
    const tasks = ((await response.json()) as ApiResponse<Task[]>).data
    const task = tasks.find((entry) => entry.id === id)
    if (task && task.status !== 'running') return task
  }
  throw new Error('Task did not settle')
}

async function completeTask(app: OfficeApp, agentId: string, prompt: string, replyToId?: string | null): Promise<Task> {
  const response = await request(app, 'POST', '/api/tasks', { agentId, prompt, replyToId })
  expect(response.status).toBe(202)
  const initial = ((await response.json()) as ApiResponse<Task>).data
  expect(initial.replyToId).toBe(replyToId ?? null)
  const task = await settledTask(app, initial.id)
  expect(task.status).toBe('completed')
  return task
}

afterEach(() => {
  const entries = fixtures.splice(0)
  for (const fixture of entries) fixture.app.close()
  for (const fixture of entries) rmSync(fixture.directory, { recursive: true, force: true })
  for (const restore of timerRestorations.splice(0)) restore()
  for (const [key, value] of runtimeCommands) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  runtimeCommands.clear()
})

describe('local office API', () => {
  test('persists agents privately, never returns credentials, and exposes health', async () => {
    const { app, databasePath, directory } = setup()
    const agent = await addAgent(app)
    const response = await request(app, 'GET', '/api/agents')
    const serialized = await response.text()
    expect(serialized).not.toContain(draft.apiKey)
    expect(serialized).not.toContain(draft.baseUrl)
    expect(agent).not.toHaveProperty('apiKey')
    expect(agent).not.toHaveProperty('baseUrl')
    expect(statSync(databasePath).mode & 0o777).toBe(0o600)
    expect(agent.workspace).toBe('')
    expect(agent.allowTools).toBe(false)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const saved = ((await (await request(restarted, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data
    expect(saved).toEqual([agent])
    expect((await request(restarted, 'GET', '/api/health')).status).toBe(200)
  })

  test('edits a full office without replacing identity, leaking credentials, or losing persisted conversations', async () => {
    let sent: { url: string; key: string | null; model: string; messages: { role: string; content: string }[] } | undefined
    const { app, databasePath, directory } = setup(async (input, init) => {
      const payload = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[] }
      sent = { url: String(input), key: new Headers(init?.headers).get('Authorization'), ...payload }
      return Response.json({ choices: [{ message: { content: 'Stored answer' } }] })
    })
    const agent = await addAgent(app)
    const first = await completeTask(app, agent.id, 'Original question')
    for (let index = 1; index < 12; index++) await addAgent(app, { name: `Agent ${index}` })
    const settingsResponse = await request(app, 'GET', `/api/agents/${agent.id}`)
    expect(settingsResponse.status).toBe(200)
    const settings = ((await settingsResponse.json()) as ApiResponse<AgentSettings>).data
    expect(settings).toEqual({ ...agent, baseUrl: draft.baseUrl, hasApiKey: true })
    expect(settings).not.toHaveProperty('apiKey')
    const changes = { ...draft, name: 'Edited Mira', role: 'New role', model: 'new-model', color: '#123abc', apiKey: '', baseUrl: 'https://FIXTURE.example:443/v1///' }
    const response = await request(app, 'PUT', `/api/agents/${agent.id}`, { ...changes, id: 'replacement', createdAt: 'replacement' })
    expect(response.status).toBe(200)
    const edited = ((await response.json()) as ApiResponse<Agent>).data
    expect(edited).toEqual({ ...agent, name: changes.name, role: changes.role, model: changes.model, color: changes.color })
    expect(edited).not.toHaveProperty('apiKey')
    expect(edited).not.toHaveProperty('baseUrl')
    expect(edited).not.toHaveProperty('hasApiKey')
    const agents = ((await (await request(app, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data
    expect(agents).toHaveLength(12)
    expect(agents.find((entry) => entry.id === agent.id)).toEqual(edited)
    const reply = await completeTask(app, agent.id, 'Continue after editing', first.id)
    expect(sent?.url).toBe(`${draft.baseUrl}/chat/completions`)
    expect(sent?.key).toBe(`Bearer ${draft.apiKey}`)
    expect(sent?.model).toBe(changes.model)
    expect(sent?.messages[0]?.content).toContain(changes.role)
    expect(sent?.messages.slice(1)).toEqual([
      { role: 'user', content: first.prompt }, { role: 'assistant', content: first.output },
      { role: 'user', content: reply.prompt },
    ])
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    expect(((await (await request(restarted, 'GET', `/api/agents/${agent.id}`)).json()) as ApiResponse<AgentSettings>).data)
      .toEqual({ ...edited, baseUrl: draft.baseUrl, hasApiKey: true })
    expect(((await (await request(restarted, 'GET', `/api/tasks/${reply.id}/conversation`)).json()) as ApiResponse<Task[]>).data)
      .toEqual([first, reply])
    const db = new Database(databasePath)
    expect(db.query('SELECT apiKey, baseUrl FROM agents WHERE id = ?').get(agent.id))
      .toEqual({ apiKey: draft.apiKey, baseUrl: draft.baseUrl })
    db.close()
  })

  test('retains omitted keys only at the same normalized provider endpoint and supports explicit key rotation', async () => {
    const { app, databasePath } = setup()
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const withoutKey: Partial<AgentDraft> = { ...draft }
    delete withoutKey.apiKey
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, withoutKey)).status).toBe(200)
    expect(db.query('SELECT apiKey FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: draft.apiKey })
    const rotatedKey = 'new-private-key'
    const rotation = await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: rotatedKey })
    expect(rotation.status).toBe(200)
    expect(await rotation.text()).not.toContain(rotatedKey)
    expect(db.query('SELECT apiKey FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: rotatedKey })
    const before = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)
    for (const changes of [
      { baseUrl: 'https://other.example/v1' }, { baseUrl: 'https://fixture.example/other' },
      { baseUrl: 'https://fixture.example:8443/v1' }, { provider: 'anthropic' },
    ]) {
      for (const apiKey of ['', undefined]) {
        expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, ...changes, apiKey })).status).toBe(400)
        expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(before)
      }
    }
    const replacement = { ...draft, provider: 'custom', baseUrl: 'https://other.example/v2', apiKey: 'different-host-key' }
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, replacement)).status).toBe(200)
    expect(db.query('SELECT provider, baseUrl, apiKey FROM agents WHERE id = ?').get(agent.id))
      .toEqual({ provider: replacement.provider, baseUrl: replacement.baseUrl, apiKey: replacement.apiKey })
    const serialized = await (await request(app, 'GET', `/api/agents/${agent.id}`)).text()
    for (const key of [draft.apiKey, rotatedKey, replacement.apiKey]) expect(serialized).not.toContain(key)
    db.close()
  })

  test('does not forward credentials when switching to key-optional Ollama or changing its endpoint', async () => {
    const { app, databasePath } = setup()
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const ollama = { ...draft, provider: 'ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1' }
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, ollama)).status).toBe(200)
    expect(db.query('SELECT apiKey FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: '' })
    expect(((await (await request(app, 'GET', `/api/agents/${agent.id}`)).json()) as ApiResponse<AgentSettings>).data.hasApiKey).toBe(false)
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...ollama, apiKey: 'optional-key' })).status).toBe(200)
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, ollama)).status).toBe(200)
    expect(db.query('SELECT apiKey FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: 'optional-key' })
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...ollama, baseUrl: 'http://localhost:11434/v1' })).status).toBe(200)
    expect(db.query('SELECT apiKey FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: '' })
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: '' })).status).toBe(400)
    db.close()
  })

  test('rejects invalid full updates and unknown agents without changing saved data', async () => {
    const { app, databasePath } = setup()
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const before = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)
    const invalid: unknown[] = [
      null, [], {}, { ...draft, provider: 'unknown' }, { ...draft, name: '' },
      { ...draft, model: 'x'.repeat(151) }, { ...draft, role: 'x'.repeat(1001) }, { ...draft, color: '#oops' },
      { ...draft, baseUrl: 'http://external.example/v1' }, { ...draft, baseUrl: 'not a URL' },
      { ...draft, baseUrl: 'https://user:password@example.com/v1' },
      { ...draft, baseUrl: 'https://example.com/v1?key=secret' }, { ...draft, baseUrl: 'https://example.com/v1#fragment' },
      { ...draft, provider: 'custom', baseUrl: '' },
      ...[null, false, 42, [], {}, '   ', 'x'.repeat(1001)].map((apiKey) => ({ ...draft, apiKey })),
    ]
    for (const value of invalid) {
      expect((await request(app, 'PUT', `/api/agents/${agent.id}`, value)).status).toBe(400)
      expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(before)
    }
    expect((await request(app, 'GET', '/api/agents/missing')).status).toBe(404)
    expect((await request(app, 'PUT', '/api/agents/missing', draft)).status).toBe(404)
    expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(before)
    db.close()
  })

  test.each(['running', 'deleted', 'rotated'] as const)('checks current agent state after a delayed edit body: %s', async (scenario) => {
    const { app, databasePath } = setup(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const agent = await addAgent(app)
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const pending = app.handler(new Request(`http://127.0.0.1:29417/api/agents/${agent.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream<Uint8Array>({ start(controller): void { stream = controller } }),
    }))
    if (scenario === 'running') {
      expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Keep working' })).status).toBe(202)
    } else if (scenario === 'deleted') {
      expect((await request(app, 'DELETE', `/api/agents/${agent.id}`)).status).toBe(200)
    } else {
      expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: 'concurrent-key' })).status).toBe(200)
    }
    const db = new Database(databasePath)
    const before = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)
    const tasksBefore = db.query('SELECT * FROM tasks').all()
    stream?.enqueue(new TextEncoder().encode(JSON.stringify({ ...draft, name: 'Delayed edit', apiKey: '' })))
    stream?.close()
    expect((await pending).status).toBe(scenario === 'running' ? 409 : scenario === 'deleted' ? 404 : 200)
    if (scenario === 'rotated') {
      expect(db.query('SELECT name, apiKey FROM agents WHERE id = ?').get(agent.id))
        .toEqual({ name: 'Delayed edit', apiKey: 'concurrent-key' })
    } else {
      expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(before)
    }
    expect(db.query('SELECT * FROM tasks').all()).toEqual(tasksBefore)
    db.close()
  })

  test('sends OpenAI-compatible payload and persists a completed answer', async () => {
    let upstreamUrl = ''
    let upstreamBody: Record<string, unknown> = {}
    let upstreamHeaders = new Headers()
    const { app, databasePath, directory } = setup(async (input, init) => {
      upstreamUrl = String(input)
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamHeaders = new Headers(init?.headers)
      return Response.json({ choices: [{ message: { content: '  Jawaban sungguhan dari fixture.  ' } }] })
    })
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Jelaskan desain.' })
    expect(response.status).toBe(202)
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial.status).toBe('running')
    expect(initial.activity).toBe('')
    expect(initial.permission).toBeNull()
    expect(initial.replyToId).toBeNull()
    const task = await settledTask(app, initial.id)
    expect(task.status).toBe('completed')
    expect(task.output).toBe('Jawaban sungguhan dari fixture.')
    expect(task.error).toBe('')
    expect(task.completedAt).not.toBeNull()
    expect(upstreamUrl).toBe('https://fixture.example/v1/chat/completions')
    expect(upstreamHeaders.get('Authorization')).toBe(`Bearer ${draft.apiKey}`)
    expect(upstreamBody.model).toBe(draft.model)
    expect(upstreamBody.stream).toBe(false)
    const messages = upstreamBody.messages as { role: string; content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain(draft.role)
    expect(messages[1]).toEqual({ role: 'user', content: 'Jelaskan desain.' })
    expect(messages).toHaveLength(2)
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const saved = ((await (await request(restarted, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    expect(saved).toEqual([task])
    expect((await request(restarted, 'DELETE', `/api/agents/${agent.id}`)).status).toBe(200)
    expect(((await (await request(restarted, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
  })

  test('sends Anthropic system separately and combines text blocks only', async () => {
    let captured: Record<string, unknown> = {}
    let capturedUrl = ''
    let capturedHeaders = new Headers()
    const { app } = setup(async (input, init) => {
      capturedUrl = String(input)
      capturedHeaders = new Headers(init?.headers)
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ content: [
        { type: 'text', text: 'Bagian pertama.' },
        { type: 'tool_use', name: 'not-executed', input: {} },
        { type: 'text', text: 'Bagian kedua.' },
      ] })
    })
    const agent = await addAgent(app, { provider: 'anthropic', model: 'claude-test' })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tinjau rencana.' })
    const task = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(task.output).toBe('Bagian pertama.\nBagian kedua.')
    expect(capturedUrl).toBe('https://fixture.example/v1/messages')
    expect(capturedHeaders.get('x-api-key')).toBe(draft.apiKey)
    expect(capturedHeaders.get('anthropic-version')).toBe('2023-06-01')
    expect(capturedHeaders.has('Authorization')).toBe(false)
    expect(captured.system).toContain(draft.role)
    expect(captured.max_tokens).toBe(4096)
    expect(captured.messages).toEqual([{ role: 'user', content: 'Tinjau rencana.' }])
    const reply = await completeTask(app, agent.id, 'Perjelas bagian kedua.', task.id)
    expect(reply.replyToId).toBe(task.id)
    expect(captured.system).toContain(draft.role)
    expect(captured.messages).toEqual([
      { role: 'user', content: 'Tinjau rencana.' },
      { role: 'assistant', content: 'Bagian pertama.\nBagian kedua.' },
      { role: 'user', content: 'Perjelas bagian kedua.' },
    ])
  })

  test('replies send only their ancestor branch in order while new tasks stay isolated', async () => {
    const conversations: { role: string; content: string }[][] = []
    const { app } = setup(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      conversations.push(body.messages)
      return Response.json({ choices: [{ message: { content: `Answer ${conversations.length}` } }] })
    })
    const agent = await addAgent(app)
    const other = await addAgent(app, { name: 'Other agent' })
    const root = await completeTask(app, agent.id, 'Root question')
    await completeTask(app, agent.id, 'Unrelated private question')
    await completeTask(app, other.id, 'Other agent secret')
    await completeTask(app, agent.id, 'Sibling private question', root.id)
    const parent = await completeTask(app, agent.id, 'Parent question', root.id)
    await completeTask(app, agent.id, 'Current question', parent.id)
    expect(conversations[5]?.slice(1)).toEqual([
      { role: 'user', content: 'Root question' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Parent question' },
      { role: 'assistant', content: 'Answer 5' },
      { role: 'user', content: 'Current question' },
    ])
    await completeTask(app, agent.id, 'Explicitly new question', null)
    await completeTask(app, agent.id, 'Another independent question')
    expect(conversations[6]?.slice(1)).toEqual([{ role: 'user', content: 'Explicitly new question' }])
    expect(conversations[7]?.slice(1)).toEqual([{ role: 'user', content: 'Another independent question' }])
  })

  test.each(['openai', 'anthropic'] as const)('continues an empty failed %s turn with its original prompt and safe failure note', async (provider) => {
    const conversations: { role: string; content: string }[][] = []
    const { app } = setup(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      conversations.push(body.messages)
      if (conversations.length === 1) return new Response(`private upstream body ${draft.apiKey}`, { status: 503 })
      const failed = body.messages.find((message) => message.content.includes('Original task token ORCHID'))
      const token = failed?.content.match(/Original task token ([A-Z]+)/)?.[1] || 'UNKNOWN'
      return provider === 'anthropic'
        ? Response.json({ content: [{ type: 'text', text: token }] })
        : Response.json({ choices: [{ message: { content: token } }] })
    })
    const agent = await addAgent(app, { provider })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Original task token ORCHID' })
    const failed = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(failed.status).toBe('failed')
    expect(failed.output).toBe('')
    const reply = await completeTask(app, agent.id, 'Lanjutkan', failed.id)
    expect(reply.output).toBe('ORCHID')
    const messages = conversations[1]!.filter((message) => message.role !== 'system')
    expect(messages).toEqual([
      {
        role: 'user',
        content: `${failed.prompt}\n\n[Application task status: failed]\nThe previous execution failed or was interrupted and did not complete. Any assistant output for this turn is partial, not a completed result.\nStored error (JSON): ${JSON.stringify(failed.error)}\n[/Application task status]`,
      },
      { role: 'user', content: 'Lanjutkan' },
    ])
    expect(JSON.stringify(messages)).not.toContain(draft.apiKey)
    const conversation = await request(app, 'GET', `/api/tasks/${reply.id}/conversation`)
    expect(conversation.status).toBe(200)
    expect(((await conversation.json()) as ApiResponse<Task[]>).data).toEqual([failed, reply])
  })

  test('reconstructs persisted reply links after restart even outside the latest one hundred tasks', async () => {
    let messages: { role: string; content: string }[] = []
    const upstream: NonNullable<AppOptions['fetch']> = async (_input, init) => {
      const body: { messages: typeof messages } = JSON.parse(String(init?.body))
      messages = body.messages
      return Response.json({ choices: [{ message: { content: `Saved answer to ${messages.at(-1)?.content}` } }] })
    }
    const { app, directory, databasePath } = setup(upstream)
    const agent = await addAgent(app)
    const root = await completeTask(app, agent.id, 'Original question')
    const parent = await completeTask(app, agent.id, 'Follow-up question', root.id)
    const db = new Database(databasePath)
    db.query('UPDATE tasks SET createdAt = ?').run('2000-01-01T00:00:00.000Z')
    const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,createdAt) VALUES (?,?,?,?,?,?)')
    for (let index = 0; index < 101; index++) {
      insert.run(crypto.randomUUID(), agent.id, `Unrelated ${index}`, 'completed', `Private ${index}`, '2001-01-01T00:00:00.000Z')
    }
    db.close()
    app.close()
    const restarted = createApp({ databasePath, fetch: upstream })
    fixtures.push({ app: restarted, directory })
    const visible = ((await (await request(restarted, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    expect(visible).toHaveLength(100)
    expect(visible.some((task) => task.id === root.id || task.id === parent.id)).toBe(false)
    const savedConversation = await request(restarted, 'GET', `/api/tasks/${parent.id}/conversation`)
    expect(savedConversation.status).toBe(200)
    expect(((await savedConversation.json()) as ApiResponse<Task[]>).data).toEqual([
      { ...root, createdAt: '2000-01-01T00:00:00.000Z' },
      { ...parent, createdAt: '2000-01-01T00:00:00.000Z' },
    ])
    const reply = await completeTask(restarted, agent.id, 'Remember both answers', parent.id)
    expect(reply.replyToId).toBe(parent.id)
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: root.prompt },
      { role: 'assistant', content: root.output },
      { role: 'user', content: parent.prompt },
      { role: 'assistant', content: parent.output },
      { role: 'user', content: 'Remember both answers' },
    ])
  })

  test.each([
    ['other-agent', 400], ['missing', 404], ['running', 409], ['invalid-status', 409],
    ['empty', 409], ['blank', 409], ['cycle', 409], ['missing-ancestor', 409], ['foreign-ancestor', 409],
  ] as const)('rejects %s reply history without contacting a provider or inserting a task', async (scenario, status) => {
    let calls = 0
    const { app, databasePath } = setup(async () => {
      calls++
      return Response.json({ choices: [{ message: { content: 'Must not run' } }] })
    })
    const agent = await addAgent(app)
    const other = await addAgent(app, { name: 'Other' })
    const parentId = crypto.randomUUID()
    const ancestorId = crypto.randomUUID()
    const db = new Database(databasePath)
    const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,createdAt,replyToId) VALUES (?,?,?,?,?,?,?)')
    if (scenario !== 'missing') {
      insert.run(parentId, scenario === 'other-agent' ? other.id : agent.id, 'Stored question',
        scenario === 'running' ? 'running' : scenario === 'invalid-status' ? 'invalid' : 'completed',
        scenario === 'empty' ? '' : scenario === 'blank' ? ' \n ' : 'Stored answer', '2026-01-01',
        scenario === 'cycle' ? parentId : scenario === 'missing-ancestor' || scenario === 'foreign-ancestor' ? ancestorId : null)
    }
    if (scenario === 'foreign-ancestor') {
      insert.run(ancestorId, other.id, 'Private foreign question', 'completed', 'Private foreign answer', '2026-01-01', null)
    }
    const before = db.query('SELECT COUNT(*) AS count FROM tasks').get()
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Reply', replyToId: parentId })
    expect(response.status).toBe(status)
    expect(calls).toBe(0)
    expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual(before)
    db.close()
  })

  test.each(['missing', 'cycle', 'missing-ancestor', 'foreign-ancestor', 'running-ancestor', 'invalid-status'] as const)(
    'rejects %s conversation chains without returning partial history', async (scenario) => {
      const { app, databasePath } = setup()
      const agent = await addAgent(app)
      const other = await addAgent(app, { name: 'Other agent' })
      const db = new Database(databasePath)
      const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,createdAt,replyToId) VALUES (?,?,?,?,?,?,?)')
      if (scenario !== 'missing') {
        insert.run('selected', agent.id, 'Selected question', scenario === 'invalid-status' ? 'invalid' : 'failed',
          'Selected partial answer', '2026-01-01', scenario === 'cycle' ? 'selected' : 'ancestor')
      }
      if (scenario === 'foreign-ancestor' || scenario === 'running-ancestor') {
        insert.run('ancestor', scenario === 'foreign-ancestor' ? other.id : agent.id, 'Private ancestor',
          scenario === 'running-ancestor' ? 'running' : 'completed', 'Private answer', '2026-01-01', null)
      }
      const response = await request(app, 'GET', '/api/tasks/selected/conversation')
      expect(response.status).toBe(scenario === 'missing' ? 404 : 409)
      const result = (await response.json()) as ApiResponse<null>
      expect(result.data).toBeNull()
      expect(JSON.stringify(result)).not.toContain('Private ancestor')
      expect(JSON.stringify(result)).not.toContain('Selected partial answer')
      db.close()
    },
  )

  test('rejects oversized conversation IDs', async () => {
    const { app } = setup()
    expect((await request(app, 'GET', `/api/tasks/${'x'.repeat(101)}/conversation`)).status).toBe(400)
  })

  test.each(['', '   ', 1, true, [], {}, 'x'.repeat(101)].map((replyToId) => [replyToId] as const))('rejects malformed reply IDs: %j', async (replyToId) => {
    const { app } = setup()
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Reply', replyToId })
    expect(response.status).toBe(400)
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
  })

  test('accepts the full history limit without truncation and rejects one extra character before insertion', async () => {
    let calls = 0
    let messages: { role: string; content: string }[] = []
    const { app, databasePath } = setup(async (_input, init) => {
      calls++
      const body: { messages: typeof messages } = JSON.parse(String(init?.body))
      messages = body.messages
      return Response.json({ choices: [{ message: { content: 'Complete answer' } }] })
    })
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,createdAt,replyToId) VALUES (?,?,?,?,?,?,?)')
    let parentId: string | null = null
    for (let index = 0; index < 5; index++) {
      const id = crypto.randomUUID()
      insert.run(id, agent.id, String(index).repeat(2000), 'completed', String(index).repeat(100000), '2026-01-01', parentId)
      parentId = id
    }
    await completeTask(app, agent.id, 'q'.repeat(2000), parentId)
    expect(calls).toBe(1)
    expect(messages.slice(1).map((message) => message.content.length)).toEqual([
      2000, 100000, 2000, 100000, 2000, 100000, 2000, 100000, 2000, 100000, 2000,
    ])
    expect(messages.slice(1).reduce((size, message) => size + message.content.length, 0)).toBe(512000)
    const before = db.query('SELECT COUNT(*) AS count FROM tasks').get()
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'q'.repeat(2001), replyToId: parentId })
    expect(response.status).toBe(413)
    expect(calls).toBe(1)
    expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual(before)
    db.close()
  })

  test('counts rendered failed-turn metadata, safe error and partial output at the exact context limit', async () => {
    let calls = 0
    let messages: { role: string; content: string }[] = []
    const { app, databasePath } = setup(async (_input, init) => {
      calls++
      const body: { messages: typeof messages } = JSON.parse(String(init?.body))
      messages = body.messages
      return Response.json({ choices: [{ message: { content: 'Continued' } }] })
    })
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,error,createdAt,replyToId) VALUES (?,?,?,?,?,?,?,?)')
    let parentId: string | null = null
    for (let index = 0; index < 4; index++) {
      const id = `completed-${index}`
      insert.run(id, agent.id, 'q'.repeat(2000), 'completed', 'a'.repeat(100000), '', '2026-01-01', parentId)
      parentId = id
    }
    const error = 'Agen lokal tidak merespons dalam 10 menit. Silakan coba lagi.'
    const failedContent = `Original task\n\n[Application task status: failed]\nThe previous execution failed or was interrupted and did not complete. Any assistant output for this turn is partial, not a completed result.\nStored error (JSON): ${JSON.stringify(error)}\n[/Application task status]`
    const partial = 'p'.repeat(512000 - 408000 - failedContent.length - 'Continue'.length)
    insert.run('failed', agent.id, 'Original task', 'failed', partial, error, '2026-01-01', parentId)
    await completeTask(app, agent.id, 'Continue', 'failed')
    expect(messages.slice(-3)).toEqual([
      { role: 'user', content: failedContent },
      { role: 'assistant', content: partial },
      { role: 'user', content: 'Continue' },
    ])
    expect(messages.slice(1).reduce((size, message) => size + message.content.length, 0)).toBe(512000)
    const before = db.query('SELECT COUNT(*) AS count FROM tasks').get()
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Continue!', replyToId: 'failed' })
    expect(response.status).toBe(413)
    expect(calls).toBe(1)
    expect(db.query('SELECT COUNT(*) AS count FROM tasks').get()).toEqual(before)
    db.close()
  })

  test('persists Todo prompts oldest-first without execution and cascades agent deletion after restart', async () => {
    let calls = 0
    const { app, databasePath, directory } = setup(async () => {
      calls++
      return Response.json({ choices: [{ message: { content: 'Must not run' } }] })
    })
    const agent = await addAgent(app)
    const first = await addTodo(app, agent.id, '  Stored first prompt  ')
    const second = await addTodo(app, agent.id, 'Stored second prompt')
    expect(first).toEqual({ id: expect.any(String), agentId: agent.id, prompt: 'Stored first prompt', createdAt: expect.any(String) })
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([first, second])
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
    expect(calls).toBe(0)
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const saved = await (await request(restarted, 'GET', '/api/todos')).text()
    expect((JSON.parse(saved) as ApiResponse<TodoPrompt[]>).data).toEqual([first, second])
    expect(saved).not.toContain(draft.apiKey)
    expect(saved).not.toContain(draft.baseUrl)
    expect((await request(restarted, 'DELETE', `/api/agents/${agent.id}`)).status).toBe(200)
    expect(((await (await request(restarted, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([])
  })

  test.each(['completed', 'failed'] as const)('starts a saved Todo once with its stored identity and reports %s while retaining busy Todo prompts', async (status) => {
    let calls = 0
    const { promise, resolve: release } = Promise.withResolvers<Response>()
    let messages: { role: string; content: string }[] = []
    const { app } = setup(async (_input, init) => {
      calls++
      const payload: { messages: typeof messages } = JSON.parse(String(init?.body))
      messages = payload.messages
      return promise
    })
    const agent = await addAgent(app)
    const other = await addAgent(app, { name: 'Other agent' })
    const todo = await addTodo(app, agent.id, 'Immutable saved prompt')
    const starts = await Promise.all([
      request(app, 'POST', '/api/tasks', { todoId: todo.id, agentId: other.id, prompt: 'Do not execute this override' }),
      request(app, 'POST', '/api/tasks', { todoId: todo.id }),
    ])
    expect(starts.map((response) => response.status)).toEqual([202, 404])
    const task = ((await starts[0]!.json()) as ApiResponse<Task>).data
    expect(task).toMatchObject({ id: todo.id, agentId: agent.id, prompt: todo.prompt, status: 'running', replyToId: null, autoApprove: false })
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({ role: 'user', content: todo.prompt })
    const next = await addTodo(app, agent.id, 'Keep until agent is free')
    expect((await request(app, 'POST', '/api/tasks', { todoId: next.id })).status).toBe(409)
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([next])
    expect(calls).toBe(1)
    release(status === 'completed'
      ? Response.json({ choices: [{ message: { content: 'Saved task answer' } }] })
      : new Response(`Private upstream error ${draft.apiKey}`, { status: 503 }))
    const settled = await settledTask(app, task.id)
    expect(settled).toMatchObject({ id: todo.id, status, prompt: todo.prompt, autoApprove: false })
    expect(settled.completedAt).not.toBeNull()
    expect(status === 'completed' ? settled.output : settled.error).toContain(status === 'completed' ? 'Saved task answer' : 'gangguan')
    expect(settled.error).not.toContain(draft.apiKey)
    expect((await request(app, 'POST', '/api/tasks', { todoId: todo.id })).status).toBe(404)
    expect(calls).toBe(1)
  })

  test('validates Todo saves with existing body, host and origin boundaries before mutation', async () => {
    const { app } = setup()
    const agent = await addAgent(app)
    for (const value of [null, [], {}, { agentId: agent.id, prompt: '' }, { agentId: agent.id, prompt: 'x'.repeat(12001) }]) {
      expect((await request(app, 'POST', '/api/todos', value)).status).toBe(400)
    }
    expect((await request(app, 'POST', '/api/todos', { agentId: 'missing', prompt: 'Prompt' })).status).toBe(404)
    expect((await request(app, 'POST', '/api/todos', { agentId: agent.id, prompt: 'x'.repeat(33000) })).status).toBe(413)
    expect((await request(app, 'POST', '/api/todos', {}, { 'Content-Type': 'text/plain' })).status).toBe(415)
    const malformed = new Request('http://127.0.0.1:29417/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
    expect((await app.handler(malformed)).status).toBe(400)
    expect((await request(app, 'POST', '/api/todos', { agentId: agent.id, prompt: 'Prompt' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await request(app, 'GET', '/api/todos', undefined, { Host: 'evil.example' })).status).toBe(403)
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([])
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
  })

  test('rolls task insertion back when Todo consumption fails before execution', async () => {
    let calls = 0
    const { app, databasePath } = setup(async () => {
      calls++
      return Response.json({ choices: [{ message: { content: 'Must not run' } }] })
    })
    const agent = await addAgent(app)
    const todo = await addTodo(app, agent.id, 'Retain on insertion failure')
    const db = new Database(databasePath)
    db.exec("CREATE TRIGGER reject_consume BEFORE DELETE ON todos BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    expect((await request(app, 'POST', '/api/tasks', { todoId: todo.id })).status).toBe(500)
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([todo])
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
    expect(calls).toBe(0)
    db.close()
  })

  test('returns immediately and rejects simultaneous tasks and deletion while busy', async () => {
    let release: ((response: Response) => void) | undefined
    let calls = 0
    const { app } = setup(async () => {
      calls++
      return new Promise<Response>((resolve) => { release = resolve })
    })
    const agent = await addAgent(app)
    const first = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Pertama' })
    expect(first.status).toBe(202)
    const firstTask = ((await first.json()) as ApiResponse<Task>).data
    const attempts = await Promise.all([
      request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kedua' }),
      request(app, 'DELETE', `/api/agents/${agent.id}`),
    ])
    expect(attempts.map((response) => response.status)).toEqual([409, 409])
    expect(calls).toBe(1)
    release?.(Response.json({ choices: [{ message: { content: 'Selesai' } }] }))
    expect((await settledTask(app, firstTask.id)).status).toBe('completed')
    expect((await request(app, 'DELETE', `/api/agents/${agent.id}`)).status).toBe(200)
  })

  test.each([
    [401, 'Autentikasi'], [429, 'kuota'], [503, 'gangguan'], [400, 'HTTP 400'],
  ])('stores safe failure for HTTP %i without upstream secrets', async (status, expected) => {
    const { app } = setup(async () => new Response(`secret: ${draft.apiKey}`, { status: Number(status) }))
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan' })
    const task = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(task.status).toBe('failed')
    expect(task.error).toContain(String(expected))
    expect(task.error).not.toContain(draft.apiKey)
    expect(task.output).toBe('')
    expect(task.completedAt).not.toBeNull()
  })

  test('sanitizes transport failures and frees the agent for another task', async () => {
    let fail = true
    const { app } = setup(async () => {
      if (fail) throw new Error(`Connection error with key ${draft.apiKey} at ${draft.baseUrl}`)
      return Response.json({ choices: [{ message: { content: 'Pulih' } }] })
    })
    const agent = await addAgent(app)
    const first = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Pertama' })
    const failed = await settledTask(app, ((await first.json()) as ApiResponse<Task>).data.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).not.toContain(draft.apiKey)
    expect(failed.error).not.toContain(draft.baseUrl)
    fail = false
    const next = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Coba lagi' })
    expect(next.status).toBe(202)
    expect((await settledTask(app, ((await next.json()) as ApiResponse<Task>).data.id)).output).toBe('Pulih')
  })

  test.each(['', '   ', 'x'.repeat(120_001)])('rejects empty and oversized provider output', async (content) => {
    const { app } = setup(async () => Response.json({ choices: [{ message: { content } }] }))
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan' })
    const task = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(task.status).toBe('failed')
    expect(task.output).toBe('')
  })

  test('allows keyless local Ollama, rejects bad drafts, and enforces the default twelve seats', async () => {
    const { app } = setup()
    const invalid: unknown[] = [
      null, [], { ...draft, provider: 'unknown' }, { ...draft, name: '' },
      { ...draft, model: 'x'.repeat(151) }, { ...draft, role: 'x'.repeat(1001) },
      { ...draft, apiKey: '' }, { ...draft, color: '#oops' },
      { ...draft, baseUrl: 'http://external.example/v1' },
      { ...draft, baseUrl: 'https://user:password@example.com/v1' },
      { ...draft, baseUrl: 'https://example.com/v1?key=secret' },
      { ...draft, baseUrl: 'https://example.com/v1#fragment' },
      { ...draft, provider: 'custom', baseUrl: '' },
    ]
    for (const value of invalid) expect((await request(app, 'POST', '/api/agents', value)).status).toBe(400)
    await addAgent(app, { provider: 'ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1' })
    for (let index = 1; index < 12; index++) await addAgent(app, { name: `Agent ${index}` })
    expect((await request(app, 'POST', '/api/agents', draft)).status).toBe(409)
  })

  test('stores a seat count, rejects bad values, never drops below the agent count, and gates new agents by it', async () => {
    const { app, directory, databasePath } = setup()
    const seats = async (method: string, value?: unknown): Promise<{ status: number; seats?: number }> => {
      const response = await request(app, method, '/api/office', value)
      const result = await response.json() as ApiResponse<{ seats: number }>
      return { status: response.status, seats: result.data?.seats }
    }
    expect(await seats('GET')).toEqual({ status: 200, seats: 12 })
    for (const bad of [{ seats: 0 }, { seats: 25 }, { seats: 3.5 }, { seats: '5' }, { seats: null }, {}, null, []]) {
      expect((await seats('PUT', bad)).status).toBe(400)
    }
    expect(await seats('PUT', { seats: 2 })).toEqual({ status: 200, seats: 2 })
    await addAgent(app)
    await addAgent(app, { name: 'Second' })
    expect((await request(app, 'POST', '/api/agents', draft)).status).toBe(409)
    expect((await seats('PUT', { seats: 1 })).status).toBe(409)
    expect(await seats('PUT', { seats: 24 })).toEqual({ status: 200, seats: 24 })
    await addAgent(app, { name: 'Third' })
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const saved = await (await request(restarted, 'GET', '/api/office')).json() as ApiResponse<{ seats: number }>
    expect(saved.data.seats).toBe(24)
  })

  test('stores a chosen character, rejects partial ones, keeps it on update and survives a restart', async () => {
    const { app, directory, databasePath } = setup()
    const look = { skin: 4, hairStyle: 3, hairColor: 5, glasses: true, hood: false }
    const plain = await addAgent(app)
    expect(plain.character).toBeNull()
    for (const bad of [{ ...look, skin: 6 }, { ...look, hairStyle: 5 }, { ...look, hairColor: -1 }, { ...look, skin: 1.5 }, { ...look, glasses: 'yes' }, { skin: 1 }, [], 'x']) {
      expect((await request(app, 'POST', '/api/agents', { ...draft, character: bad })).status).toBe(400)
    }
    const agent = await addAgent(app, { name: 'Styled', character: look })
    expect(agent.character).toEqual(look)
    const renamed = await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, name: 'Renamed', apiKey: '' })
    expect(((await renamed.json()) as ApiResponse<Agent>).data.character).toEqual(look)
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: '', character: { ...look, hairStyle: 9 } })).status).toBe(400)
    const changed = { ...look, hairStyle: 0, glasses: false, hood: true }
    await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: '', character: changed })
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const listed = ((await (await request(restarted, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data
    expect(listed.map((item) => item.character)).toEqual([null, changed])
    const settings = ((await (await request(restarted, 'GET', `/api/agents/${agent.id}`)).json()) as ApiResponse<AgentSettings>).data
    expect(settings.character).toEqual(changed)
    await request(restarted, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: '', character: null })
    const reset = ((await (await request(restarted, 'GET', `/api/agents/${agent.id}`)).json()) as ApiResponse<AgentSettings>).data
    expect(reset.character).toBeNull()
  })

  test('returns the canonical folder chosen in the native dialog and reports cancel, unsupported systems and bad folders', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'picked-folder-'))
    const file = join(folder, 'note.txt')
    writeFileSync(file, 'x')
    const link = join(folder, 'link')
    symlinkSync(folder, link)
    const answers: (string | null | Error)[] = [link, null, new FolderPickerUnavailableError('Pemilih folder tidak tersedia.'), file, join(folder, 'missing')]
    const { app } = setup(undefined, undefined, async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? null
    })
    try {
      const pick = async (): Promise<{ status: number; path?: string | null }> => {
        const response = await request(app, 'POST', '/api/pick-folder', {})
        return { status: response.status, path: ((await response.json()) as ApiResponse<{ path: string | null } | null>).data?.path }
      }
      expect(await pick()).toEqual({ status: 200, path: realpathSync(folder) })
      expect(await pick()).toEqual({ status: 200, path: null })
      expect((await pick()).status).toBe(501)
      expect((await pick()).status).toBe(400)
      expect((await pick()).status).toBe(400)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('opens only one folder dialog at a time and rejects hostile origins', async () => {
    const release = Promise.withResolvers<string | null>()
    const { app, directory } = setup(undefined, undefined, () => release.promise)
    const first = request(app, 'POST', '/api/pick-folder', {})
    await Promise.resolve()
    expect((await request(app, 'POST', '/api/pick-folder', {})).status).toBe(409)
    release.resolve(directory)
    expect((await first).status).toBe(200)
    expect((await request(app, 'POST', '/api/pick-folder', {}, { Origin: 'https://evil.example' })).status).toBe(403)
  })

  test('rejects invalid tasks, oversized bodies, malformed JSON, and non-JSON posts', async () => {
    const { app } = setup()
    const agent = await addAgent(app)
    expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: '' })).status).toBe(400)
    expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'x'.repeat(12001) })).status).toBe(400)
    expect((await request(app, 'POST', '/api/tasks', { agentId: 'missing', prompt: 'Task' })).status).toBe(404)
    expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'x'.repeat(33000) })).status).toBe(413)
    expect((await request(app, 'POST', '/api/tasks', {}, { 'Content-Type': 'text/plain' })).status).toBe(415)
    const invalid = new Request('http://localhost:29417/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })
    expect((await app.handler(invalid)).status).toBe(400)
  })

  test('rejects hostile origins and hosts and does not expose server files', async () => {
    const { app } = setup()
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', 'http://localhost:5173/path']) {
      expect((await request(app, 'GET', '/api/agents', undefined, { Origin: origin })).status).toBe(403)
    }
    expect((await request(app, 'GET', '/api/health', undefined, { Host: 'evil.example:29417' })).status).toBe(403)
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:29417']) {
      const response = await request(app, 'GET', '/api/health', undefined, { Origin: origin })
      expect(response.status).toBe(200)
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
    }
    for (const path of ['/server.ts', '/data/office.sqlite', '/.env', '/%2e%2e%2fserver.ts', '/src/types.ts']) {
      expect((await request(app, 'GET', path)).status).toBe(404)
    }
  })

  test('marks interrupted tasks failed on close and on startup', async () => {
    const { app, databasePath, directory } = setup(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Long task' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const stopped = await settledTask(restarted, initial.id)
    expect(stopped.status).toBe('failed')
    expect(stopped.completedAt).not.toBeNull()
    restarted.close()
    const db = new Database(databasePath)
    db.query("UPDATE tasks SET status = 'running', completedAt = NULL, error = '' WHERE id = ?").run(initial.id)
    db.close()
    const recovered = createApp({ databasePath })
    fixtures.push({ app: recovered, directory })
    const task = await settledTask(recovered, initial.id)
    expect(task.status).toBe('failed')
    expect(task.error).toContain('dimulai ulang')
    expect(task.completedAt).not.toBeNull()
  })

  test('keeps running work visible even beyond the latest one hundred tasks', async () => {
    const { app, databasePath } = setup()
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,createdAt) VALUES (?,?,?,?,?)')
    for (let index = 0; index < 102; index++) {
      insert.run(`task-${index}`, agent.id, `Prompt ${index}`, 'completed', new Date(2026, 0, 1, 0, 0, index).toISOString())
    }
    insert.run('still-running', agent.id, 'Older active task', 'running', new Date(2025, 0, 1).toISOString())
    db.close()
    const tasks = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    expect(tasks).toHaveLength(101)
    expect(tasks[0]?.id).toBe('task-101')
    expect(tasks[99]?.id).toBe('task-2')
    expect(tasks[100]?.id).toBe('still-running')
  })
})

describe('local agent API', () => {
  test.each(['omp', 'hermes', 'codex', 'antigravity', 'claude'] as const)('edits %s settings with creation safeguards and clears credentials across local transitions', async (provider) => {
    setRuntimeCommand(provider, process.execPath)
    let captured: Agent | undefined
    const { app, databasePath, directory } = setup(undefined, async ({ agent }) => {
      captured = agent
      return 'Local result'
    })
    const agent = await addAgent(app)
    const db = new Database(databasePath)
    const original = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)
    const local = { ...draft, provider, model: '', workspace: directory, allowTools: true }
    for (const changes of [
      { allowTools: false }, { allowTools: undefined }, { allowTools: 'true' }, { allowTools: 1 },
      { workspace: '' }, { workspace: '.' }, { workspace: join(directory, 'missing') },
      { workspace: databasePath }, { model: 'x'.repeat(151) },
    ]) {
      expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...local, ...changes })).status).toBe(400)
      expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(original)
    }
    setRuntimeCommand(provider, join(directory, 'missing-runtime'))
    const home = process.env.HOME
    try {
      process.env.HOME = directory
      expect((await request(app, 'PUT', `/api/agents/${agent.id}`, local)).status).toBe(503)
    } finally {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
    expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(original)
    setRuntimeCommand(provider, process.execPath)
    const response = await request(app, 'PUT', `/api/agents/${agent.id}`, local)
    expect(response.status).toBe(200)
    const converted = ((await response.json()) as ApiResponse<Agent>).data
    expect(converted).toEqual({ ...agent, provider, model: '', workspace: realpathSync(directory), allowTools: true })
    expect(db.query('SELECT apiKey, baseUrl FROM agents WHERE id = ?').get(agent.id)).toEqual({ apiKey: '', baseUrl: '' })
    expect(((await (await request(app, 'GET', `/api/agents/${agent.id}`)).json()) as ApiResponse<AgentSettings>).data)
      .toEqual({ ...converted, baseUrl: '', hasApiKey: false })
    const workspace = mkdtempSync(join(directory, 'workspace-'))
    const alias = join(directory, 'workspace-link')
    symlinkSync(workspace, alias)
    const editedLocal = { ...local, name: 'Edited local', role: 'New local role', model: 'local-model', color: '#abcdef', workspace: alias }
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, editedLocal)).status).toBe(200)
    const task = await completeTask(app, agent.id, 'Use edited local settings')
    expect(captured).toMatchObject({
      id: agent.id, createdAt: agent.createdAt, name: editedLocal.name, role: editedLocal.role,
      model: editedLocal.model, color: editedLocal.color, workspace: realpathSync(workspace), allowTools: true,
    })
    const beforeReturn = db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: '' })).status).toBe(400)
    expect(db.query('SELECT * FROM agents WHERE id = ?').get(agent.id)).toEqual(beforeReturn)
    expect((await request(app, 'PUT', `/api/agents/${agent.id}`, { ...draft, apiKey: 'fresh-api-key', workspace: alias, allowTools: true })).status).toBe(200)
    expect(db.query('SELECT apiKey, baseUrl, workspace, allowTools FROM agents WHERE id = ?').get(agent.id))
      .toEqual({ apiKey: 'fresh-api-key', baseUrl: draft.baseUrl, workspace: '', allowTools: 0 })
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([task])
    db.close()
  })

  test.each(['omp', 'hermes'] as const)('persists %s workspace and explicit tools consent without credentials', async (provider) => {
    setRuntimeCommand(provider, process.execPath)
    const { app, databasePath, directory } = setup()
    const alias = join(directory, 'workspace-link')
    symlinkSync(directory, alias)
    const agent = await addAgent(app, {
      provider, model: '', workspace: alias, allowTools: true,
      apiKey: '', baseUrl: '',
    })
    expect(agent.workspace).toBe(realpathSync(directory))
    expect(agent.allowTools).toBe(true)
    expect(agent.model).toBe('')
    expect(agent).not.toHaveProperty('apiKey')
    const db = new Database(databasePath)
    expect(db.query('SELECT apiKey, baseUrl, allowTools FROM agents WHERE id = ?').get(agent.id))
      .toEqual({ apiKey: '', baseUrl: '', allowTools: 1 })
    db.close()
    app.close()
    const restarted = createApp({ databasePath })
    fixtures.push({ app: restarted, directory })
    const saved = ((await (await request(restarted, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data
    expect(saved).toEqual([agent])
    const status = ((await (await request(restarted, 'GET', '/api/runtimes')).json()) as ApiResponse<RuntimeStatus>).data
    expect(status.workspace).toBe(process.cwd())
    expect(status.runtimes.find((runtime) => runtime.provider === provider)?.available).toBe(true)
  })

  test('validates local workspace and strict consent while ignoring local-only fields for API agents', async () => {
    setRuntimeCommand('omp', process.execPath)
    const { app, databasePath, directory } = setup()
    const local = { ...draft, provider: 'omp', model: '', workspace: directory, allowTools: true }
    for (const changes of [
      { allowTools: false }, { allowTools: undefined }, { allowTools: 'true' }, { allowTools: 1 },
      { workspace: '' }, { workspace: '.' }, { workspace: join(directory, 'missing') },
      { workspace: databasePath }, { model: 'x'.repeat(151) },
    ]) {
      const response = await request(app, 'POST', '/api/agents', { ...local, ...changes })
      expect(response.status).toBe(400)
      expect(((await response.json()) as ApiResponse<null>).message).not.toBe('')
    }
    const agent = await addAgent(app, { workspace: 'not-an-absolute-directory', allowTools: true })
    expect(agent.workspace).toBe('')
    expect(agent.allowTools).toBe(false)
    expect(((await (await request(app, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data).toEqual([agent])
  })

  test('rejects unavailable runtimes before creating agents or tasks', async () => {
    let calls = 0
    const { app, directory } = setup(undefined, async () => {
      calls++
      return 'Tidak boleh dijalankan'
    })
    const missing = join(directory, 'missing-runtime')
    setRuntimeCommand('omp', missing)
    const unavailable = await request(app, 'POST', '/api/agents', {
      ...draft, provider: 'omp', model: '', workspace: directory, allowTools: true,
    })
    expect(unavailable.status).toBe(503)
    expect(((await unavailable.json()) as ApiResponse<null>).message).toContain('OMP')
    setRuntimeCommand('omp', process.execPath)
    const agent = await addAgent(app, { provider: 'omp', model: '', workspace: directory, allowTools: true })
    setRuntimeCommand('omp', missing)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan' })
    expect(response.status).toBe(503)
    expect(calls).toBe(0)
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
    const status = ((await (await request(app, 'GET', '/api/runtimes')).json()) as ApiResponse<RuntimeStatus>).data
    expect(status.runtimes.find((runtime) => runtime.provider === 'omp')?.available).toBe(false)
  })

  test('retains Todo prompts for invalid options or unavailable runtime and starts with manual permissions only', async () => {
    setRuntimeCommand('omp', process.execPath)
    let calls = 0
    const decisions: (string | null)[] = []
    const permission: TaskPermission = {
      requestId: 'todo-permission', title: 'Tulis hasil?', details: 'Permintaan menulis di workspace.',
      options: [{ id: 'allow_once', label: 'Izinkan sekali' }, { id: 'reject_once', label: 'Tolak' }],
    }
    const { app, directory } = setup(undefined, async (options) => {
      calls++
      expect(options.prompt).toBe('Stored local prompt')
      expect(options.history).toEqual([])
      decisions.push(await options.onPermission(permission, [join(options.agent.workspace, 'result.txt')]))
      return 'Manual permission handled'
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    setRuntimeCommand('omp', join(directory, 'missing-runtime'))
    const todo = await addTodo(app, agent.id, 'Stored local prompt')
    expect((await request(app, 'POST', '/api/tasks', { todoId: todo.id })).status).toBe(503)
    setRuntimeCommand('omp', process.execPath)
    for (const options of [
      { autoApprove: true }, { autoApprove: 'true' }, { autoApprove: 1 }, { autoApprove: null },
      { replyToId: 'any-task' }, { replyToId: '' },
    ]) {
      expect((await request(app, 'POST', '/api/tasks', { todoId: todo.id, ...options })).status).toBe(400)
    }
    for (const todoId of [null, '', 1]) {
      expect((await request(app, 'POST', '/api/tasks', { todoId })).status).toBe(400)
    }
    expect((await request(app, 'POST', '/api/tasks', { todoId: 'missing' })).status).toBe(404)
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([todo])
    expect(((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual([])
    expect(calls).toBe(0)
    const response = await request(app, 'POST', '/api/tasks', { todoId: todo.id, autoApprove: false })
    expect(response.status).toBe(202)
    const pending = ((await response.json()) as ApiResponse<Task>).data
    expect(pending).toMatchObject({ id: todo.id, status: 'running', autoApprove: false, permission: { title: permission.title } })
    expect(decisions).toEqual([])
    expect((await request(app, 'POST', `/api/tasks/${todo.id}/permission`, {
      requestId: pending.permission!.requestId, optionId: 'reject_once',
    })).status).toBe(200)
    expect(await settledTask(app, todo.id)).toMatchObject({ status: 'completed', output: 'Manual permission handled', autoApprove: false })
    expect(decisions).toEqual(['reject_once'])
    expect(calls).toBe(1)
    expect(((await (await request(app, 'GET', '/api/todos')).json()) as ApiResponse<TodoPrompt[]>).data).toEqual([])
  })

  test('adds missing SQLite metadata columns without changing existing credentials or task history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'virtual-office-legacy-'))
    const databasePath = join(directory, 'office.sqlite')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, color TEXT NOT NULL, createdAt TEXT NOT NULL,
        apiKey TEXT NOT NULL, baseUrl TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, completedAt TEXT
      );
    `)
    legacy.query('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?)')
      .run('legacy-agent', draft.name, draft.role, draft.provider, draft.model, draft.color, '2026-01-01', draft.apiKey, draft.baseUrl)
    legacy.query('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)')
      .run('legacy-task', 'legacy-agent', 'Instruksi tersimpan', 'completed', 'Jawaban tersimpan', '', '2026-01-01', '2026-01-02')
    legacy.close()
    const app = createApp({ databasePath })
    fixtures.push({ app, directory })
    const agents = ((await (await request(app, 'GET', '/api/agents')).json()) as ApiResponse<Agent[]>).data
    expect(agents[0]).toMatchObject({ id: 'legacy-agent', workspace: '', allowTools: false })
    const tasks = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    expect(tasks[0]).toMatchObject({
      id: 'legacy-task', status: 'completed', prompt: 'Instruksi tersimpan', output: 'Jawaban tersimpan',
      activity: '', permission: null, completedAt: '2026-01-02', replyToId: null,
    })
    app.close()
    let messages: { role: string; content: string }[] = []
    const restarted = createApp({ databasePath, fetch: async (_input, init) => {
      const body: { messages: typeof messages } = JSON.parse(String(init?.body))
      messages = body.messages
      return Response.json({ choices: [{ message: { content: 'Legacy reply completed' } }] })
    } })
    fixtures.push({ app: restarted, directory })
    expect(((await (await request(restarted, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data).toEqual(tasks)
    const db = new Database(databasePath)
    expect(db.query('SELECT apiKey, baseUrl FROM agents WHERE id = ?').get('legacy-agent'))
      .toEqual({ apiKey: draft.apiKey, baseUrl: draft.baseUrl })
    expect(db.query<{ name: string }, []>('PRAGMA table_info(agents)').all()
      .filter((column) => column.name === 'workspace' || column.name === 'allowTools')).toHaveLength(2)
    db.close()
    const reply = await completeTask(restarted, 'legacy-agent', 'Balas instruksi lama', 'legacy-task')
    expect(reply.replyToId).toBe('legacy-task')
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Instruksi tersimpan' },
      { role: 'assistant', content: 'Jawaban tersimpan' },
      { role: 'user', content: 'Balas instruksi lama' },
    ])
  })

  test.each(['omp', 'hermes'] as const)('dispatches %s tasks to the local runner instead of HTTP', async (provider) => {
    setRuntimeCommand(provider, process.execPath)
    let capturedAgent: Agent | undefined
    let capturedPrompt = ''
    let capturedSignal: AbortSignal | undefined
    const { app, directory } = setup(undefined, async ({ agent, prompt, signal }) => {
      capturedAgent = agent
      capturedPrompt = prompt
      capturedSignal = signal
      return 'Perubahan lokal selesai.'
    })
    const agent = await addAgent(app, { provider, model: '', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tinjau proyek lokal.' })
    expect(response.status).toBe(202)
    const task = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(task.status).toBe('completed')
    expect(task.output).toBe('Perubahan lokal selesai.')
    expect(task.activity).toBe('')
    expect(task.permission).toBeNull()
    expect(capturedAgent).toMatchObject(agent)
    expect(capturedAgent?.allowTools).toBe(true)
    expect(capturedPrompt).toBe('Tinjau proyek lokal.')
    expect(capturedSignal?.aborted).toBe(false)
  })

  test('local replies remember their selected branch but new tasks cannot recall another task or agent', async () => {
    setRuntimeCommand('omp', process.execPath)
    const { app, directory } = setup(undefined, async ({ history, prompt }) => {
      let code = 'UNKNOWN'
      for (const message of [...history, { role: 'user', content: prompt }]) {
        if (message.role !== 'user') continue
        const remembered = message.content.match(/^Remember code ([A-Z]+)\.$/)
        if (remembered) code = remembered[1]!
      }
      return prompt.startsWith('Remember code ') ? 'Remembered.' : code
    })
    const agent = await addAgent(app, { provider: 'omp', model: '', workspace: directory, allowTools: true })
    const other = await addAgent(app, { provider: 'omp', model: '', name: 'Other local agent', workspace: directory, allowTools: true })
    const root = await completeTask(app, agent.id, 'Remember code ORCHID.')
    await completeTask(app, agent.id, 'Remember code SIBLING.', root.id)
    await completeTask(app, agent.id, 'Remember code UNRELATED.')
    await completeTask(app, other.id, 'Remember code FOREIGN.')
    const parent = await completeTask(app, agent.id, 'What is the code?', root.id)
    expect(parent.output).toBe('ORCHID')
    expect((await completeTask(app, agent.id, 'What is the code again?', parent.id)).output).toBe('ORCHID')
    expect((await completeTask(app, agent.id, 'What is the code?')).output).toBe('UNKNOWN')
    expect((await completeTask(app, agent.id, 'What is the code?', null)).output).toBe('UNKNOWN')
  })

  test.each(['', 'Inspected src/index.ts; implementation is unfinished.'])(
    'local continuation restores original task and partial output %j without unrelated branches after restart', async (partial) => {
      setRuntimeCommand('omp', process.execPath)
      const error = 'Agen lokal tidak merespons dalam 10 menit. Silakan coba lagi.'
      let captured: { role: string; content: string }[] = []
      const runLocal: NonNullable<AppOptions['runLocal']> = async ({ history, prompt, onOutput }) => {
        if (prompt === 'Implement original task token ORCHID') {
          if (partial) onOutput(partial)
          throw new LocalAgentError(error)
        }
        if (prompt === 'Lanjutkan') {
          captured = history
          const original = history.find((message) => message.role === 'user' && message.content.startsWith('Implement original task token '))
          const token = original?.content.match(/original task token ([A-Z]+)/)?.[1] || 'UNKNOWN'
          const available = history.find((message) => message.role === 'assistant' && message.content === partial)?.content || 'NO_PARTIAL'
          return `${token}|${available}`
        }
        return `Saved: ${prompt}`
      }
      const { app, directory, databasePath } = setup(undefined, runLocal)
      const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
      const other = await addAgent(app, { provider: 'omp', name: 'Other local agent', workspace: directory, allowTools: true })
      const root = await completeTask(app, agent.id, 'Project root context')
      await completeTask(app, agent.id, 'Private sibling context', root.id)
      await completeTask(app, agent.id, 'Private independent context')
      await completeTask(app, other.id, 'Private foreign context')
      const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Implement original task token ORCHID', replyToId: root.id })
      const failed = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
      expect(failed).toMatchObject({ status: 'failed', output: partial, error, replyToId: root.id })
      const db = new Database(databasePath)
      const insert = db.query('INSERT INTO tasks (id,agentId,prompt,status,output,createdAt) VALUES (?,?,?,?,?,?)')
      for (let index = 0; index < 101; index++) {
        insert.run(`unrelated-${index}`, agent.id, `Unrelated prompt ${index}`, 'completed', `Unrelated answer ${index}`, '9999-01-01')
      }
      db.close()
      app.close()
      const restarted = createApp({ databasePath, runLocal })
      fixtures.push({ app: restarted, directory })
      const visible = ((await (await request(restarted, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
      expect(visible.some((task) => task.id === root.id || task.id === failed.id)).toBe(false)
      const saved = await request(restarted, 'GET', `/api/tasks/${failed.id}/conversation`)
      expect(saved.status).toBe(200)
      expect(((await saved.json()) as ApiResponse<Task[]>).data).toEqual([root, failed])
      const pending = await request(restarted, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Lanjutkan', replyToId: failed.id })
      expect(pending.status).toBe(202)
      const replyId = ((await pending.json()) as ApiResponse<Task>).data.id
      const continued = await request(restarted, 'GET', `/api/tasks/${replyId}/conversation`)
      expect(continued.status).toBe(200)
      const chain = ((await continued.json()) as ApiResponse<Task[]>).data
      expect(chain.slice(0, -1)).toEqual([root, failed])
      expect(chain.at(-1)).toMatchObject({ id: replyId, status: 'completed', output: `ORCHID|${partial || 'NO_PARTIAL'}` })
      expect(captured).toEqual([
        { role: 'user', content: root.prompt },
        { role: 'assistant', content: root.output },
        {
          role: 'user',
          content: `${failed.prompt}\n\n[Application task status: failed]\nThe previous execution failed or was interrupted and did not complete. Any assistant output for this turn is partial, not a completed result.\nStored error (JSON): ${JSON.stringify(error)}\n[/Application task status]`,
        },
        ...(partial ? [{ role: 'assistant', content: partial }] : []),
      ])
      const again = await request(restarted, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Lanjutkan', replyToId: replyId })
      expect(again.status).toBe(202)
      const againId = ((await again.json()) as ApiResponse<Task>).data.id
      const repeated = ((await (await request(restarted, 'GET', `/api/tasks/${againId}/conversation`)).json()) as ApiResponse<Task[]>).data
      expect(repeated.slice(0, -1)).toEqual(chain)
      expect(repeated.at(-1)).toMatchObject({ status: 'completed', output: `ORCHID|${partial || 'NO_PARTIAL'}` })
      const independent = await request(restarted, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Lanjutkan', replyToId: null })
      expect(independent.status).toBe(202)
      const independentId = ((await independent.json()) as ApiResponse<Task>).data.id
      const isolated = ((await (await request(restarted, 'GET', `/api/tasks/${independentId}/conversation`)).json()) as ApiResponse<Task[]>).data
      expect(isolated).toHaveLength(1)
      expect(isolated[0]).toMatchObject({ output: 'UNKNOWN|NO_PARTIAL', replyToId: null })
      expect(captured).toEqual([])
    },
  )

  test('local progress extends work beyond ten minutes without retaining timers after completion', async () => {
    setRuntimeCommand('omp', process.execPath)
    const clock = taskClock()
    const finish = Promise.withResolvers<string>()
    let runtime!: LocalRunOptions
    const { app, directory } = setup(undefined, async (options) => {
      runtime = options
      options.signal.addEventListener('abort', () => finish.reject(new Error('aborted')), { once: true })
      return finish.promise
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan lama' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    for (const progress of [
      () => runtime.onOutput('Hasil sebagian.'),
      () => runtime.onActivity('Membaca proyek.'),
      () => runtime.onProgress(),
    ]) {
      await clock.advance(599_998)
      progress()
      await clock.advance(1)
      expect(runtime.signal.aborted).toBe(false)
      expect(clock.pending()).toBe(1)
    }
    finish.resolve('Selesai setelah lebih dari 20 menit.')
    expect((await settledTask(app, initial.id)).status).toBe('completed')
    expect(clock.pending()).toBe(0)
    runtime.onProgress()
    runtime.onOutput('Terlambat.')
    runtime.onActivity('Terlambat.')
    expect(clock.pending()).toBe(0)
    await clock.advance(1_200_000)
    expect(runtime.signal.aborted).toBe(false)
  })

  test('local inactivity starts at latest progress, ignores polling and retains partial output', async () => {
    setRuntimeCommand('omp', process.execPath)
    const clock = taskClock()
    let runtime!: LocalRunOptions
    const { app, directory } = setup(undefined, async (options) => {
      runtime = options
      return new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private timeout diagnostic')), { once: true })
      })
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    await clock.advance(599_999)
    runtime.onOutput('Hasil sebagian terakhir.')
    await clock.advance(599_999)
    expect(runtime.signal.aborted).toBe(false)
    await request(app, 'GET', '/api/tasks')
    await request(app, 'GET', `/api/tasks/${initial.id}/conversation`)
    runtime.onOutput('Hasil sebagian terakhir.')
    await clock.advance(1)
    expect(runtime.signal.aborted).toBe(true)
    const stopped = await settledTask(app, initial.id)
    expect(stopped).toMatchObject({ status: 'failed', output: 'Hasil sebagian terakhir.', activity: '', permission: null })
    expect(stopped.error).toContain('tidak menunjukkan aktivitas selama 10 menit')
    expect(stopped.error).not.toContain('private')
    runtime.onProgress()
    expect(clock.pending()).toBe(0)
  })

  test.each(['allow_once', null])('manual permission %j pauses inactivity and restarts a full interval on answer', async (optionId) => {
    setRuntimeCommand('omp', process.execPath)
    const clock = taskClock()
    let runtime!: LocalRunOptions
    const answered = Promise.withResolvers<void>()
    const { app, directory } = setup(undefined, async (options) => {
      runtime = options
      options.onOutput('Tinjauan sebelum izin.')
      const decision = await options.onPermission({
        requestId: 'private', title: 'Akses tool?', details: 'Menunggu pengguna.',
        options: [{ id: 'allow_once', label: 'Izinkan sekali' }],
      })
      expect(decision).toBe(optionId)
      answered.resolve()
      return new Promise<string>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tunggu izin' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(clock.pending()).toBe(0)
    runtime.onProgress()
    runtime.onActivity('Masih menunggu.')
    await clock.advance(1_800_000)
    expect(runtime.signal.aborted).toBe(false)
    expect(clock.pending()).toBe(0)
    expect((await request(app, 'POST', `/api/tasks/${initial.id}/permission`, {
      requestId: initial.permission!.requestId, optionId,
    })).status).toBe(200)
    await answered.promise
    expect(clock.pending()).toBe(1)
    await clock.advance(599_999)
    expect(runtime.signal.aborted).toBe(false)
    await clock.advance(1)
    const stopped = await settledTask(app, initial.id)
    expect(stopped).toMatchObject({ status: 'failed', output: 'Tinjauan sebelum izin.', permission: null })
    expect(stopped.error).toContain('tidak menunjukkan aktivitas')
    expect(clock.pending()).toBe(0)
  })

  test.each(['cancel', 'close'])('%s never rearms inactivity from pending permission or late runtime callbacks', async (action) => {
    setRuntimeCommand('omp', process.execPath)
    const clock = taskClock()
    let runtime!: LocalRunOptions
    const exited = Promise.withResolvers<void>()
    const { app, directory } = setup(undefined, async (options) => {
      runtime = options
      try {
        expect(await options.onPermission({ requestId: 'private', title: 'Izin?', details: '', options: [] })).toBeNull()
        options.onProgress()
        options.onOutput('Terlambat.')
        options.onActivity('Terlambat.')
        expect(await options.onPermission({ requestId: 'late', title: 'Izin?', details: '', options: [] })).toBeNull()
        throw new Error('aborted')
      } finally {
        exited.resolve()
      }
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tunggu' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    if (action === 'close') app.close()
    else expect((await request(app, 'POST', `/api/tasks/${initial.id}/cancel`)).status).toBe(200)
    await exited.promise
    expect(runtime.signal.aborted).toBe(true)
    expect(clock.pending()).toBe(0)
    await clock.advance(1_800_000)
    expect(clock.pending()).toBe(0)
    if (action === 'cancel') expect((await settledTask(app, initial.id)).status).toBe('failed')
  })

  test('HTTP keeps its fixed 120 second timeout', async () => {
    const clock = taskClock()
    const { app } = setup(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const agent = await addAgent(app)
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'HTTP' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    await clock.advance(119_999)
    expect(clock.pending()).toBe(1)
    await clock.advance(1)
    expect((await settledTask(app, initial.id)).error).toContain('120 detik')
    expect(clock.pending()).toBe(0)
  })

  test('automatic approval handles repeated requests but is not inherited by a reply', async () => {
    setRuntimeCommand('omp', process.execPath)
    const decisions: (string | null)[] = []
    const permission: TaskPermission = {
      requestId: 'runtime-id', title: 'Tulis hasil?', details: 'Menulis hasil di workspace.',
      options: [{ id: 'allow_once', label: 'Izinkan sekali' }, { id: 'reject_once', label: 'Tolak' }],
    }
    const { app, directory } = setup(undefined, async (options) => {
      for (let index = 0; index < 2; index++) {
        const target = join(options.agent.workspace, index === 0 ? 'approved-0' : 'new/nested/approved-1')
        const decision = await options.onPermission(permission, [index === 0 ? target : 'new/nested/approved-1'])
        decisions.push(decision)
        if (decision !== 'allow_once') return 'Penulisan ditolak.'
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'approved')
      }
      return 'Dua penulisan selesai.'
    })
    await Bun.write(join(directory, 'approved-0'), 'existing')
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tulis hasil', autoApprove: true })
    expect(response.status).toBe(202)
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial.autoApprove).toBe(true)
    const completed = await settledTask(app, initial.id)
    expect(completed).toMatchObject({ status: 'completed', output: 'Dua penulisan selesai.', autoApprove: false, permission: null })
    expect(decisions).toEqual(['allow_once', 'allow_once'])
    expect(await Bun.file(join(directory, 'approved-0')).text()).toBe('approved')
    expect(await Bun.file(join(directory, 'new/nested/approved-1')).text()).toBe('approved')
    const reply = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Lanjutkan', replyToId: completed.id })
    const pending = ((await reply.json()) as ApiResponse<Task>).data
    expect(pending.autoApprove).toBe(false)
    expect(pending.permission?.title).toBe(permission.title)
    await request(app, 'POST', `/api/tasks/${pending.id}/permission`, { requestId: pending.permission!.requestId, optionId: null })
    expect((await settledTask(app, pending.id)).output).toBe('Penulisan ditolak.')
    expect(decisions).toEqual(['allow_once', 'allow_once', null])
  })

  test.each([
    'outside', 'adjacent-prefix', 'outside-symlink-inside', 'traversal', 'symlink-traversal',
    'file-symlink', 'parent-symlink', 'symlink-reentry', 'dangling-symlink', 'dangling-parent', 'symlink-cycle',
    'mixed', 'unknown', 'empty', 'blank', 'nul', 'directory', 'non-directory-parent',
  ])('automatic approval keeps %s targets pending until manual denial', async (scenario) => {
    setRuntimeCommand('omp', process.execPath)
    let targets: readonly string[] | undefined
    let decision: string | null | undefined
    let executed = false
    const permission: TaskPermission = {
      requestId: 'runtime-id', title: 'Akses berkas?', details: 'Tinjau akses sebelum menjalankan tool.',
      options: [{ id: 'allow_once', label: 'Izinkan sekali' }, { id: 'reject_once', label: 'Tolak' }],
    }
    const { app, directory } = setup(undefined, async (options) => {
      decision = await options.onPermission(permission, targets)
      if (decision === 'allow_once') {
        executed = true
        await Bun.write(join(directory, 'outside.txt'), 'changed')
      }
      return decision === 'allow_once' ? 'Diizinkan.' : 'Ditolak.'
    })
    const workspace = realpathSync(mkdtempSync(join(directory, 'workspace-')))
    const outside = join(realpathSync(directory), 'outside.txt')
    await Bun.write(outside, 'untouched')
    await Bun.write(join(workspace, 'inside.txt'), 'inside')
    symlinkSync(outside, join(workspace, 'outside-link'))
    symlinkSync(realpathSync(directory), join(workspace, 'outside-directory'))
    symlinkSync(join(realpathSync(directory), 'missing'), join(workspace, 'dangling'))
    symlinkSync('cycle', join(workspace, 'cycle'))
    symlinkSync(join(workspace, 'inside.txt'), join(realpathSync(directory), 'inside-link'))
    const adjacent = `${workspace}-adjacent`
    mkdirSync(adjacent)
    const cases: Record<string, readonly string[] | undefined> = {
      outside: [outside],
      'adjacent-prefix': [join(adjacent, 'outside.txt')],
      'outside-symlink-inside': [join(realpathSync(directory), 'inside-link')],
      traversal: ['new/../inside.txt'],
      'symlink-traversal': ['outside-directory/../inside.txt'],
      'file-symlink': [join(workspace, 'outside-link')],
      'parent-symlink': [join(workspace, 'outside-directory', 'new', 'outside.txt')],
      'symlink-reentry': [join(workspace, 'outside-directory', basename(workspace), 'inside.txt')],
      'dangling-symlink': [join(workspace, 'dangling')],
      'dangling-parent': [join(workspace, 'dangling', 'new.txt')],
      'symlink-cycle': [join(workspace, 'cycle')],
      mixed: [join(workspace, 'inside.txt'), outside],
      unknown: undefined,
      empty: [],
      blank: [''],
      nul: [`${workspace}/bad\0path`],
      directory: [workspace],
      'non-directory-parent': [join(workspace, 'inside.txt', 'new.txt')],
    }
    targets = cases[scenario]
    const agent = await addAgent(app, { provider: 'omp', workspace, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Periksa akses', autoApprove: true })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial).toMatchObject({ status: 'running', autoApprove: true, permission: { title: permission.title } })
    expect(initial.permission).not.toHaveProperty('filePaths')
    const pending = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data[0]!
    expect(pending.permission?.requestId).toBe(initial.permission!.requestId)
    expect(decision).toBeUndefined()
    expect(executed).toBe(false)
    expect(await Bun.file(outside).text()).toBe('untouched')
    const rejected = await request(app, 'POST', `/api/tasks/${initial.id}/permission`, {
      requestId: initial.permission!.requestId, optionId: 'reject_once',
    })
    expect(rejected.status).toBe(200)
    expect(await settledTask(app, initial.id)).toMatchObject({ status: 'completed', output: 'Ditolak.', autoApprove: false, permission: null })
    expect(decision).toBe('reject_once')
    expect(executed).toBe(false)
    expect(await Bun.file(outside).text()).toBe('untouched')
  })

  test('explicit manual approval can execute an outside write on an automatic task', async () => {
    setRuntimeCommand('omp', process.execPath)
    let outside = ''
    const { app, directory } = setup(undefined, async (options) => {
      const decision = await options.onPermission({
        requestId: 'runtime-id', title: 'Tulis di luar workspace?', details: outside,
        options: [{ id: 'allow_once', label: 'Izinkan sekali' }, { id: 'reject_once', label: 'Tolak' }],
      }, [outside])
      if (decision === 'allow_once') await Bun.write(outside, 'manually approved')
      return decision === 'allow_once' ? 'Ditulis.' : 'Ditolak.'
    })
    outside = join(realpathSync(directory), 'outside.txt')
    await Bun.write(outside, 'untouched')
    const workspace = mkdtempSync(join(directory, 'workspace-'))
    const agent = await addAgent(app, { provider: 'omp', workspace, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tulis hasil', autoApprove: true })
    const pending = ((await response.json()) as ApiResponse<Task>).data
    expect(pending.permission?.title).toBe('Tulis di luar workspace?')
    expect(await Bun.file(outside).text()).toBe('untouched')
    expect((await request(app, 'POST', `/api/tasks/${pending.id}/permission`, {
      requestId: pending.permission!.requestId, optionId: 'allow_once',
    })).status).toBe(200)
    expect(await settledTask(app, pending.id)).toMatchObject({ status: 'completed', output: 'Ditulis.', permission: null, autoApprove: false })
    expect(await Bun.file(outside).text()).toBe('manually approved')
  })

  test('automatic approval cannot approve a reject-only request or a late request after cancellation', async () => {
    setRuntimeCommand('omp', process.execPath)
    const decisions: (string | null)[] = []
    const { app, directory } = setup(undefined, async (options) => {
      decisions.push(await options.onPermission({
        requestId: 'truncated', title: 'Detail terlalu panjang', details: 'Hanya penolakan tersedia.',
        options: [{ id: 'reject_once', label: 'Tolak' }],
      }, [join(options.agent.workspace, 'reject-only.txt')]))
      decisions.push(await options.onPermission({
        requestId: 'late', title: 'Permintaan terlambat', details: '',
        options: [{ id: 'allow_once', label: 'Izinkan sekali' }],
      }, [join(options.agent.workspace, 'late.txt')]))
      return 'Tidak dieksekusi.'
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Periksa izin', autoApprove: true })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial.permission?.options).toEqual([{ id: 'reject_once', label: 'Tolak' }])
    const visible = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data[0]!
    expect(visible.autoApprove).toBe(true)
    expect(visible.permission?.requestId).toBe(initial.permission?.requestId)
    expect(decisions).toEqual([])
    await request(app, 'POST', `/api/tasks/${initial.id}/cancel`)
    const stopped = await settledTask(app, initial.id)
    expect(stopped).toMatchObject({ status: 'failed', autoApprove: false, permission: null })
    expect(decisions).toEqual([null, null])
  })

  test('automatic approval rejects malformed values and non-local providers before creating a task', async () => {
    const { app } = setup()
    const agent = await addAgent(app)
    for (const autoApprove of [true, 'true', 1, null, {}]) {
      expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Task', autoApprove })).status).toBe(400)
    }
    const tasks = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    expect(tasks).toEqual([])
  })

  test('publishes partial output and activity and resolves each manual permission only once', async () => {
    setRuntimeCommand('omp', process.execPath)
    const firstAnswered = Promise.withResolvers<void>()
    const secondAnswered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const decisions: (string | null)[] = []
    const permission: TaskPermission = {
      requestId: 'private-protocol-id', title: 'Ubah berkas?', details: 'Menulis hasil ke proyek.',
      options: [{ id: 'allow_once', label: 'Izinkan sekali' }, { id: 'reject_once', label: 'Tolak' }],
    }
    const { app, directory, databasePath } = setup(undefined, async (options) => {
      options.onOutput('Sedang meninjau proyek.')
      options.onActivity('Membaca berkas proyek')
      decisions.push(await options.onPermission(permission))
      firstAnswered.resolve()
      options.onOutput('Peninjauan selesai; menunggu izin berikutnya.')
      options.onActivity('Menunggu izin menulis')
      decisions.push(await options.onPermission(permission))
      secondAnswered.resolve()
      await finish.promise
      return 'Selesai dengan izin pengguna.'
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Tinjau proyek.' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial.activity).toBe('Membaca berkas proyek')
    expect(initial.permission?.title).toBe(permission.title)
    const tasks = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data
    const pending = tasks[0]!
    expect(pending.output).toBe('Sedang meninjau proyek.')
    expect(pending.activity).toBe('Membaca berkas proyek')
    expect(pending.permission?.requestId).not.toBe(permission.requestId)
    const activeConversation = await request(app, 'GET', `/api/tasks/${initial.id}/conversation`)
    expect(activeConversation.status).toBe(200)
    expect(((await activeConversation.json()) as ApiResponse<Task[]>).data).toEqual([pending])
    expect(decisions).toEqual([])
    expect((await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Bersamaan' })).status).toBe(409)
    expect((await request(app, 'DELETE', `/api/agents/${agent.id}`)).status).toBe(409)
    const permissionPath = `/api/tasks/${initial.id}/permission`
    for (const answer of [
      {}, { requestId: pending.permission!.requestId, optionId: 1 },
      { requestId: pending.permission!.requestId, optionId: 'allow_always' },
    ]) expect((await request(app, 'POST', permissionPath, answer)).status).toBe(400)
    expect((await request(app, 'POST', permissionPath, { requestId: 'stale', optionId: 'allow_once' })).status).toBe(409)
    expect(decisions).toEqual([])
    const answer = await request(app, 'POST', permissionPath, {
      requestId: pending.permission!.requestId, optionId: 'allow_once',
    })
    expect(answer.status).toBe(200)
    expect(((await answer.json()) as ApiResponse<Task>).data.permission).toBeNull()
    await firstAnswered.promise
    expect(decisions).toEqual(['allow_once'])
    const next = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data[0]!
    expect(next.permission?.requestId).not.toBe(pending.permission?.requestId)
    expect(next.activity).toBe('Menunggu izin menulis')
    expect(next.output).toBe('Peninjauan selesai; menunggu izin berikutnya.')
    expect((await request(app, 'POST', permissionPath, {
      requestId: pending.permission!.requestId, optionId: 'allow_once',
    })).status).toBe(409)
    const denied = await request(app, 'POST', permissionPath, { requestId: next.permission!.requestId, optionId: null })
    expect(denied.status).toBe(200)
    await secondAnswered.promise
    expect(decisions).toEqual(['allow_once', null])
    expect((await request(app, 'POST', permissionPath, { requestId: next.permission!.requestId, optionId: null })).status).toBe(409)
    const db = new Database(databasePath)
    const persisted = db.query('SELECT * FROM tasks WHERE id = ?').get(initial.id)
    expect(persisted).toMatchObject({ output: next.output, status: 'running' })
    expect(persisted).not.toHaveProperty('activity')
    expect(persisted).not.toHaveProperty('permission')
    expect(JSON.stringify(persisted)).not.toContain(permission.requestId)
    db.close()
    finish.resolve()
    const completed = await settledTask(app, initial.id)
    expect(completed).toMatchObject({ status: 'completed', output: 'Selesai dengan izin pengguna.', activity: '', permission: null })
    expect((await request(app, 'POST', permissionPath, { requestId: next.permission!.requestId, optionId: 'allow_once' })).status).toBe(409)
  })

  test('forwards a session approval only when the request offered one', async () => {
    const decisions: (string | null)[] = []
    const firstAnswered = Promise.withResolvers<void>()
    const offers = [
      [{ id: 'reject_once', label: 'Tolak' }, { id: 'allow_once', label: 'Izinkan sekali' }, { id: 'allow_session', label: 'Izinkan browser untuk sesi ini' }],
      [{ id: 'reject_once', label: 'Tolak' }, { id: 'allow_once', label: 'Izinkan sekali' }],
    ]
    const { app, directory } = setup(undefined, async (options) => {
      for (const choices of offers) {
        decisions.push(await options.onPermission({ requestId: 'fixture', title: 'Persetujuan tools OMP', details: 'Allow tool: browser', options: choices }))
        if (decisions.length === 1) firstAnswered.resolve()
      }
      return 'Selesai.'
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const started = ((await (await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Buka browser.' })).json()) as ApiResponse<Task>).data
    const path = `/api/tasks/${started.id}/permission`
    const first = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data[0]!
    expect(first.permission?.options.map((option) => option.id)).toEqual(['reject_once', 'allow_once', 'allow_session'])
    expect((await request(app, 'POST', path, { requestId: first.permission!.requestId, optionId: 'allow_session' })).status).toBe(200)
    await firstAnswered.promise
    const second = ((await (await request(app, 'GET', '/api/tasks')).json()) as ApiResponse<Task[]>).data[0]!
    expect(second.permission?.options.map((option) => option.id)).toEqual(['reject_once', 'allow_once'])
    expect((await request(app, 'POST', path, { requestId: second.permission!.requestId, optionId: 'allow_session' })).status).toBe(400)
    expect((await request(app, 'POST', path, { requestId: second.permission!.requestId, optionId: 'allow_once' })).status).toBe(200)
    expect(await settledTask(app, started.id)).toMatchObject({ status: 'completed', permission: null })
    expect(decisions).toEqual(['allow_session', 'allow_once'])
  })

  test.each([
    [new Error('stderr secret token=private-runtime-token'), 'Agen lokal gagal'],
    [new LocalAgentError('Autentikasi CLI lokal ditolak. Jalankan login runtime di terminal.'), 'Autentikasi CLI'],
  ])('stores only safe local errors and keeps partial answers', async (failure, expected) => {
    setRuntimeCommand('omp', process.execPath)
    const { app, directory } = setup(undefined, async ({ onOutput, onActivity }) => {
      onOutput('Hasil sebagian yang dapat dilihat.')
      onActivity('Menjalankan runtime')
      throw failure
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Kerjakan' })
    const task = await settledTask(app, ((await response.json()) as ApiResponse<Task>).data.id)
    expect(task.status).toBe('failed')
    expect(task.error).toContain(String(expected))
    expect(task.error).not.toContain('private-runtime-token')
    expect(task.output).toBe('Hasil sebagian yang dapat dilihat.')
    expect(task.activity).toBe('')
    expect(task.permission).toBeNull()
  })

  test('cancels running local work, rejects pending permission, and frees the agent for another task', async () => {
    setRuntimeCommand('omp', process.execPath)
    let signal: AbortSignal | undefined
    let decision: string | null | undefined
    let calls = 0
    const { app, directory } = setup(undefined, async (options) => {
      calls++
      if (calls > 1) return 'Tugas berikutnya selesai.'
      signal = options.signal
      options.onOutput('Perubahan awal mungkin sudah dilakukan.')
      options.onActivity('Menunggu izin')
      decision = await options.onPermission({
        requestId: 'private-cancel-id', title: 'Jalankan perintah?', details: 'Tidak dijalankan tanpa jawaban.',
        options: [{ id: 'allow_once', label: 'Izinkan sekali' }],
      })
      throw new Error('private cancelled runtime stderr')
    })
    const agent = await addAgent(app, { provider: 'omp', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Mulai' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    expect(initial.permission).not.toBeNull()
    const cancelled = await request(app, 'POST', `/api/tasks/${initial.id}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(((await cancelled.json()) as ApiResponse<Task>).data.permission).toBeNull()
    expect(signal?.aborted).toBe(true)
    const stopped = await settledTask(app, initial.id)
    expect(decision).toBeNull()
    expect(stopped).toMatchObject({ status: 'failed', activity: '', permission: null, output: 'Perubahan awal mungkin sudah dilakukan.' })
    expect(stopped.error).toContain('Task dihentikan')
    expect(stopped.error).not.toContain('private')
    expect((await request(app, 'POST', `/api/tasks/${initial.id}/cancel`)).status).toBe(409)
    expect((await request(app, 'POST', `/api/tasks/${initial.id}/permission`, {
      requestId: initial.permission!.requestId, optionId: 'allow_once',
    })).status).toBe(409)
    expect((await request(app, 'POST', '/api/tasks/missing/cancel')).status).toBe(404)
    expect((await request(app, 'POST', '/api/tasks/missing/permission', { requestId: 'missing', optionId: null })).status).toBe(404)
    const next = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Coba lagi' })
    expect(next.status).toBe(202)
    const completed = await settledTask(app, ((await next.json()) as ApiResponse<Task>).data.id)
    expect(completed.output).toBe('Tugas berikutnya selesai.')
    expect((await request(app, 'POST', `/api/tasks/${completed.id}/cancel`)).status).toBe(409)
  })

  test('shutdown aborts local processes, denies permissions, and preserves clean failed history after restart', async () => {
    setRuntimeCommand('hermes', process.execPath)
    const exited = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    let decision: string | null | undefined
    let lateDecision: string | null | undefined
    const { app, directory, databasePath } = setup(undefined, async (options) => {
      signal = options.signal
      options.onOutput('Jawaban sebelum server dihentikan.')
      try {
        decision = await options.onPermission({
          requestId: 'private-shutdown-id', title: 'Akses tool?', details: 'Memerlukan jawaban pengguna.',
          options: [{ id: 'allow_once', label: 'Izinkan sekali' }],
        })
        options.onOutput('Tidak boleh ditulis setelah close.')
        options.onActivity('Tidak boleh disimpan setelah close.')
        lateDecision = await options.onPermission({
          requestId: 'after-close', title: 'Izin terlambat', details: '', options: [],
        })
        throw new Error('private shutdown stderr')
      } finally {
        exited.resolve()
      }
    })
    const agent = await addAgent(app, { provider: 'hermes', workspace: directory, allowTools: true })
    const response = await request(app, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Mulai' })
    const initial = ((await response.json()) as ApiResponse<Task>).data
    app.close()
    app.close()
    expect(signal?.aborted).toBe(true)
    await exited.promise
    expect(decision).toBeNull()
    expect(lateDecision).toBeNull()
    const restarted = createApp({ databasePath, runLocal: async () => 'Pulih setelah restart.' })
    fixtures.push({ app: restarted, directory })
    const stopped = await settledTask(restarted, initial.id)
    expect(stopped).toMatchObject({
      status: 'failed', output: 'Jawaban sebelum server dihentikan.', activity: '', permission: null,
    })
    expect(stopped.error).toContain('server dihentikan')
    expect(stopped.error).not.toContain('private')
    expect(stopped.completedAt).not.toBeNull()
    const next = await request(restarted, 'POST', '/api/tasks', { agentId: agent.id, prompt: 'Lanjutkan' })
    expect(next.status).toBe(202)
    expect((await settledTask(restarted, ((await next.json()) as ApiResponse<Task>).data.id)).output).toBe('Pulih setelah restart.')
  })
})
