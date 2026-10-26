<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, shallowRef } from 'vue'
import { api } from './api'
import AgentDialog from './AgentDialog.vue'
import Icon from './Icon.vue'
import OfficeScene from './OfficeScene.vue'
import TaskPanel from './TaskPanel.vue'
import PermissionStory from './PermissionStory.vue'
import { DEFAULT_SEATS, MAX_SEATS, PROVIDERS } from './types'
import type { Agent, AgentSettings, Task, TodoPrompt } from './types'

const PipelinePage = defineAsyncComponent(() => import('./PipelinePage.vue'))
const MeetingPage = defineAsyncComponent(() => import('./MeetingPage.vue'))
const pipeline = shallowRef(window.location.hash === '#pipeline')
const meeting = shallowRef(window.location.hash === '#meeting')
const office = computed(() => !pipeline.value && !meeting.value)
const todos = shallowRef<TodoPrompt[]>([])
function syncPage(): void {
  pipeline.value = window.location.hash === '#pipeline'
  meeting.value = window.location.hash === '#meeting'
  if (!office.value) window.scrollTo(0, 0)
}

const agents = shallowRef<Agent[]>([])
const tasks = shallowRef<Task[]>([])
const selectedId = shallowRef<string | null>(null)
const adding = shallowRef(false)
const editingAgent = shallowRef<AgentSettings | undefined>()
const loadingAgent = shallowRef(false)
const help = shallowRef(false)
const error = shallowRef('')
const connected = shallowRef(false)
const loading = shallowRef(true)
const seats = shallowRef(DEFAULT_SEATS)
const seatBusy = shallowRef(false)
const search = shallowRef('')
const activityFilter = shallowRef<'all' | 'running'>('all')
const selectedAgent = computed(() => agents.value.find((agent) => agent.id === selectedId.value) ?? null)
const working = computed(() => tasks.value.filter((task) => task.status === 'running'))
const completed = computed(() => tasks.value.filter((task) => task.status === 'completed').length)
const waitingPermissions = computed(() => working.value.filter((task) => task.permission))
const filteredAgents = computed(() => agents.value.filter((agent) => `${agent.name} ${agent.role}`.toLowerCase().includes(search.value.toLowerCase())))
const activeIds = computed(() => new Set(working.value.map((task) => task.agentId)))
const recentActivity = computed(() => (activityFilter.value === 'running' ? working.value : tasks.value).slice(0, 4))
const dateLabel = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let revision = 0
const controller = new AbortController()

function providerLabel(provider: string): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider
}
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
function agentName(id: string): string {
  return agents.value.find((agent) => agent.id === id)?.name ?? 'Agent'
}
function taskTime(date: string): string {
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(date))
}
function statusLabel(task: Task): string {
  return task.status === 'running' ? 'Bekerja' : task.status === 'completed' ? 'Selesai' : 'Gagal'
}
async function refresh(): Promise<void> {
  const currentRevision = revision
  try {
    const [nextAgents, nextTasks, nextTodos, office] = await Promise.all([
      api<Agent[]>('/agents', { signal: controller.signal }),
      api<Task[]>('/tasks', { signal: controller.signal }),
      api<TodoPrompt[]>('/todos', { signal: controller.signal }),
      api<{ seats: number }>('/office', { signal: controller.signal }),
    ])
    if (stopped || revision !== currentRevision) return
    agents.value = nextAgents
    tasks.value = nextTasks
    todos.value = nextTodos
    seats.value = office.seats
    if (!selectedId.value && nextAgents[0]) selectedId.value = nextAgents[0].id
    connected.value = true
    error.value = ''
  } catch (cause) {
    if (stopped) return
    connected.value = false
    error.value = cause instanceof Error ? cause.message : 'Kantor belum terhubung ke server.'
  } finally {
    loading.value = false
    if (!stopped) timer = setTimeout(() => { void refresh() }, 1500)
  }
}
function savedAgent(agent: Agent): void {
  revision++
  agents.value = agents.value.some((item) => item.id === agent.id) ? agents.value.map((item) => item.id === agent.id ? agent : item) : [...agents.value, agent]
  selectedId.value = agent.id
  adding.value = false
  editingAgent.value = undefined
}
async function setSeats(next: number): Promise<void> {
  if (seatBusy.value) return
  seatBusy.value = true
  try {
    const office = await api<{ seats: number }>('/office', { method: 'PUT', body: JSON.stringify({ seats: next }), signal: controller.signal })
    revision++
    seats.value = office.seats
  } catch (cause) {
    if (!stopped) error.value = cause instanceof Error ? cause.message : 'Jumlah bangku gagal disimpan.'
  } finally {
    seatBusy.value = false
  }
}
async function editAgent(id: string): Promise<void> {
  if (loadingAgent.value || adding.value) return
  loadingAgent.value = true
  try {
    const settings = await api<AgentSettings>(`/agents/${id}`, { signal: controller.signal })
    if (stopped || adding.value) return
    editingAgent.value = settings
    adding.value = true
  } catch (cause) {
    if (!stopped) error.value = cause instanceof Error ? cause.message : 'Konfigurasi agent gagal dimuat.'
  } finally {
    loadingAgent.value = false
  }
}
function started(task: Task): void {
  revision++
  todos.value = todos.value.filter((todo) => todo.id !== task.id)
  tasks.value = [task, ...tasks.value.filter((item) => item.id !== task.id)]
}
function updated(task: Task): void {
  revision++
  tasks.value = tasks.value.map((item) => item.id === task.id ? task : item)
}
function queued(todo: TodoPrompt): void {
  revision++
  todos.value = [...todos.value.filter((item) => item.id !== todo.id), todo]
}
function showPermission(id: string): void {
  selectedId.value = id
  document.getElementById('permission-story')?.focus({ preventScroll: true })
  document.getElementById('permission-story')?.scrollIntoView({ block: 'nearest' })
}
async function remove(id: string): Promise<void> {
  try {
    await api<null>(`/agents/${id}`, { method: 'DELETE' })
    revision++
    agents.value = agents.value.filter((agent) => agent.id !== id)
    tasks.value = tasks.value.filter((task) => task.agentId !== id)
    todos.value = todos.value.filter((todo) => todo.agentId !== id)
    selectedId.value = agents.value[0]?.id ?? null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Agent gagal dihapus.'
  }
}
onMounted(() => { window.addEventListener('hashchange', syncPage); void refresh() })
onUnmounted(() => { stopped = true; clearTimeout(timer); controller.abort(); window.removeEventListener('hashchange', syncPage) })
</script>

<template>
  <div class="app-shell">
    <nav class="nav-rail" aria-label="Navigasi utama"><a href="#office" class="brand-mark" aria-label="Ruang home">r<span>.</span></a><div class="rail-links"><a class="rail-link" :class="{ active: office }" :aria-current="office ? 'page' : undefined" href="#office" aria-label="Kantor" title="Kantor"><Icon name="grid" /></a><a class="rail-link" :class="{ active: pipeline }" :aria-current="pipeline ? 'page' : undefined" href="#pipeline" aria-label="Pipeline task" title="Pipeline task"><Icon name="task" /></a><a class="rail-link" :class="{ active: meeting }" :aria-current="meeting ? 'page' : undefined" href="#meeting" aria-label="Meeting suara" title="Meeting suara"><Icon name="mic" /></a><a class="rail-link" href="#team" aria-label="Tim agent" title="Tim agent"><Icon name="people" /></a><a class="rail-link" href="#activity" aria-label="Aktivitas tugas" title="Aktivitas tugas"><Icon name="clock" /></a></div><div class="rail-bottom"><button class="rail-link" aria-label="Panduan penggunaan" title="Panduan penggunaan" :aria-expanded="help" @click="help = !help"><Icon name="help" /></button><span class="user-avatar" title="Local workspace">Y</span></div></nav>
    <div class="app-main">
      <header class="topbar"><div class="breadcrumb"><span class="wordmark">ruang<span>.</span></span><span class="breadcrumb-divider">/</span><span class="workspace-label">My workspace</span><span class="workspace-badge">PERSONAL</span></div><div class="topbar-right"><span class="connection" :class="{ offline: !connected }"><i />{{ connected ? 'Local server connected' : loading ? 'Menghubungkan…' : 'Server offline' }}</span><span class="topbar-line" /><span class="date-label">{{ dateLabel }}</span></div></header>
      <div v-if="help" class="help-panel"><div>
        <h2>Selamat datang di Ruang.</h2>
        <p>1. Tambahkan provider API/Ollama untuk jawaban teks, atau OMP/Hermes/Codex yang sudah terpasang dan login di server untuk agent lokal dengan tools.<br />2. Klik karakter atau nama agent, lalu tulis tugas di panel kanan. Profil agent dapat dibuka atau dilipat melalui accordion di atas form task.<br />3. Saat task berjalan, label di atas kepala NPC menampilkan tindakannya. Penanda Minta izin atau badge ! berarti ada persetujuan yang menunggu. Pilih NPC untuk meninjau detail dan menjawab lewat dialog story di bawah kantor; jika beberapa NPC meminta izin, pilih nama pada antrean dialog. Output dan riwayat tetap berada di panel tugas.</p>
        <p>Untuk mengubah agent, buka Profil agent lalu Edit agent. Formnya sama dengan tambah agent dan sudah terisi konfigurasi lama. Simpan perubahan mempertahankan ID serta riwayat task. Key lama tidak ditampilkan; biarkan kosong untuk mempertahankannya hanya jika provider dan Base URL tetap sama. Mengganti tujuan API memerlukan key baru. Edit hanya tersedia ketika agent tidak sedang bekerja.</p>
        <p>Percakapan task tampil sebagai chat: pesan Anda di kanan, jawaban agent di kiri, dan kotak balasan di bawah. Enter mengirim pesan; Shift+Enter membuat baris baru. Pesan berikutnya melanjutkan task terpilih; saat error klik Lanjutkan task. Tombol Balas pada pesan lama membuat cabang dari pesan itu. Task baru memulai percakapan terpisah tanpa riwayat. Agent lokal dapat bekerja lebih dari 10 menit selama ada progres; batas 10 menit hanya dihitung tanpa aktivitas dan dijeda saat menunggu persetujuan. OMP/Hermes/Codex tetap membuka sesi CLI baru dengan transkrip saat membalas, bukan memulihkan sesi tools/browser lama.</p>
        <p>Buka Pipeline task di navigasi untuk menyiapkan daftar prompt dalam Todo. Pilih agent, simpan prompt, lalu klik Jalankan pada kartunya saat agent siap. Kartu mengikuti status nyata ke Progress, Selesai, atau Gagal; aktivitas, hasil, error, dan dialog izin tersedia langsung di halaman Pipeline. Todo tidak dijalankan otomatis dan izin tools tetap manual.</p>
        <p>Buka Meeting suara (ikon mikrofon di navigasi) untuk bicara dengan satu agent atau semua agent. Ucapanmu diubah jadi teks lalu dikirim, dan jawabannya dibacakan. Gunakan Chrome, Edge, atau Safari; Brave dan Firefox tidak mendukung pengenalan suara. Audio diproses oleh penyedia browser. Pilih karakter agent di form Tambah agent atau Edit agent. Untuk agent lokal, klik Pilih folder untuk memilih direktori workspace lewat dialog folder; folder tiap agent tampil di daftar tim dan di atas panel tugas.</p>
        <p>Dialog izin OMP punya Izinkan sekali dan Izinkan tool untuk sesi ini. Pilihan sesi berlaku untuk semua panggilan tool itu sampai task selesai, termasuk di luar workspace, dan tidak berlaku untuk task berikutnya.</p>
        <p>Provider API hanya mengirim request AI teks, tanpa akses terminal atau file. OMP/Hermes memakai autentikasi CLI, workspace absolut, dan persetujuan akses tools penuh: dapat menjalankan perintah serta membaca/mengubah file di luar workspace. Workspace bukan sandbox dan tidak semua tindakan meminta izin. Default izin manual: izinkan sekali atau tolak. Centang Izinkan otomatis untuk task ini sebelum mengirim task lokal untuk menyetujui hanya operasi file dengan seluruh target terverifikasi di dalam workspace. Akses di luar workspace, perintah/skrip, browser, dan cakupan yang tidak jelas tetap meminta izin. Opsi tidak diwariskan ke task/balasan berikutnya dan tidak memberi izin permanen. Menghentikan task tidak membatalkan perubahan yang sudah terjadi.</p>
        <p>Claude Code lokal memakai login claude auth login di terminal server, bukan API key; izin tindakan tetap lewat dialog di kantor. Untuk memakai akun ChatGPT tanpa API key, pilih Codex · Login ChatGPT dan jalankan codex login di terminal server terlebih dahulu. Kuota mengikuti akun; jalur ini hanya untuk aplikasi lokal/pribadi. Codex memakai kebijakan workspace-write/unlessTrusted; permintaan izin yang diteruskan tetap manual jika cakupan file di dalam workspace tidak dapat diverifikasi. Langganan Claude Pro/Max bukan API key; login Claude.ai di aplikasi pihak ketiga memerlukan persetujuan Anthropic dan tidak ditawarkan Ruang.</p>
        <p>Drag untuk memutar kantor, klik kanan atau tombol panah untuk menggeser, scroll untuk zoom ke arah kursor. Tombol − dan + di header kantor mengatur jumlah bangku (1–24); bangku tidak bisa kurang dari jumlah agent. Base URL custom harus OpenAI-compatible. Hapus agent juga menghapus Todo dan riwayatnya. Gunakan hanya di komputer tepercaya.</p>
      </div><button class="icon-button" aria-label="Tutup panduan" @click="help = false"><Icon name="close" /></button></div>
      <div v-if="error" class="global-error" role="alert"><span>{{ error }}</span><button class="text-button" @click="error = ''">Tutup</button></div>
      <KeepAlive><PipelinePage v-if="pipeline" :agents="agents" :tasks="tasks" :todos="todos" :connected="connected" @queued="queued" @started="started" @updated="updated" /></KeepAlive>
      <KeepAlive><MeetingPage v-if="meeting" :agents="agents" :tasks="tasks" :connected="connected" @started="started" @updated="updated" /></KeepAlive>
      <div v-show="office" class="workspace-layout">
        <aside id="team" class="team-panel" tabindex="-1"><header class="team-heading"><div class="section-title"><Icon name="people" :size="17" /><h2>Your team</h2><span class="count">{{ agents.length }}</span></div><button class="icon-button add-small" aria-label="Tambah agent" :disabled="agents.length >= seats || !connected" @click="adding = true"><Icon name="plus" :size="17" /></button></header><div class="team-label"><span>OFFICE MEMBERS</span><span>{{ agents.length }}/{{ seats }}</span></div><input v-if="agents.length > 3" v-model="search" class="team-search" aria-label="Cari agent" placeholder="Cari anggota tim…" />
          <div class="team-members"><button v-for="agent in filteredAgents" :key="agent.id" class="agent-card" :class="{ selected: selectedId === agent.id }" @click="selectedId = agent.id"><span class="mini-avatar" :style="{ '--agent-color': agent.color }">{{ agent.name.slice(0, 1).toUpperCase() }}<i :class="{ working: activeIds.has(agent.id) }" /></span><span class="agent-card-info"><strong>{{ agent.name }}</strong><span>{{ providerLabel(agent.provider) }}</span><span v-if="agent.workspace" class="agent-workspace" :title="agent.workspace"><Icon name="folder" :size="10" />{{ folderName(agent.workspace) }}</span></span><Icon name="chevron" :size="13" /></button><div v-if="!agents.length" class="team-empty"><span class="empty-team-icon"><Icon name="people" :size="22" /></span><h3>{{ loading ? 'Menyiapkan kantor…' : 'Tim hebat dimulai di sini.' }}</h3><p>Berbagai AI.<br />Satu ruang untuk berkolaborasi.</p></div><p v-else-if="!filteredAgents.length" class="no-search">Agent tidak ditemukan.</p><button class="add-agent-dashed" :disabled="agents.length >= seats || !connected" @click="adding = true"><Icon name="plus" :size="16" />{{ agents.length >= seats ? 'Semua meja terisi' : 'Tambah agent' }}</button></div>
          <div class="team-bottom"><div class="provider-logos"><span>O</span><span>✳</span><span>G</span><span>+</span></div><h3>Your favorite AI.<br />Now, your teammates.</h3><p>OpenAI, Anthropic, Gemini,<br />Ollama, OMP, Hermes, Codex, Claude Code, Antigravity, dan lainnya.</p><button class="text-button" @click="help = true">Cara kerjanya<Icon name="arrow" :size="13" /></button><div class="private-label"><Icon name="lock" :size="12" /> Credentials stay on your server</div></div>
        </aside>
        <main id="office" class="office-main" tabindex="-1">
          <section class="welcome-row"><div><div class="eyebrow"><span class="small-line" /> THE WORKSPACE, REIMAGINED</div><h1>Your AI, <span>at work.</span></h1><p>Ruang kecil untuk ide-ide besar. Selamat datang di kantormu.</p></div><button class="button primary" aria-label="Tambah agent" :disabled="agents.length >= seats || !connected" @click="adding = true"><Icon name="plus" :size="16" /><span>Tambah agent</span></button></section>
          <section class="metrics" aria-label="Statistik kantor"><div class="metric"><span class="metric-icon"><Icon name="people" :size="18" /></span><div><span>Anggota tim</span><strong>{{ String(agents.length).padStart(2, '0') }}<small>/ {{ seats }} meja</small></strong></div></div><div class="metric"><span class="metric-icon amber"><Icon name="spark" :size="18" /></span><div><span>Sedang bekerja</span><strong>{{ String(working.length).padStart(2, '0') }}<small>{{ working.length ? 'Making things happen' : 'Ready when you are' }}</small></strong></div></div><div class="metric"><span class="metric-icon sage"><Icon name="check" :size="18" /></span><div><span>Task selesai</span><strong>{{ String(completed).padStart(2, '0') }}<small>di 100 task terakhir</small></strong></div></div></section>
          <section class="office-card" :class="{ 'has-permission': waitingPermissions.length }" aria-label="Kantor virtual 3D">
            <header class="office-card-header"><div><span class="floor-dot" /><strong>The main office</strong><span class="floor-tag">FLOOR 01</span></div><div class="header-tools"><div class="seat-control" role="group" aria-label="Jumlah bangku"><span>Bangku</span><button type="button" aria-label="Kurangi bangku" :disabled="seatBusy || !connected || seats <= Math.max(1, agents.length)" @click="setSeats(seats - 1)">−</button><output aria-live="polite">{{ seats }}</output><button type="button" aria-label="Tambah bangku" :disabled="seatBusy || !connected || seats >= MAX_SEATS" @click="setSeats(seats + 1)">+</button></div><span class="live-tag"><i />LIVE OFFICE</span></div></header>
            <div class="scene-wrapper"><OfficeScene v-if="office" :agents="agents" :tasks="tasks" :selected-id="selectedId" :seats="seats" @select="selectedId = $event" /><div v-if="!agents.length" class="scene-welcome"><span class="welcome-dot" /><span>Meja sudah siap. Tinggal ajak timmu masuk.</span></div></div>
            <PermissionStory v-if="office" :agents="agents" :tasks="tasks" :selected-id="selectedId" @select="selectedId = $event" @updated="updated" />
            <footer class="office-card-footer"><div class="scene-legend"><span><i class="legend-ready" />Siap bekerja</span><span><i class="legend-working" />Sedang bekerja</span><span v-if="waitingPermissions.length" class="permission-legend">! {{ waitingPermissions.length }} minta izin</span></div><span class="scene-hint">Drag putar <b>·</b> Klik kanan geser <b>·</b> Scroll zoom</span></footer>
          </section>
          <section id="activity" class="activity-section" tabindex="-1"><header class="activity-heading"><div class="section-title"><Icon name="clock" :size="16" /><h2>Office activity</h2></div><div class="activity-tabs"><button :class="{ chosen: activityFilter === 'all' }" @click="activityFilter = 'all'">Terbaru</button><button :class="{ chosen: activityFilter === 'running' }" @click="activityFilter = 'running'">Berjalan<span v-if="working.length">{{ working.length }}</span></button></div></header><div v-if="!recentActivity.length" class="activity-empty"><span class="activity-empty-icon"><Icon name="leaf" :size="22" /></span><div><strong>{{ activityFilter === 'running' ? 'Semuanya sedang rehat.' : 'A fresh start. A world of possibilities.' }}</strong><p>{{ activityFilter === 'running' ? 'Tidak ada task yang sedang berjalan.' : 'Aktivitas tim akan muncul setelah kamu memberikan tugas pertama.' }}</p></div><span class="activity-note">LET’S MAKE SOMETHING GOOD</span></div><div v-else class="activity-list"><button v-for="task in recentActivity" :key="task.id" class="activity-item" @click="selectedId = task.agentId"><span class="activity-status-icon" :class="task.status"><Icon :name="task.status === 'completed' ? 'check' : task.status === 'failed' ? 'close' : 'clock'" :size="16" /></span><span class="activity-description"><strong>{{ agentName(task.agentId) }}</strong><span>{{ task.prompt }}</span></span><span class="status-pill" :class="task.status">{{ statusLabel(task) }}</span><time>{{ taskTime(task.createdAt) }}</time></button></div></section>
          <footer class="workspace-footer"><span><span class="wordmark small">ruang.</span> A little more human. A lot more possible.</span><span>BUILT FOR YOUR NEXT BIG IDEA <Icon name="spark" :size="12" /></span></footer>
        </main>
        <TaskPanel :agent="selectedAgent" :tasks="tasks" @started="started" @updated="updated" @remove="remove" @edit="editAgent" @show-permission="showPermission" />
      </div>
    </div>
    <AgentDialog v-if="adding" :agent="editingAgent" @close="adding = false; editingAgent = undefined" @saved="savedAgent" />
  </div>
</template>

<style scoped>
.office-card.has-permission { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); }
.office-card.has-permission .scene-wrapper { flex: 1 1 auto; height: clamp(180px, 30dvh, 420px); min-height: 160px; }
.office-card-header, .office-card-footer { flex-shrink: 0; }
.agent-workspace { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.permission-legend { color: var(--amber); font-weight: 700; }
.header-tools { display: flex; align-items: center; gap: 14px; }
.seat-control { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.seat-control span { margin-right: 4px; opacity: .75; }
.seat-control output { min-width: 2ch; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
.seat-control button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; font: inherit; line-height: 1; cursor: pointer; }
.seat-control button:hover:not(:disabled) { background: var(--border); }
.seat-control button:disabled { opacity: .4; cursor: not-allowed; }
.seat-control button:focus-visible { outline: 2px solid var(--accent, #54745c); outline-offset: 2px; }
@media (max-width: 720px) { .has-permission .scene-hint { display: none; } .has-permission .scene-legend { flex-wrap: wrap; } }
</style>
