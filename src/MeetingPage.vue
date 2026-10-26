<script setup lang="ts">
import { computed, onDeactivated, reactive, shallowRef, watch } from 'vue'
import { api } from './api'
import Icon from './Icon.vue'
import PermissionStory from './PermissionStory.vue'
import { isLocalProvider } from './types'
import { CALL_LANGUAGES, useVoiceCall } from './useVoiceCall'
import type { Agent, Task } from './types'

interface Turn {
  id: number
  text: string
  replies: Record<string, string>
  errors: Record<string, string>
  skipped: string[]
}

const MAX_TURNS = 50
const props = defineProps<{ agents: Agent[]; tasks: Task[]; connected: boolean }>()
const emit = defineEmits<{ started: [task: Task]; updated: [task: Task] }>()
const mode = shallowRef<'one' | 'all'>('one')
const focusId = shallowRef('')
const selectedId = shallowRef<string | null>(null)
const sending = shallowRef(0)
const turns = reactive<Turn[]>([])
// Each meeting keeps its own reply chain per agent; it never reuses the conversations from the office panel.
const chain = new Map<string, string>()
const awaiting = new Map<string, string>()
let turnCounter = 0

const participants = computed(() => mode.value === 'all' ? props.agents : props.agents.filter((agent) => agent.id === focusId.value))
const runningTasks = computed(() => new Map(props.tasks.filter((task) => task.status === 'running').map((task) => [task.agentId, task])))
const includesLocal = computed(() => participants.value.some((agent) => isLocalProvider(agent.provider)))

watch(() => props.agents, (agents) => {
  if (!agents.some((agent) => agent.id === focusId.value)) focusId.value = agents[0]?.id ?? ''
}, { immediate: true })

function agentName(id: string): string {
  return props.agents.find((agent) => agent.id === id)?.name ?? 'Agent'
}

function taskOf(id: string): Task | undefined {
  return props.tasks.find((task) => task.id === id)
}

async function broadcast(text: string): Promise<void> {
  const busy = new Set(participants.value.filter((agent) => runningTasks.value.has(agent.id)).map((agent) => agent.id))
  const turn = reactive<Turn>({
    id: ++turnCounter, text, replies: {}, errors: {},
    skipped: participants.value.filter((agent) => busy.has(agent.id)).map((agent) => agent.name),
  })
  turns.push(turn)
  if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS)
  const targets = participants.value.filter((agent) => !busy.has(agent.id))
  sending.value++
  try {
    await Promise.all(targets.map(async (agent) => {
      try {
        const task = await api<Task>('/tasks', {
          method: 'POST',
          body: JSON.stringify({ agentId: agent.id, prompt: text, replyToId: chain.get(agent.id) ?? null, autoApprove: false }),
        })
        turn.replies[agent.id] = task.id
        awaiting.set(task.id, agent.id)
        emit('started', task)
      } catch (cause) {
        turn.errors[agent.id] = cause instanceof Error ? cause.message : 'Pesan gagal dikirim.'
      }
    }))
  } finally {
    sending.value--
  }
}

const working = computed(() => sending.value > 0 || participants.value.some((agent) => runningTasks.value.has(agent.id)))
const { supported, active, micOn, speakReplies, language, speaking, listening, caption, error: callError, start, end, toggleMic, toggleSpeakReplies, stopSpeaking, speak } = useVoiceCall({
  send: broadcast,
  busy: () => working.value,
})
const status = computed(() => speaking.value ? 'AI berbicara' : working.value ? 'Agent bekerja…' : listening.value ? 'Mendengarkan' : micOn.value ? 'Menyiapkan mikrofon…' : 'Mikrofon mati')

watch(() => props.tasks, () => {
  for (const [taskId, agentId] of awaiting) {
    const task = taskOf(taskId)
    if (!task || task.status === 'running') continue
    awaiting.delete(taskId)
    const name = agentName(agentId)
    if (task.status === 'failed') {
      chain.set(agentId, taskId)
      speak(language.value === 'id-ID' ? `${name} gagal menjawab.` : `${name} failed to answer.`)
    } else if (task.output.trim()) {
      chain.set(agentId, taskId)
      speak(mode.value === 'all' ? `${name}. ${task.output}` : task.output)
    }
  }
})
onDeactivated(end)

function tileStatus(agent: Agent): string {
  const running = runningTasks.value.get(agent.id)
  if (running?.permission) return 'Minta izin'
  if (running) return running.activity || 'Bekerja…'
  const last = turns.at(-1)
  if (last?.errors[agent.id]) return 'Pesan gagal'
  const task = last?.replies[agent.id] ? taskOf(last.replies[agent.id]!) : undefined
  return task?.status === 'failed' ? 'Gagal menjawab' : task ? 'Sudah menjawab' : 'Siap'
}
</script>

<template>
  <main class="meeting-page" aria-labelledby="meeting-title">
    <header class="meeting-header">
      <div>
        <span class="eyebrow">WORKSPACE / MEETING</span>
        <h1 id="meeting-title">Bicara langsung, <span>tanpa mengetik.</span></h1>
        <p class="meeting-subtitle">Ucapanmu diubah jadi teks, dikirim ke agent, lalu jawabannya dibacakan. Pilih satu agent atau rapat dengan semua.</p>
      </div>
      <a class="button office-link" href="#office"><Icon name="office" :size="16" />Kembali ke kantor</a>
    </header>

    <p v-if="!connected" class="error-notice" role="status">Server belum terhubung. Meeting tersedia setelah koneksi pulih.</p>
    <p v-if="!supported" class="error-notice" role="status">Browser ini tidak mendukung pengenalan suara. Gunakan Chrome, Edge, atau Safari.</p>
    <p v-if="!agents.length" class="composer-note">Belum ada agent. <a href="#office">Tambahkan agent di kantor</a> untuk memulai meeting.</p>

    <section v-else class="meeting-stage" aria-label="Peserta meeting">
      <div class="mode-switch" role="group" aria-label="Siapa yang diajak bicara">
        <button type="button" :class="{ chosen: mode === 'one' }" :aria-pressed="mode === 'one'" @click="mode = 'one'">Satu agent</button>
        <button type="button" :class="{ chosen: mode === 'all' }" :aria-pressed="mode === 'all'" @click="mode = 'all'">Semua agent</button>
      </div>
      <div class="tiles">
        <component
          :is="mode === 'one' ? 'button' : 'div'"
          v-for="agent in agents"
          :key="agent.id"
          class="tile"
          :class="{ selected: mode === 'all' || focusId === agent.id, working: runningTasks.has(agent.id) }"
          :style="{ '--agent-color': agent.color }"
          v-bind="mode === 'one' ? { type: 'button', 'aria-pressed': focusId === agent.id } : {}"
          @click="mode === 'one' && (focusId = agent.id)"
        >
          <span class="tile-avatar">{{ agent.name.slice(0, 1).toUpperCase() }}</span>
          <span class="tile-name">{{ agent.name }}</span>
          <span class="tile-status" :class="{ attention: runningTasks.get(agent.id)?.permission }">{{ tileStatus(agent) }}</span>
        </component>
      </div>
      <p v-if="mode === 'all' && includesLocal" class="composer-note tools-note">Pesan dikirim ke semua agent, termasuk agent lokal yang dapat memakai tools di workspace-nya. Izin tetap manual dan muncul di bawah; agent yang sedang bekerja dilewati.</p>
    </section>

    <section v-if="agents.length" class="call-bar" aria-label="Kontrol panggilan">
      <div class="call-main">
        <button v-if="!active" type="button" class="button primary" :disabled="!supported || !connected || !participants.length" @click="start"><Icon name="mic" :size="15" />Mulai meeting</button>
        <template v-else>
          <button type="button" class="button call-toggle" :class="{ 'is-off': !micOn }" :aria-pressed="micOn" :aria-label="micOn ? 'Matikan mikrofon' : 'Nyalakan mikrofon'" @click="toggleMic"><Icon :name="micOn ? 'mic' : 'micoff'" :size="15" />{{ micOn ? 'Mic nyala' : 'Mic mati' }}</button>
          <button type="button" class="button call-toggle" :class="{ 'is-off': !speakReplies }" :aria-pressed="speakReplies" :aria-label="speakReplies ? 'Matikan suara AI' : 'Nyalakan suara AI'" @click="toggleSpeakReplies"><Icon :name="speakReplies ? 'volume' : 'volumeoff'" :size="15" />{{ speakReplies ? 'Suara AI' : 'Senyap' }}</button>
          <button v-if="speaking" type="button" class="text-button" @click="stopSpeaking">Hentikan suara</button>
          <span class="call-status" :class="{ 'is-live': listening && !speaking }" role="status">{{ status }}</span>
          <button type="button" class="button call-end" @click="end">Akhiri</button>
        </template>
        <label class="call-language">Bahasa bicara
          <select v-model="language" aria-label="Bahasa bicara">
            <option v-for="entry in CALL_LANGUAGES" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
          </select>
        </label>
      </div>
      <p v-if="!active" class="composer-note">Pengenalan suara dijalankan oleh browser; audionya dapat dikirim ke layanan penyedia browser (Google di Chrome). Mikrofon berhenti saat agent bekerja atau bicara. Meeting berhenti saat kamu pindah halaman.</p>
      <p v-if="active" class="call-caption" role="log" aria-live="polite">{{ caption || (micOn && listening ? 'Silakan bicara…' : '') }}</p>
      <p v-if="callError" class="error-notice" role="alert">{{ callError }}</p>
    </section>

    <section v-if="agents.length" class="meeting-log" role="log" aria-label="Percakapan meeting" aria-live="polite" aria-relevant="additions">
      <p v-if="!turns.length" class="composer-note">Belum ada percakapan. Mulai meeting lalu bicara.</p>
      <article v-for="turn in turns" :key="turn.id" class="turn">
        <div class="bubble mine"><span class="who">Anda</span><p>{{ turn.text }}</p></div>
        <p v-if="turn.skipped.length" class="composer-note">Dilewati karena sedang bekerja: {{ turn.skipped.join(', ') }}.</p>
        <template v-for="(taskId, agentId) in turn.replies" :key="taskId">
          <div class="bubble theirs">
            <span class="who">{{ agentName(agentId) }} <span>· {{ taskOf(taskId)?.status === 'running' ? 'Bekerja' : taskOf(taskId)?.status === 'failed' ? 'Terhenti' : 'Selesai' }}</span></span>
            <p v-if="taskOf(taskId)?.status === 'failed'" class="error-notice">{{ taskOf(taskId)?.error }}</p>
            <pre v-if="taskOf(taskId)?.output">{{ taskOf(taskId)?.output }}</pre>
            <p v-else-if="taskOf(taskId)?.status === 'running'" class="composer-note">{{ taskOf(taskId)?.activity || 'Sedang mengerjakan…' }}</p>
          </div>
        </template>
        <p v-for="(message, agentId) in turn.errors" :key="agentId" class="error-notice" role="alert">{{ agentName(agentId) }}: {{ message }}</p>
      </article>
    </section>

    <PermissionStory :agents="agents" :tasks="tasks" :selected-id="selectedId" @select="selectedId = $event" @updated="emit('updated', $event)" />
  </main>
</template>

<style scoped>
.meeting-page { display: grid; gap: 22px; align-content: start; min-width: 0; padding: 32px 30px; color: var(--text); }
.meeting-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 20px; }
.meeting-header h1 { letter-spacing: -1.3px; }
.meeting-subtitle { max-width: 620px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.8; }
.meeting-stage, .call-bar, .meeting-log { display: grid; gap: 14px; padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.mode-switch { display: inline-flex; width: fit-content; padding: 3px; border: 1px solid var(--border); border-radius: 9px; background: var(--background); }
.mode-switch button { padding: 8px 14px; border-radius: 7px; font-size: 11px; color: var(--muted); }
.mode-switch .chosen { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px #23352110; }
.mode-switch button:focus-visible, .tile:focus-visible, .call-toggle:focus-visible, .call-end:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.tile { display: grid; justify-items: center; gap: 8px; min-width: 0; padding: 16px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--background); color: inherit; text-align: center; }
button.tile { cursor: pointer; }
.tile.selected { border-color: var(--green); background: var(--green-soft); }
.tile.working { border-color: var(--amber); }
.tile-avatar { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 17px; background: var(--agent-color); color: #283b32; font-size: 22px; font-weight: 600; }
.tile-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.tile-status { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted); }
.tile-status.attention { color: var(--amber); font-weight: 700; }
.tools-note { margin: 0; color: var(--amber); }
.call-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.call-toggle { border: 1px solid var(--border); background: var(--surface); color: var(--green); padding: 9px 12px; }
.call-toggle.is-off { color: var(--error); background: var(--error-soft); }
.call-status { font-size: 10px; color: var(--muted); background: var(--background); border-radius: 20px; padding: 5px 10px; }
.call-status.is-live { color: var(--green); background: var(--green-soft); }
.call-end { padding: 9px 12px; background: var(--error); color: #fff; }
.call-language { display: grid; gap: 4px; margin-left: auto; font-size: 10px; color: var(--muted); }
.call-language select { width: auto; padding: 7px 10px; font-size: 11px; }
.call-caption { min-height: 2.4em; margin: 0; padding: 9px 11px; border: 1px dashed var(--border); border-radius: 10px; background: var(--background); font-size: 13px; line-height: 1.7; }
.call-caption:empty { display: none; }
.turn { display: grid; gap: 10px; }
.turn + .turn { padding-top: 14px; border-top: 1px solid var(--border); }
.bubble { max-width: min(680px, 94%); min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 14px; }
.bubble p, .bubble pre { margin: 0; font: inherit; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.who { display: block; margin-bottom: 6px; font-size: 10px; font-weight: 600; color: var(--green); }
.who span { font-weight: 400; color: var(--muted); }
.mine { justify-self: end; background: var(--green-soft); border-bottom-right-radius: 4px; }
.theirs { justify-self: start; background: var(--background); border-bottom-left-radius: 4px; }
.meeting-page > :deep(.permission-story) { border: 2px solid var(--amber); border-radius: 12px; }
@media (max-width: 720px) { .meeting-page { padding: 24px 16px; } .meeting-header h1 { font-size: 29px; } .call-language { margin-left: 0; } }
</style>
