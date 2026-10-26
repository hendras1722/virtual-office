<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { api } from './api'
import Icon from './Icon.vue'
import { isLocalProvider, PROVIDERS } from './types'
import type { Agent, Task } from './types'

const props = defineProps<{ agent: Agent | null; tasks: Task[] }>()
const emit = defineEmits<{ started: [task: Task]; updated: [task: Task]; remove: [id: string]; edit: [id: string]; showPermission: [id: string] }>()
const prompt = shallowRef('')
const replyTarget = shallowRef<Task | null>(null)
const newConversation = shallowRef(false)
const ancestors = shallowRef<Task[]>([])
const historyLoading = shallowRef(false)
const historyError = shallowRef('')
const promptInput = useTemplateRef<HTMLTextAreaElement>('promptInput')
const transcript = useTemplateRef<HTMLElement>('transcript')
const followingLatest = shallowRef(true)
const sending = shallowRef(false)
const autoApprove = shallowRef(false)
const error = shallowRef('')
const copied = shallowRef('')
const confirmRemove = shallowRef(false)
const agentTasks = computed(() => props.tasks.filter((task) => task.agentId === props.agent?.id))
const runningTask = computed(() => agentTasks.value.find((task) => task.status === 'running'))
const running = computed(() => !!runningTask.value)
const latest = computed(() => agentTasks.value[0])
const activeTaskId = shallowRef('')
const displayedTask = computed(() => agentTasks.value.find((task) => task.id === activeTaskId.value) ?? latest.value)
const conversationTurns = computed(() => newConversation.value || !displayedTask.value ? [] : [...ancestors.value, displayedTask.value])
const provider = computed(() => PROVIDERS.find((item) => item.id === props.agent?.provider))
const local = computed(() => !!props.agent && isLocalProvider(props.agent.provider))
const controlBusy = shallowRef(false)
const controlError = shallowRef<{ taskId: string; message: string } | null>(null)
watch(() => props.agent?.id, () => { prompt.value = ''; replyTarget.value = null; newConversation.value = false; error.value = ''; activeTaskId.value = ''; confirmRemove.value = false; copied.value = ''; autoApprove.value = false })
watch([() => displayedTask.value?.id, () => displayedTask.value?.status, newConversation], () => {
  if (!newConversation.value && !prompt.value.trim() && !sending.value) {
    const task = displayedTask.value
    replyTarget.value = task && (task.status === 'failed' || (task.status === 'completed' && task.output.trim())) ? task : null
  }
}, { immediate: true })
watch(() => displayedTask.value?.id, async (id, _previous, onCleanup) => {
  copied.value = ''
  followingLatest.value = true
  ancestors.value = []
  historyError.value = ''
  historyLoading.value = false
  let current = true
  onCleanup(() => { current = false })
  if (!id || !displayedTask.value?.replyToId) return
  historyLoading.value = true
  try {
    const turns = await api<Task[]>(`/tasks/${id}/conversation`)
    if (current) ancestors.value = turns.slice(0, -1)
  } catch (cause) {
    if (current) historyError.value = cause instanceof Error ? cause.message : 'Riwayat percakapan gagal dimuat.'
  } finally {
    if (current) historyLoading.value = false
  }
}, { immediate: true })
watch([
  () => conversationTurns.value.at(-1)?.id,
  () => conversationTurns.value.at(-1)?.output,
  () => ancestors.value.length,
  historyLoading,
], () => {
  if (followingLatest.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight
}, { flush: 'post' })

function trackTranscriptScroll(): void {
  const element = transcript.value
  if (element) followingLatest.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48
}

function onPromptKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}

function reply(task: Task, continueTask = false): void {
  if (task.status === 'running' || (task.status === 'completed' && !task.output.trim()) || running.value || sending.value) return
  newConversation.value = false
  replyTarget.value = task
  activeTaskId.value = task.id
  if (continueTask && !prompt.value.trim()) prompt.value = 'Lanjutkan task ini dari progres terakhir. Periksa keadaan workspace sebelum melanjutkan; jangan menganggap pekerjaan yang terhenti sudah selesai.'
  void nextTick(() => promptInput.value?.focus())
}

function startNewConversation(): void {
  newConversation.value = true
  replyTarget.value = null
  autoApprove.value = false
  error.value = ''
  void nextTick(() => promptInput.value?.focus())
}

async function submit(): Promise<void> {
  if (!props.agent || running.value || sending.value || !prompt.value.trim()) return
  const agentId = props.agent.id
  sending.value = true
  error.value = ''
  try {
    const task = await api<Task>('/tasks', { method: 'POST', body: JSON.stringify({ agentId, prompt: prompt.value.trim(), replyToId: replyTarget.value?.id ?? null, autoApprove: local.value && autoApprove.value }) })
    if (props.agent?.id === agentId) {
      activeTaskId.value = task.id
      followingLatest.value = true
      prompt.value = ''
      autoApprove.value = false
      newConversation.value = false
      replyTarget.value = task
    }
    emit('started', task)
  } catch (cause) {
    if (props.agent?.id === agentId) error.value = cause instanceof Error ? cause.message : 'Task gagal dikirim.'
  } finally {
    sending.value = false
  }
}

async function cancelTask(): Promise<void> {
  const task = runningTask.value
  if (!task || controlBusy.value) return
  controlBusy.value = true
  controlError.value = null
  try {
    const updated = await api<Task>(`/tasks/${task.id}/cancel`, { method: 'POST' })
    emit('updated', updated)
  } catch (cause) {
    controlError.value = { taskId: task.id, message: cause instanceof Error ? cause.message : 'Task gagal dihentikan.' }
  } finally {
    controlBusy.value = false
  }
}

async function copy(task: Task): Promise<void> {
  try {
    await navigator.clipboard.writeText(task.output)
    copied.value = task.id
  } catch {
    error.value = 'Clipboard tidak tersedia. Pilih dan salin teks jawaban secara manual.'
  }
}
</script>

<template>
  <aside class="task-panel" aria-label="Panel tugas">
    <header class="panel-heading"><div class="section-title"><Icon name="spark" :size="17" /><h2>Agent workspace</h2></div><span class="tiny-tag">PERSONAL DESK</span></header>
    <template v-if="agent">
      <p v-if="local && agent.workspace" class="workspace-bar" :title="agent.workspace"><Icon name="folder" :size="14" /><span>Workspace</span><code>{{ agent.workspace }}</code></p>
      <details :key="agent.id" class="profile-accordion">
        <summary class="profile-summary"><span>Profil agent</span><Icon name="chevron" :size="15" /></summary>
      <section class="agent-profile">
        <span class="profile-avatar" :style="{ '--agent-color': agent.color }">{{ agent.name.slice(0, 1).toUpperCase() }}<i :class="{ working: running }" /></span>
        <h3>{{ agent.name }}</h3>
        <div class="agent-settings">
          <button type="button" class="text-button" :disabled="running || sending" @click="emit('edit', agent.id)">Edit agent</button>
          <template v-if="confirmRemove">
            <p>Putus kontrak dengan {{ agent.name }}? Agent, daftar Todo, dan seluruh riwayat tugasnya akan dihapus.</p>
            <button class="text-button danger" :disabled="running || sending" @click="emit('remove', agent.id); confirmRemove = false">Ya, putus kontrak</button>
            <button class="text-button" @click="confirmRemove = false">Batal</button>
          </template>
          <button v-else class="text-button danger" :disabled="running || sending" @click="confirmRemove = true"><Icon name="trash" :size="13" />Putus kontrak</button>
        </div>
        <span class="provider-tag">{{ provider?.label }} <span>·</span> {{ agent.model || (local ? 'Model default CLI' : '') }}</span><p>{{ agent.role }}</p><template v-if="local"><p class="workspace-path"><strong>Workspace</strong><br />{{ agent.workspace }}</p><p class="tools-warning">Tools penuh: dapat menjalankan perintah dan membaca/mengubah file di luar workspace. Bukan sandbox; tidak semua tindakan meminta izin.</p></template><span class="availability" :class="{ 'is-working': running }"><i />{{ runningTask?.activity || (running ? 'Sedang mengerjakan task' : 'Siap untuk ide berikutnya') }}</span>
      </section>
      </details>
      <section class="task-results" aria-label="Percakapan task">
        <div class="section-title result-heading"><Icon name="link" :size="16" /><h2>Percakapan task</h2><button type="button" class="text-button new-chat" :disabled="sending" @click="startNewConversation"><Icon name="plus" :size="13" />Task baru</button></div>
        <select v-if="agentTasks.length" v-model="activeTaskId" aria-label="Pilih riwayat task" :disabled="sending" @change="newConversation = false"><option value="">Task terbaru</option><option v-for="task in agentTasks" :key="task.id" :value="task.id">{{ task.status === 'failed' ? 'Gagal · ' : '' }}{{ task.prompt.slice(0, 50) }} · #{{ task.id.slice(0, 8) }}</option></select>
        <p v-if="historyLoading && !newConversation" class="composer-note" role="status">Memuat riwayat percakapan…</p>
        <p v-if="historyError && !newConversation" class="error-notice" role="alert">{{ historyError }}</p>
        <div ref="transcript" class="chat-transcript" role="log" aria-label="Pesan percakapan task" aria-live="polite" aria-relevant="additions" @scroll="trackTranscriptScroll">
          <article v-for="turn in conversationTurns" :key="turn.id" class="conversation-turn">
            <div class="chat-message user-message">
              <span class="message-author">Anda <span :title="turn.id">· #{{ turn.id.slice(0, 8) }}</span></span>
              <p class="message-text">{{ turn.prompt }}</p>
            </div>
            <div class="chat-message agent-message">
              <span class="message-author">{{ agent.name }} <span>· {{ turn.status === 'running' ? 'Bekerja' : turn.status === 'failed' ? 'Terhenti' : 'Selesai' }}</span></span>
              <p v-if="turn.status === 'failed'" class="error-notice" role="alert">{{ turn.error }}</p>
              <span v-if="turn.status === 'failed' && turn.output" class="composer-note">Output parsial sebelum berhenti</span>
              <pre v-if="turn.output" class="message-text">{{ turn.output }}</pre>
              <div v-if="turn.status === 'running'" class="thinking" role="status"><span class="typing-dots"><i /><i /><i /></span>{{ turn.activity || 'Agent sedang mengerjakan…' }}</div>
              <div class="message-actions">
                <button v-if="turn.status === 'failed'" type="button" class="text-button" :disabled="running || sending" @click="reply(turn, true)">Lanjutkan task</button>
                <button v-else-if="turn.status === 'completed' && turn.output.trim()" type="button" class="text-button" :disabled="running || sending" @click="reply(turn)">Balas</button>
                <button v-if="turn.output" type="button" class="text-button" @click="copy(turn)"><Icon :name="copied === turn.id ? 'check' : 'copy'" :size="13" />{{ copied === turn.id ? 'Tersalin' : 'Salin' }}</button>
              </div>
            </div>
          </article>
          <div v-if="!conversationTurns.length" class="results-empty"><Icon name="spark" :size="26" /><p>Mulai percakapan baru.</p><span>Tulis pesan di bawah untuk memberi tugas pada {{ agent.name }}.</span></div>
        </div>
      </section>
      <section v-if="runningTask" class="task-controls" aria-label="Kontrol task berjalan">
        <p class="control-task-label">Task berjalan: {{ runningTask.prompt }}</p>
        <p class="running-activity" role="status">{{ runningTask.activity || 'Sedang mengerjakan task' }}</p>
        <p v-if="runningTask.autoApprove" class="auto-approve-warning" role="status">Izinkan otomatis aktif untuk operasi file terverifikasi di dalam workspace. Akses di luar workspace, perintah/skrip, dan cakupan tidak jelas tetap meminta izin.</p>
        <button v-if="runningTask.permission" type="button" class="button permission-link" @click="emit('showPermission', runningTask.agentId)">Minta izin · Lihat detail di bawah kantor</button>
        <button type="button" class="text-button danger" :disabled="controlBusy" @click="cancelTask">{{ controlBusy ? 'Mengirim…' : 'Hentikan task' }}</button>
        <p class="stop-warning">Menghentikan proses tidak dapat membatalkan perubahan atau perintah yang sudah dijalankan.</p>
        <p v-if="controlError?.taskId === runningTask.id" class="error-notice" role="alert">{{ controlError.message }}</p>
      </section>
      <form class="task-form" @submit.prevent="submit">
        <div class="section-title"><Icon name="task" :size="16" /><label for="task-prompt">{{ replyTarget ? 'Chat task' : 'Task baru' }}</label></div>
        <div v-if="replyTarget" id="reply-context" class="reply-context" role="status">
          <strong :title="replyTarget.id">Melanjutkan task #{{ replyTarget.id.slice(0, 8) }}</strong>
          <p :title="replyTarget.prompt">{{ replyTarget.prompt.slice(0, 160) }}{{ replyTarget.prompt.length > 160 ? '…' : '' }}</p>
          <span>Riwayat task ini, termasuk error dan output parsial, disertakan sebagai konteks. Sesi tools lama tidak dipulihkan.</span>
          <button type="button" class="text-button" :disabled="sending" @click="startNewConversation">Task baru · Tanpa riwayat</button>
        </div>
        <p v-else id="new-task-context" class="composer-note">Percakapan baru tanpa riwayat task sebelumnya. Untuk melanjutkan, pilih task lalu klik Balas atau Lanjutkan task.</p>
        <textarea id="task-prompt" ref="promptInput" v-model="prompt" required maxlength="12000" rows="2" :disabled="running || sending" :aria-describedby="replyTarget ? 'reply-context' : 'new-task-context'" :placeholder="replyTarget ? 'Tulis pesan untuk melanjutkan task ini…' : 'Tulis pesan untuk task baru…'" @keydown="onPromptKeydown" />
        <div class="composer-footer"><span>Enter kirim · Shift+Enter baris baru</span><span>{{ prompt.length.toLocaleString('id-ID') }} / 12.000</span></div>
        <div v-if="local && !running" class="auto-approve-option">
          <label><input v-model="autoApprove" type="checkbox" :disabled="sending" aria-describedby="auto-approve-risk" /> Izinkan otomatis untuk task ini</label>
          <p id="auto-approve-risk" class="auto-approve-warning">Otomatis hanya untuk operasi file terverifikasi di dalam workspace. Akses di luar workspace, perintah/skrip, dan cakupan tidak jelas tetap meminta izin. Bukan sandbox CLI; tidak berlaku untuk task berikutnya.</p>
        </div>
        <button class="button primary full-width" :disabled="running || sending || !prompt.trim()">{{ running ? 'Agent sedang bekerja…' : sending ? 'Mengirim…' : replyTarget ? 'Kirim balasan' : 'Jalankan task baru' }}<Icon :name="running ? 'clock' : 'send'" :size="16" /></button>
        <p v-if="error" class="error-notice" role="alert">{{ error }}</p>
      </form>
    </template>
    <div v-else class="workspace-empty"><div class="empty-illustration"><Icon name="spark" :size="33" /></div><span class="eyebrow">ROOM FOR POSSIBILITIES</span><h3>Rekan kerja berikutnya,<br />mungkin AI.</h3><p>Tambahkan agent, pilih karakternya di kantor, lalu berikan tugas pertamanya.</p><div class="empty-steps"><span><b>01</b> Hubungkan provider</span><span><b>02</b> Beri peran & tugas</span><span><b>03</b> Lihat ide jadi nyata</span></div><div class="local-note"><Icon name="lock" :size="14" /> Private workspace · Local server</div></div>
  </aside>
</template>

<style scoped>
.chat-transcript { display: grid; gap: 20px; max-height: 55dvh; min-height: 140px; overflow-y: auto; overscroll-behavior: contain; padding: 16px 2px; }
.conversation-turn { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.chat-message { max-width: 94%; padding: 12px; border: 1px solid var(--border); border-radius: 14px; min-width: 0; }
.user-message { align-self: flex-end; background: var(--green-soft); border-bottom-right-radius: 4px; }
.agent-message { align-self: flex-start; background: var(--background); border-bottom-left-radius: 4px; }
.message-author { display: block; font-size: 10px; font-weight: 600; color: var(--green); margin-bottom: 7px; }
.message-author span { font-weight: 400; color: var(--muted); }
.message-text { font: inherit; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.message-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.message-actions:empty { display: none; }
.new-chat { margin-left: auto; flex-shrink: 0; }
.task-panel { display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); overflow-y: auto; min-height: 0; }.panel-heading { padding: 23px 22px; border-bottom: 1px solid var(--border); }.panel-heading .section-title { margin-bottom: 8px; }.tiny-tag { font-size: 8px; letter-spacing: 1.7px; color: var(--muted); padding-left: 25px; }
.profile-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 22px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px; font-weight: 600; }.profile-summary::-webkit-details-marker { display: none; }.profile-summary:focus-visible { outline: 2px solid var(--green); outline-offset: -3px; }.profile-accordion[open] > .profile-summary svg { transform: rotate(90deg); }
.agent-profile { text-align: center; padding: 25px 22px 22px; border-bottom: 1px solid var(--border); }.profile-avatar { display: inline-grid; place-items: center; position: relative; width: 58px; height: 58px; border-radius: 19px; background: var(--agent-color); color: #283b32; font-size: 26px; font-weight: 600; }.profile-avatar i { position: absolute; right: -2px; bottom: 0; width: 12px; height: 12px; border: 3px solid var(--surface); background: var(--green); border-radius: 50%; }.profile-avatar i.working { background: var(--amber); }h3 { font-size: 19px; letter-spacing: -.5px; margin: 13px 0 8px; }.provider-tag { font-size: 10px; color: var(--muted); overflow-wrap: anywhere; }.provider-tag span { padding: 0 4px; }.agent-profile p { font-size: 11px; line-height: 1.7; color: var(--muted); max-height: 72px; overflow-y: auto; }.availability { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; color: var(--green); background: var(--green-soft); border-radius: 20px; padding: 7px 10px; }.availability i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }.is-working { color: var(--amber); background: var(--amber-soft); }
.task-form { padding: 16px; border-top: 1px solid var(--border); position: sticky; bottom: 0; background: var(--surface); z-index: 1; }.task-form label { font-size: 12px; font-weight: 600; }.task-form textarea { margin-top: 12px; resize: vertical; font-size: 12px; padding: 12px; line-height: 1.7; max-height: 180px; }.composer-footer { display: flex; justify-content: space-between; gap: 5px; font-size: 8px; color: var(--muted); margin: 8px 0 12px; }.task-results { padding: 18px 16px 0; flex: 1; min-width: 0; }.result-heading { margin-bottom: 14px; }.task-results select { font-size: 11px; }.thinking { padding-top: 12px; text-align: center; font-size: 11px; color: var(--muted); }.typing-dots { display: flex; gap: 4px; justify-content: center; margin-bottom: 12px; }.typing-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--green); animation: bounce 1s infinite alternate; }.typing-dots i:nth-child(2) { animation-delay: .2s; }.typing-dots i:nth-child(3) { animation-delay: .4s; }@keyframes bounce { to { transform: translateY(-5px); opacity: .3; } }.results-empty { color: var(--muted); text-align: center; padding: 24px 0; }.results-empty p { font-size: 11px; }.results-empty span { font-size: 10px; }.agent-settings { margin: 0 0 12px; display: flex; justify-content: center; flex-wrap: wrap; gap: 12px; }.agent-settings p { font-size: 11px; width: 100%; margin: 0; max-height: none; }.workspace-empty { padding: 50px 26px 26px; margin: auto 0; }.empty-illustration { display: grid; place-items: center; width: 76px; height: 76px; border: 1px solid var(--border); background: var(--background); border-radius: 24px; color: var(--green); margin-bottom: 32px; transform: rotate(-6deg); }.workspace-empty h3 { font-size: 23px; line-height: 1.35; margin: 14px 0; }.workspace-empty>p { font-size: 12px; line-height: 1.9; color: var(--muted); }.empty-steps { display: grid; gap: 19px; margin-top: 32px; }.empty-steps span { font-size: 11px; }.empty-steps b { font-size: 10px; font-weight: 500; color: var(--muted); padding-right: 13px; }.local-note { display: flex; align-items: center; gap: 6px; font-size: 9px; color: var(--muted); margin-top: 60px; }
.agent-profile .workspace-path { max-height: none; overflow-wrap: anywhere; }.agent-profile .tools-warning { max-height: none; color: var(--amber); }.availability { max-width: 100%; overflow-wrap: anywhere; text-align: left; }.availability i { flex-shrink: 0; }.task-controls { padding: 18px 22px; border-bottom: 1px solid var(--border); }.control-task-label,.stop-warning { font-size: 10px; line-height: 1.7; color: var(--muted); }.control-task-label { max-height: 64px; overflow-y: auto; white-space: pre-wrap; }.running-activity { font-size: 11px; overflow-wrap: anywhere; }.permission-link { max-width: 100%; margin-bottom: 16px; border: 1px solid var(--amber); background: var(--amber-soft); color: var(--text); white-space: normal; text-align: left; }
.composer-note,.reply-context { font-size: 10px; line-height: 1.7; color: var(--muted); }.reply-context { margin-top: 10px; padding: 10px; background: var(--background); border: 1px solid var(--border); border-radius: 10px; overflow-wrap: anywhere; }.reply-context strong { color: var(--green); }.reply-context p { margin: 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.reply-context span { display: block; }.reply-context .text-button { margin-top: 6px; white-space: normal; text-align: left; }
.auto-approve-option { margin-bottom: 12px; }.auto-approve-option label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }.auto-approve-option input { width: auto; flex-shrink: 0; margin: 2px 0 0; accent-color: var(--green); }.auto-approve-warning { font-size: 10px; line-height: 1.7; color: var(--amber); margin: 8px 0; }
.workspace-bar { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; margin: 0; padding: 12px 22px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); }.workspace-bar svg { align-self: center; }.workspace-bar span { font-weight: 600; color: var(--text); }.workspace-bar code { min-width: 0; overflow-wrap: anywhere; font-size: 11px; color: var(--text); }
@media (prefers-reduced-motion: reduce) { .typing-dots i { animation: none; } }
</style>
