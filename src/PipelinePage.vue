<script setup lang="ts">
import { computed, nextTick, reactive, shallowRef, watch } from 'vue'
import { api } from './api'
import Icon from './Icon.vue'
import PermissionStory from './PermissionStory.vue'
import type { Agent, Task, TodoPrompt } from './types'

const props = defineProps<{ agents: Agent[]; tasks: Task[]; todos: TodoPrompt[]; connected: boolean }>()
const emit = defineEmits<{ queued: [todo: TodoPrompt]; started: [task: Task]; updated: [task: Task] }>()
const agentId = shallowRef('')
const prompt = shallowRef('')
const saving = shallowRef(false)
const error = shallowRef('')
const saved = shallowRef(false)
const selectedId = shallowRef<string | null>(null)
const starting = reactive(new Set<string>())
const startingAgents = reactive(new Set<string>())
const startErrors = reactive<Record<string, string>>({})
const agentsById = computed(() => new Map(props.agents.map((agent) => [agent.id, agent])))
const runningAgents = computed(() => new Set(props.tasks.filter((task) => task.status === 'running').map((task) => task.agentId)))
const columns = computed(() => [
  { id: 'running', title: 'Progress', icon: 'clock', note: 'Dikerjakan oleh agent', empty: 'Belum ada task yang berjalan.', tasks: props.tasks.filter((task) => task.status === 'running') },
  { id: 'completed', title: 'Selesai', icon: 'check', note: 'Hasil siap ditinjau', empty: 'Task yang selesai akan tampil di sini.', tasks: props.tasks.filter((task) => task.status === 'completed') },
  { id: 'failed', title: 'Gagal', icon: 'close', note: 'Periksa kendala dan output', empty: 'Belum ada task yang gagal.', tasks: props.tasks.filter((task) => task.status === 'failed') },
])
const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

watch(agentsById, (agents) => {
  if (!agents.has(agentId.value)) agentId.value = props.agents[0]?.id ?? ''
}, { immediate: true })

function agentName(id: string): string {
  return agentsById.value.get(id)?.name ?? 'Agent tidak tersedia'
}

function time(value: string): string {
  return dateFormat.format(new Date(value))
}

function agentBusy(id: string): boolean {
  return runningAgents.value.has(id) || startingAgents.has(id)
}

async function queue(): Promise<void> {
  if (saving.value || !props.connected) return
  error.value = ''
  saved.value = false
  const text = prompt.value.trim()
  if (!agentsById.value.has(agentId.value)) {
    error.value = 'Pilih agent yang tersedia terlebih dahulu.'
    return
  }
  if (!text || text.length > 12_000) {
    error.value = 'Prompt wajib diisi, maksimal 12.000 karakter.'
    return
  }
  saving.value = true
  try {
    const todo = await api<TodoPrompt>('/todos', { method: 'POST', body: JSON.stringify({ agentId: agentId.value, prompt: text }) })
    emit('queued', todo)
    prompt.value = ''
    saved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Prompt gagal disimpan. Draft Anda tetap tersedia.'
  } finally {
    saving.value = false
  }
}

async function start(todo: TodoPrompt): Promise<void> {
  if (!props.connected || starting.has(todo.id) || agentBusy(todo.agentId) || !agentsById.value.has(todo.agentId)) return
  starting.add(todo.id)
  startingAgents.add(todo.agentId)
  delete startErrors[todo.id]
  try {
    const task = await api<Task>('/tasks', { method: 'POST', body: JSON.stringify({ todoId: todo.id }) })
    emit('started', task)
  } catch (cause) {
    startErrors[todo.id] = cause instanceof Error ? cause.message : 'Task gagal dimulai. Prompt tetap ada di Todo.'
  } finally {
    starting.delete(todo.id)
    startingAgents.delete(todo.agentId)
  }
}

async function reviewPermission(id: string): Promise<void> {
  selectedId.value = id
  await nextTick()
  const story = document.getElementById('permission-story')
  story?.scrollIntoView({ block: 'nearest' })
  story?.focus({ preventScroll: true })
}
</script>

<template>
  <main class="pipeline-page" aria-labelledby="pipeline-title">
    <header class="pipeline-header">
      <div>
        <span class="eyebrow">WORKSPACE / PIPELINE</span>
        <h1 id="pipeline-title">Dari ide, <span>jadi hasil.</span></h1>
        <p class="pipeline-subtitle">Simpan prompt, jalankan saat siap, dan ikuti pekerjaan agent dalam satu papan.</p>
      </div>
      <a class="button office-link" href="#office"><Icon name="office" :size="16" />Kembali ke kantor</a>
    </header>

    <p v-if="!connected" class="error-notice" role="status">Server belum terhubung. Data terakhir tetap ditampilkan; menyimpan dan menjalankan prompt tersedia setelah koneksi pulih.</p>

    <section class="queue-composer" aria-labelledby="queue-title">
      <div class="composer-heading">
        <span class="composer-icon"><Icon name="plus" :size="22" /></span>
        <div><h2 id="queue-title">Tambahkan ke Todo</h2><p>Disimpan dulu, bukan langsung dikerjakan. Anda yang menentukan kapan task dimulai.</p></div>
      </div>
      <form class="queue-form" :aria-busy="saving" @submit.prevent="queue">
        <label class="agent-field" for="pipeline-agent">Agent
          <select id="pipeline-agent" v-model="agentId" required :disabled="saving || !connected || !agents.length">
            <option v-if="!agents.length" value="">Belum ada agent</option>
            <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}{{ agentBusy(agent.id) ? ' · Sedang bekerja' : '' }}</option>
          </select>
        </label>
        <label class="prompt-field" for="pipeline-prompt">Prompt
          <textarea id="pipeline-prompt" v-model="prompt" required maxlength="12000" rows="3" placeholder="Apa yang ingin Anda kerjakan bersama agent?" :disabled="saving || !connected || !agents.length" aria-describedby="pipeline-prompt-note" @input="saved = false" />
        </label>
        <div class="composer-footer">
          <p id="pipeline-prompt-note">{{ prompt.length.toLocaleString('id-ID') }} / 12.000 karakter · Izin otomatis tidak diaktifkan saat menjalankan Todo.</p>
          <button type="submit" class="button primary" :disabled="saving || !connected || !agents.length || !prompt.trim()"><Icon :name="saving ? 'clock' : 'plus'" :size="15" />{{ saving ? 'Menyimpan…' : 'Simpan ke Todo' }}</button>
        </div>
      </form>
      <p v-if="!agents.length" class="composer-notice">Belum ada agent yang tersedia. <a href="#office">Tambahkan agent di kantor</a> untuk menyimpan prompt.</p>
      <p v-if="error" class="error-notice" role="alert">{{ error }}</p>
      <p v-if="saved" class="saved-notice" role="status"><Icon name="check" :size="14" />Prompt tersimpan di Todo. Jalankan saat Anda siap.</p>
    </section>

    <div class="board-heading"><h2>Alur pekerjaan</h2><p>Status mengikuti eksekusi nyata, bukan dipindah secara manual.</p></div>
    <div class="pipeline-board" aria-label="Papan Kanban task">
      <section class="kanban-column todo-column" aria-labelledby="column-todo">
        <header class="column-header"><div><Icon name="task" :size="16" /><h3 id="column-todo">Todo</h3><span class="column-count">{{ todos.length }}</span></div><p>Prompt tersimpan, siap dijalankan</p></header>
        <div class="column-cards">
          <article v-for="todo in todos" :key="todo.id" class="pipeline-card" :aria-busy="starting.has(todo.id)">
            <div class="card-agent"><Icon name="people" :size="14" /><strong>{{ agentName(todo.agentId) }}</strong></div>
            <p class="card-prompt" tabindex="0" aria-label="Prompt Todo">{{ todo.prompt }}</p>
            <div class="card-meta"><time :datetime="todo.createdAt">{{ time(todo.createdAt) }}</time><code :title="todo.id">#{{ todo.id.slice(0, 8) }}</code></div>
            <button type="button" class="button start-button" :disabled="!connected || starting.has(todo.id) || agentBusy(todo.agentId) || !agentsById.has(todo.agentId)" @click="start(todo)"><Icon :name="starting.has(todo.id) || agentBusy(todo.agentId) ? 'clock' : 'arrow'" :size="14" />{{ starting.has(todo.id) ? 'Memulai…' : agentBusy(todo.agentId) ? 'Agent sedang bekerja' : 'Jalankan' }}</button>
            <p v-if="agentBusy(todo.agentId) && !starting.has(todo.id)" class="card-note">Menunggu agent tersedia. Jalankan secara manual setelah task aktif berakhir.</p>
            <p v-if="startErrors[todo.id]" class="error-notice" role="alert">{{ startErrors[todo.id] }}</p>
          </article>
          <div v-if="!todos.length" class="column-empty"><Icon name="plus" :size="22" /><p>Ide berikutnya dimulai di sini.</p><span>Simpan prompt melalui form di atas.</span></div>
        </div>
      </section>

      <section v-for="column in columns" :key="column.id" class="kanban-column" :class="`${column.id}-column`" :aria-labelledby="`column-${column.id}`">
        <header class="column-header"><div><Icon :name="column.icon" :size="16" /><h3 :id="`column-${column.id}`">{{ column.title }}</h3><span class="column-count">{{ column.tasks.length }}</span></div><p>{{ column.note }}</p></header>
        <div class="column-cards">
          <article v-for="task in column.tasks" :key="task.id" class="pipeline-card" :class="{ 'needs-permission': task.status === 'running' && task.permission }">
            <div class="card-agent"><Icon name="people" :size="14" /><strong>{{ agentName(task.agentId) }}</strong></div>
            <p class="card-prompt" tabindex="0" aria-label="Prompt task">{{ task.prompt }}</p>
            <div class="card-meta"><time :datetime="task.createdAt">{{ time(task.createdAt) }}</time><code :title="task.id">#{{ task.id.slice(0, 8) }}</code></div>
            <p v-if="task.status === 'running'" class="card-activity"><Icon :name="task.permission ? 'lock' : 'clock'" :size="13" />{{ task.activity || 'Agent sedang mengerjakan task…' }}</p>
            <button v-if="task.status === 'running' && task.permission" type="button" class="button permission-button" aria-controls="permission-story" @click="reviewPermission(task.agentId)"><Icon name="lock" :size="15" />MINTA IZIN · Tinjau</button>
            <details class="task-details">
              <summary>{{ task.status === 'failed' ? 'Lihat kendala & output' : 'Lihat output' }}<Icon name="chevron" :size="13" /></summary>
              <div class="task-detail-body">
                <p v-if="task.error" class="error-notice task-error" tabindex="0" aria-label="Kendala task">{{ task.error }}</p>
                <p v-if="task.status === 'failed' && task.output" class="card-note">Output parsial sebelum task terhenti</p>
                <pre v-if="task.output" class="task-output" tabindex="0" aria-label="Output task">{{ task.output }}</pre>
                <p v-else class="card-note">{{ task.status === 'running' ? 'Belum ada output. Perkembangan akan tampil otomatis.' : 'Tidak ada output yang tersimpan.' }}</p>
                <p v-if="task.completedAt" class="card-note">Berakhir <time :datetime="task.completedAt">{{ time(task.completedAt) }}</time></p>
                <code class="task-id">ID: {{ task.id }}</code>
              </div>
            </details>
          </article>
          <div v-if="!column.tasks.length" class="column-empty"><Icon :name="column.icon" :size="22" /><p>{{ column.empty }}</p></div>
        </div>
      </section>
    </div>

    <p class="history-note"><Icon name="task" :size="14" />Menampilkan semua Todo, 100 task terbaru, dan seluruh task yang masih berjalan. Tidak ada penjadwalan otomatis.</p>
    <PermissionStory :agents="agents" :tasks="tasks" :selected-id="selectedId" @select="selectedId = $event" @updated="emit('updated', $event)" />
  </main>
</template>

<style scoped>
.pipeline-page { min-width: 0; padding: 32px 30px; color: var(--text); }
.pipeline-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 20px; margin-bottom: 25px; }
.pipeline-header h1 { letter-spacing: -1.3px; }
.pipeline-subtitle { max-width: 620px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.8; }
.office-link { border: 1px solid var(--border); background: var(--surface); }
.office-link:hover { background: var(--hover); }
.queue-composer { padding: 22px; border: 1px solid var(--border); border-radius: 13px; background: var(--surface); }
.composer-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.composer-icon { display: grid; place-items: center; flex-shrink: 0; width: 40px; height: 40px; border-radius: 12px; color: var(--green); background: var(--green-soft); }
.composer-heading h2, .board-heading h2 { margin: 0; font-size: 14px; font-weight: 700; }
.composer-heading p, .board-heading p { margin: 5px 0 0; font-size: 11px; color: var(--muted); line-height: 1.7; }
.queue-form { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 3fr); align-items: start; gap: 16px; }
.agent-field, .prompt-field { display: grid; gap: 8px; min-width: 0; font-size: 11px; font-weight: 600; }
.prompt-field textarea { min-height: 90px; max-height: 300px; line-height: 1.6; }
.composer-footer { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.composer-footer p, .composer-notice { margin: 0; font-size: 10px; line-height: 1.7; color: var(--muted); }
.composer-notice { margin-top: 14px; }
.composer-notice a { color: var(--green); text-decoration: underline; }
.saved-notice { display: flex; align-items: center; gap: 7px; margin: 14px 0 0; font-size: 11px; color: var(--green); }
.board-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 28px 0 14px; }
.board-heading p { margin: 0; }
.pipeline-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 14px; }
.kanban-column { min-width: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--hover); }
.column-header { padding: 16px 14px 13px; border-bottom: 1px solid var(--border); }
.column-header > div { display: flex; align-items: center; gap: 8px; }
.column-header h3 { margin: 0; font-size: 12px; font-weight: 700; }
.column-header > div > svg { color: var(--muted); }
.running-column .column-header > div > svg { color: var(--amber); }
.completed-column .column-header > div > svg { color: var(--green); }
.failed-column .column-header > div > svg { color: var(--error); }
.column-count { display: grid; place-items: center; min-width: 23px; padding: 3px 6px; margin-left: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); font-size: 10px; color: var(--muted); }
.column-header p { margin: 7px 0 0; font-size: 10px; color: var(--muted); }
.column-cards { display: grid; gap: 10px; min-width: 0; padding: 10px; }
.pipeline-card { min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }
.card-agent { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--green); }
.card-agent strong { font-size: 11px; overflow-wrap: anywhere; }
.card-prompt { max-height: 150px; overflow: auto; margin: 12px 0; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; overscroll-behavior: contain; }
.card-prompt:focus-visible, .task-output:focus-visible, .task-error:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.card-meta { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 5px; color: var(--muted); font-size: 9px; line-height: 1.6; }
.card-meta code { font-size: 9px; }
.start-button { width: 100%; margin-top: 13px; padding: 9px 8px; color: var(--green); background: var(--green-soft); white-space: normal; }
.start-button:hover:not(:disabled) { background: var(--hover); }
.card-note { margin: 9px 0 0; color: var(--muted); font-size: 10px; line-height: 1.7; }
.card-activity { display: flex; align-items: flex-start; gap: 6px; margin: 12px 0 0; color: var(--amber); font-size: 10px; line-height: 1.7; }
.card-activity svg { margin-top: 2px; }
.needs-permission { border: 2px solid var(--amber); }
.permission-button { width: 100%; margin-top: 12px; padding: 10px 7px; border: 1px solid var(--amber); color: var(--amber); background: var(--amber-soft); font-size: 10px; white-space: normal; }
.task-details { margin-top: 12px; border-top: 1px solid var(--border); }
.task-details summary { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 11px; cursor: pointer; color: var(--green); font-size: 10px; }
.task-details summary:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.task-details[open] summary svg { transform: rotate(90deg); }
.task-detail-body { min-width: 0; }
.task-output { max-height: 280px; overflow: auto; padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--background); font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; overscroll-behavior: contain; }
.task-error { max-height: 180px; overflow: auto; white-space: pre-wrap; overscroll-behavior: contain; }
.task-id { display: block; margin-top: 10px; color: var(--muted); font-size: 9px; overflow-wrap: anywhere; }
.column-empty { display: grid; justify-items: center; align-content: center; min-height: 170px; padding: 20px 12px; color: var(--muted); text-align: center; }
.column-empty p { margin: 12px 0 0; font-size: 11px; line-height: 1.8; }
.column-empty span { margin-top: 5px; font-size: 10px; line-height: 1.7; }
.history-note { display: flex; align-items: flex-start; gap: 7px; margin: 18px 0 0; color: var(--muted); font-size: 10px; line-height: 1.8; }
.history-note svg { margin-top: 2px; }
.pipeline-page > :deep(.permission-story) { margin-top: 22px; border: 2px solid var(--amber); border-radius: 12px; }
@media (max-width: 1200px) { .pipeline-board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .pipeline-page { padding: 24px 16px; }
  .pipeline-header h1 { font-size: 29px; }
  .queue-composer { padding: 16px; }
  .queue-form { grid-template-columns: minmax(0, 1fr); }
  .composer-footer { align-items: stretch; flex-direction: column; }
  .pipeline-board { grid-template-columns: minmax(0, 1fr); }
  .column-empty { min-height: 110px; }
  .composer-heading { align-items: flex-start; }
}
</style>
