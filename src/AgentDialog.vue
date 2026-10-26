<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, useTemplateRef, watch } from 'vue'
import { api } from './api'
import Icon from './Icon.vue'
import CharacterPreview from './CharacterPreview.vue'
import { CHARACTER_PRESETS, characterFromId, lookKey } from './character'
import { AGENT_COLORS, isLocalProvider, PROVIDERS } from './types'
import type { Agent, AgentCharacter, AgentDraft, AgentSettings, RuntimeStatus } from './types'

const props = defineProps<{ agent?: AgentSettings }>()
const emit = defineEmits<{ close: []; saved: [agent: Agent] }>()
const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const busy = shallowRef(false)
const error = shallowRef('')
const form = reactive<AgentDraft>({ name: props.agent?.name ?? '', role: props.agent?.role ?? 'Asisten AI yang teliti, membantu, dan menjawab dalam Bahasa Indonesia.', provider: props.agent?.provider ?? 'openai', model: props.agent?.model ?? PROVIDERS[0]!.model, color: props.agent?.color ?? AGENT_COLORS[0]!, apiKey: '', baseUrl: props.agent?.baseUrl ?? '', workspace: props.agent?.workspace ?? '', allowTools: props.agent?.allowTools ?? false })
// New agents start on a random preset; an agent that never chose a look is offered the one it already has in the office.
const initial: AgentCharacter = props.agent ? { ...(props.agent.character ?? characterFromId(props.agent.id)) } : { ...CHARACTER_PRESETS[Math.floor(Math.random() * CHARACTER_PRESETS.length)]! }
const character = reactive<AgentCharacter>({ ...initial })
const choices = props.agent && !CHARACTER_PRESETS.some((preset) => lookKey(preset) === lookKey(initial)) ? [initial, ...CHARACTER_PRESETS] : CHARACTER_PRESETS
function choose(look: AgentCharacter): void {
  Object.assign(character, look)
}
const provider = computed(() => PROVIDERS.find((item) => item.id === form.provider)!)
const picking = shallowRef(false)
const pickError = shallowRef('')
// Set when the server cannot show a native folder dialog; the path can then be typed instead.
const manualWorkspace = shallowRef(false)
async function chooseFolder(): Promise<void> {
  if (picking.value) return
  picking.value = true
  pickError.value = ''
  try {
    const result = await api<{ path: string | null }>('/pick-folder', { method: 'POST', body: '{}', signal: AbortSignal.timeout(310_000) })
    if (result.path) form.workspace = result.path
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Pemilih folder gagal dibuka.'
    if (message.startsWith('Pemilih folder')) manualWorkspace.value = true
    else pickError.value = message
  } finally {
    picking.value = false
  }
}
const local = computed(() => isLocalProvider(form.provider))
const runtimeStatus = shallowRef<RuntimeStatus | null>(null)
const runtimeLoading = shallowRef(false)
const runtimeError = shallowRef('')
const runtime = computed(() => runtimeStatus.value?.runtimes.find((item) => item.provider === form.provider))
const localReady = computed(() => !local.value || (!runtimeLoading.value && runtime.value?.available === true && form.allowTools))
const keepsApiKey = computed(() => !!props.agent?.hasApiKey && form.provider === props.agent.provider && form.baseUrl.trim().replace(/\/+$/, '') === props.agent.baseUrl)
watch(() => form.provider, async (selected, previous, onCleanup) => {
  if (previous !== undefined) {
    const original = props.agent?.provider === selected ? props.agent : undefined
    form.model = original?.model ?? provider.value.model
    form.baseUrl = original?.baseUrl ?? ''
    form.apiKey = ''
    form.workspace = original?.workspace ?? ''
    form.allowTools = original?.allowTools ?? false
  }
  error.value = ''
  runtimeStatus.value = null
  runtimeError.value = ''
  runtimeLoading.value = false
  if (!isLocalProvider(selected)) return
  const controller = new AbortController()
  let current = true
  onCleanup(() => { current = false; controller.abort() })
  runtimeLoading.value = true
  try {
    const status = await api<RuntimeStatus>('/runtimes', { signal: controller.signal })
    if (!current) return
    runtimeStatus.value = status
  } catch (cause) {
    if (current) runtimeError.value = cause instanceof Error ? cause.message : 'Status runtime gagal dimuat.'
  } finally {
    if (current) runtimeLoading.value = false
  }
}, { immediate: true })
onMounted(() => dialog.value?.showModal())

async function submit(): Promise<void> {
  if (busy.value || !localReady.value) return
  if (local.value && (!form.workspace || form.workspace.length > 2048)) {
    error.value = 'Pilih folder workspace terlebih dahulu.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const agent = await api<Agent>(props.agent ? `/agents/${props.agent.id}` : '/agents', { method: props.agent ? 'PUT' : 'POST', body: JSON.stringify({ ...form, character }) })
    form.apiKey = ''
    emit('saved', agent)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : props.agent ? 'Perubahan agent gagal disimpan.' : 'Agent gagal ditambahkan.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialog" class="agent-dialog" aria-labelledby="dialog-title" @cancel.prevent="!busy && emit('close')" @click="(event) => { if (event.target === dialog && !busy) emit('close') }">
    <form @submit.prevent="submit">
      <header class="dialog-header"><span class="dialog-symbol"><Icon name="people" :size="24" /></span><button class="icon-button" type="button" aria-label="Tutup dialog" :disabled="busy" @click="emit('close')"><Icon name="close" /></button></header>
      <p class="eyebrow">{{ agent ? 'YOUR COLLEAGUE' : 'A NEW COLLEAGUE' }}</p>
      <h2 id="dialog-title">{{ agent ? 'Edit agent.' : 'Kenalkan anggota tim baru.' }}</h2>
      <p class="muted">{{ agent ? 'Perbarui konfigurasi rekan kerja. Riwayat task tetap tersimpan.' : 'Hubungkan AI pilihanmu. Kami siapkan mejanya.' }}</p>
      <div class="form-row"><label>Nama agent<input v-model="form.name" autofocus required maxlength="40" placeholder="Mis. Luna, creative partner" autocomplete="off" /></label><label>Provider<select v-model="form.provider" :disabled="busy"><option v-for="item in PROVIDERS" :key="item.id" :value="item.id">{{ item.label }}</option></select></label></div>
      <div v-if="local" class="runtime-status" role="status" aria-live="polite">
        <p v-if="runtimeLoading">Memeriksa CLI di server lokal…</p>
        <p v-else-if="runtimeError" class="error-notice">{{ runtimeError }}</p>
        <p v-else-if="runtime">{{ runtime.available ? 'Executable ditemukan' : 'CLI tidak tersedia' }} · {{ runtime.message }}</p>
        <p v-else>CLI belum dapat diperiksa; konfigurasi agent belum bisa disimpan.</p>
        <template v-if="form.provider === 'codex'">
          <p>Gunakan akun ChatGPT lewat Codex CLI resmi, bukan API key. Di terminal komputer server, jalankan:</p>
          <code>codex login</code>
          <small>Selesaikan login di browser. Kuota mengikuti paket dan akses Codex akunmu. Mode ini menolak autentikasi API key; token login tetap dikelola Codex, tidak disalin ke Ruang. Hanya untuk aplikasi lokal/pribadi, bukan layanan hosted atau komersial.</small>
        </template>
        <template v-else-if="form.provider === 'claude'">
          <p>Memakai Claude Code resmi yang sudah login di komputer server, bukan API key. Di terminal server, jalankan:</p>
          <code>claude auth login</code>
          <small>Selesaikan login di browser. Kuota mengikuti paket akunmu. Ruang tidak menyentuh kredensial Claude dan menghapus ANTHROPIC_API_KEY/BASE_URL dari proses ini. Pengaturan, hook, dan plugin Claude Code di komputer ini tetap berlaku. Hanya untuk aplikasi lokal/pribadi. Model boleh alias (sonnet, opus) atau kosong untuk default CLI.</small>
        </template>
        <template v-else-if="form.provider === 'antigravity'">
          <p>Memakai Google Antigravity ACP di komputer server.</p>
          <small>Autentikasi akun Google/Gemini dikelola runtime Antigravity lokal. Model default mengikuti konfigurasi runtime (mis. gemini-3.8-flash-high).</small>
        </template>
        <small>Pastikan {{ form.provider }} --version berhasil dan CLI sudah login/setup di terminal server. Deteksi executable bukan pemeriksaan binari, login, atau kuota. Jika perlu, atur {{ form.provider.toUpperCase() }}_COMMAND ke path executable yang berfungsi, lalu mulai ulang server dan pilih kembali provider.</small>
      </div>
      <label>{{ local ? 'Model (opsional · default CLI jika kosong)' : 'Model' }}<input v-model="form.model" :required="!local" maxlength="150" :placeholder="local ? 'Kosongkan untuk model dari konfigurasi CLI' : 'ID model dari provider'" /></label>
      <template v-if="local">
        <div class="workspace-field">
          <label for="workspace-path">Direktori workspace</label>
          <div class="workspace-row">
            <input id="workspace-path" v-model="form.workspace" :readonly="!manualWorkspace" required maxlength="2048" :placeholder="manualWorkspace ? '/path/absolut/proyek' : 'Belum ada folder dipilih'" autocomplete="off" aria-describedby="workspace-help" />
            <button type="button" class="button folder-button" :disabled="busy || picking" @click="chooseFolder"><Icon name="folder" :size="15" />{{ picking ? 'Menunggu pilihan…' : form.workspace ? 'Ganti folder' : 'Pilih folder' }}</button>
          </div>
          <small id="workspace-help">{{ manualWorkspace ? 'Pemilih folder tidak tersedia di komputer server ini; ketik path absolut folder yang sudah ada.' : 'Dialog pilih folder akan terbuka di komputer server (komputer ini). Ini direktori kerja, bukan sandbox.' }}</small>
          <p v-if="pickError" class="error-notice" role="alert">{{ pickError }}</p>
        </div>
        <label class="tools-consent"><input v-model="form.allowTools" type="checkbox" required /><span>Saya mengizinkan akses tools penuh. Agent dapat menjalankan perintah serta membaca dan mengubah file, termasuk di luar workspace. Tidak semua tindakan meminta persetujuan; ini bukan sandbox.</span></label>
      </template>
      <template v-else>
        <label>API key <span v-if="form.provider === 'ollama' || keepsApiKey" class="optional">{{ keepsApiKey ? '(kosongkan untuk memakai key lama)' : '(opsional untuk lokal)' }}</span><input v-model="form.apiKey" type="password" :required="form.provider !== 'ollama' && !keepsApiKey" maxlength="1000" :placeholder="keepsApiKey ? 'Key lama tidak ditampilkan' : 'Key hanya dikirim ke server lokal'" autocomplete="new-password" /><small v-if="agent">Key lama dipertahankan hanya jika provider dan Base URL tetap sama. Untuk tujuan API berbeda, masukkan key baru.</small></label>
        <p v-if="form.provider === 'openai'" class="subscription-note">Langganan ChatGPT bukan API key OpenAI. <button type="button" class="text-button" :disabled="busy" @click="form.provider = 'codex'">Gunakan login ChatGPT lewat Codex</button></p>
        <p v-if="form.provider === 'anthropic'" class="subscription-note">Langganan Claude Pro/Max tidak menggantikan API key. Login/kuota Claude.ai untuk aplikasi pihak ketiga memerlukan persetujuan Anthropic; Ruang tidak menawarkan login tersebut. <a href="https://code.claude.com/docs/en/agent-sdk/overview" target="_blank" rel="noopener noreferrer">Ketentuan resmi Anthropic</a>.</p>
        <label v-if="form.provider === 'custom'">Base URL<input v-model="form.baseUrl" type="url" required placeholder="https://provider.example/v1" /><small>Endpoint OpenAI-compatible. Gunakan root versi, tanpa /chat/completions.</small></label>
      </template>
      <label>Peran & instruksi<textarea v-model="form.role" required maxlength="1000" rows="2" placeholder="Apa keahlian dan cara kerja agent ini?" /></label>
      <fieldset class="color-field"><legend>Warna karakter</legend><label v-for="(color, index) in AGENT_COLORS" :key="color" class="color-option" :style="{ '--agent-color': color }"><input v-model="form.color" type="radio" :value="color" :aria-label="`Warna karakter ${index + 1}`" /><span><Icon v-if="form.color === color" name="check" :size="16" /></span></label></fieldset>
      <fieldset class="character-field">
        <legend>Pilih karakter</legend>
        <div class="character-list">
          <button v-for="(choice, index) in choices" :key="lookKey(choice)" type="button" class="character-card" :class="{ chosen: lookKey(character) === lookKey(choice) }" :aria-label="`Karakter ${index + 1}`" :aria-pressed="lookKey(character) === lookKey(choice)" @click="choose(choice)">
            <CharacterPreview :character="choice" :shirt="form.color" />
          </button>
        </div>
      </fieldset>
      <div class="security-note"><Icon name="lock" :size="16" /><span>{{ local ? 'Memakai autentikasi CLI yang sudah ada di server. Hentikan task untuk membatalkan proses; perubahan yang sudah terjadi tidak dapat dibatalkan otomatis.' : 'Key tersimpan di database lokal server, tidak di browser. Gunakan hanya di komputer tepercaya.' }}</span></div>
      <p v-if="error" class="error-notice" role="alert">{{ error }}</p>
      <button class="button primary full-width" :disabled="busy || picking || !localReady || (local && !form.workspace)">{{ busy ? agent ? 'Menyimpan…' : 'Menyiapkan meja…' : agent ? 'Simpan perubahan' : 'Tambahkan ke kantor' }}<Icon name="arrow" :size="17" /></button>
      <p class="dialog-footnote">{{ local ? 'Login dan koneksi model diuji saat task dijalankan. Biaya mengikuti konfigurasi CLI.' : 'Koneksi diuji saat task pertama dijalankan. Biaya mengikuti provider.' }}</p>
    </form>
  </dialog>
</template>

<style scoped>
.agent-dialog { width: min(520px, calc(100% - 32px)); max-height: calc(100dvh - 40px); border: 1px solid var(--border); border-radius: 22px; padding: 28px; color: var(--text); background: var(--surface); box-shadow: 0 28px 100px #12261e30; }
.agent-dialog::backdrop { background: #15251f65; backdrop-filter: blur(6px); }
.dialog-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 22px; }
.dialog-symbol { padding: 12px; border-radius: 14px; background: var(--green-soft); color: var(--green); }
h2 { font-size: 25px; letter-spacing: -1px; margin: 10px 0; }.muted { font-size: 13px; margin-bottom: 24px; }
label { display: grid; gap: 8px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }small,.optional { color: var(--muted); font-size: 10px; font-weight: 400; }
.color-field { padding: 0; border: 0; display: flex; gap: 10px; margin: 4px 0 20px; }.color-field legend { font-size: 12px; font-weight: 600; margin-bottom: 10px; }.color-option { position: relative; margin: 0; }.color-option input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }.color-option span { display: grid; place-items: center; width: 30px; height: 30px; background: var(--agent-color); border-radius: 50%; color: #23372d; }.color-option:has(input:checked) { outline: 2px solid var(--green); outline-offset: 3px; border-radius: 50%; }.color-option:has(input:focus-visible) { outline: 3px solid var(--green); }
.security-note { display: flex; gap: 10px; align-items: center; background: var(--background); color: var(--muted); padding: 12px; border-radius: 10px; margin-bottom: 18px; font-size: 11px; line-height: 1.6; }.security-note svg { flex-shrink: 0; }.dialog-footnote { text-align: center; font-size: 10px; color: var(--muted); margin: 12px 0 0; }
.runtime-status { padding: 12px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 10px; overflow-wrap: anywhere; }.runtime-status p { font-size: 12px; margin: 0 0 8px; }.runtime-status small { display: block; line-height: 1.7; }.tools-consent { display: flex; align-items: start; gap: 10px; background: var(--amber-soft); padding: 12px; border-radius: 10px; line-height: 1.7; }.tools-consent input { width: 16px; height: 16px; padding: 0; margin: 3px 0 0; flex-shrink: 0; accent-color: var(--green); }
.subscription-note { font-size: 11px; line-height: 1.7; color: var(--muted); margin: 0 0 16px; }.subscription-note a { color: var(--green); text-decoration: underline; }.runtime-status code { display: block; margin: 8px 0; padding: 8px; background: var(--background); border-radius: 6px; }.runtime-status small + small { margin-top: 8px; }
.workspace-field { display: grid; gap: 8px; margin-bottom: 16px; }.workspace-field > label { margin: 0; }.workspace-row { display: flex; gap: 8px; }.workspace-row input { flex: 1; min-width: 0; text-overflow: ellipsis; }.workspace-row input[readonly] { cursor: default; background: var(--background); }.folder-button { flex-shrink: 0; border: 1px solid var(--border); background: var(--surface); color: var(--green); padding: 9px 12px; }.folder-button:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.character-field { padding: 0; border: 0; margin: 0 0 20px; min-width: 0; }.character-field legend { font-size: 12px; font-weight: 600; margin-bottom: 10px; }
.character-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; max-height: 280px; overflow-y: auto; padding: 3px; }
.character-card { display: grid; gap: 6px; justify-items: center; padding: 6px 6px 8px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); font-size: 11px; }.character-card:hover { background: var(--hover); }.character-card.chosen { border-color: var(--green); background: var(--green-soft); color: var(--green); font-weight: 600; }.character-card:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
@media (max-width: 480px) { .character-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 480px) { .agent-dialog { padding: 22px; }.form-row { grid-template-columns: 1fr; gap: 0; } }
</style>
