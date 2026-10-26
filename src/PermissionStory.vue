<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { api } from './api'
import type { Agent, Task } from './types'

const props = defineProps<{ agents: Agent[]; tasks: Task[]; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string]; updated: [task: Task] }>()
const pending = computed(() => props.tasks.filter((task) => task.status === 'running' && task.permission && props.agents.some((agent) => agent.id === task.agentId)))
const current = computed(() => pending.value.find((task) => task.agentId === props.selectedId) ?? pending.value[0])
const speaker = computed(() => props.agents.find((agent) => agent.id === current.value?.agentId))
const options = computed(() => current.value?.permission?.options.filter((option) => option.id === 'allow_once' || option.id === 'allow_session' || option.id === 'reject_once') ?? [])
const hasReject = computed(() => options.value.some((option) => option.id === 'reject_once'))
const busy = shallowRef(false)
const error = shallowRef<{ taskId: string; requestId: string; message: string } | null>(null)
const currentError = computed(() => error.value?.taskId === current.value?.id && error.value?.requestId === current.value?.permission?.requestId ? error.value?.message : '')

function agentName(id: string): string {
  return props.agents.find((agent) => agent.id === id)?.name ?? 'Agent'
}

async function answer(optionId: string | null): Promise<void> {
  const task = current.value
  const permission = task?.permission
  if (!task || !permission || busy.value) return
  if (optionId !== null && !options.value.some((option) => option.id === optionId)) return
  busy.value = true
  error.value = null
  try {
    const updated = await api<Task>(`/tasks/${task.id}/permission`, { method: 'POST', body: JSON.stringify({ requestId: permission.requestId, optionId }) })
    emit('updated', updated)
  } catch (cause) {
    error.value = { taskId: task.id, requestId: permission.requestId, message: cause instanceof Error ? cause.message : 'Jawaban izin gagal dikirim.' }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="current?.permission && speaker" id="permission-story" class="permission-story" aria-label="Dialog perizinan NPC" :aria-busy="busy" tabindex="-1">
    <nav v-if="pending.length > 1" class="story-queue" aria-label="NPC yang menunggu izin">
      <button v-for="task in pending" :key="task.id" type="button" :aria-pressed="task.id === current.id" @click="emit('select', task.agentId)">{{ agentName(task.agentId) }} · Minta izin</button>
    </nav>
    <div class="story-speaker" role="status">
      <span class="story-avatar" :style="{ '--agent-color': speaker.color }" aria-hidden="true">{{ speaker.name.slice(0, 1).toUpperCase() }}</span>
      <div><strong>{{ speaker.name }}</strong><span>Menunggu izin Anda · {{ pending.length }} permintaan</span></div>
      <span class="story-badge">MINTA IZIN</span>
    </div>
    <div :key="`${current.id}:${current.permission.requestId}`" class="story-body">
      <h3>{{ current.permission.title }}</h3>
      <pre class="story-details" tabindex="0" aria-label="Detail tindakan yang meminta izin">{{ current.permission.details }}</pre>
    </div>
    <p class="story-note">{{ options.some((option) => option.id === 'allow_session') ? 'Izinkan sekali hanya untuk permintaan ini. Izinkan untuk sesi ini berlaku untuk semua panggilan tool tersebut sampai task ini selesai, termasuk di luar workspace; tidak berlaku untuk task lain.' : 'Tinjau tindakan di atas. Persetujuan hanya untuk permintaan ini, bukan untuk sesi atau tindakan lain.' }}</p>
    <div class="story-actions">
      <button v-for="option in options" :key="option.id" type="button" class="button" :class="option.id === 'allow_once' ? 'primary' : option.id === 'allow_session' ? 'session-button' : 'reject-button'" :disabled="busy" @click="answer(option.id === 'reject_once' ? null : option.id)">{{ option.label }}</button>
      <button v-if="!hasReject" type="button" class="button reject-button" :disabled="busy" @click="answer(null)">Tolak permintaan</button>
      <span v-if="busy" role="status">Mengirim jawaban…</span>
    </div>
    <p v-if="currentError" class="error-notice" role="alert">{{ currentError }}</p>
  </section>
</template>

<style scoped>
.permission-story { flex: 0 1 auto; min-height: 0; max-height: 45dvh; overflow-y: auto; overscroll-behavior: contain; padding: 16px 20px; border-top: 2px solid var(--amber); background: var(--surface); color: var(--text); scroll-margin: 20px; }
.story-queue { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 12px; }
.story-queue button { flex-shrink: 0; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; font-size: 10px; }
.story-queue button[aria-pressed="true"] { background: var(--amber-soft); border-color: var(--amber); }
.story-speaker { display: flex; align-items: center; gap: 10px; }
.story-avatar { flex-shrink: 0; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 12px 12px 4px 12px; background: var(--agent-color); color: var(--text); font-size: 17px; font-weight: 700; }
.story-speaker > div { display: grid; gap: 4px; min-width: 0; }
.story-speaker strong { font-size: 12px; overflow-wrap: anywhere; }
.story-speaker div > span, .story-note, .story-actions > span { font-size: 10px; line-height: 1.6; color: var(--muted); }
.story-badge { flex-shrink: 0; margin-left: auto; padding: 5px 7px; border-radius: 5px; background: var(--amber-soft); color: var(--amber); font-size: 8px; font-weight: 700; letter-spacing: 1px; }
.story-body h3 { font-size: 13px; line-height: 1.6; margin: 12px 0 8px; white-space: pre-wrap; }
.story-details { max-height: 16dvh; overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.7; }
.story-note { margin: 10px 0; }
.story-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.story-actions .button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.reject-button { border: 1px solid var(--border); color: var(--error); }
.session-button { border: 1px solid var(--green); color: var(--green); background: var(--green-soft); }
@media (max-width: 720px) { .permission-story { padding: 12px; } .story-badge { display: none; } }
</style>
