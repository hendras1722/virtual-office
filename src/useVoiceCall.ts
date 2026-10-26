import { onBeforeUnmount, shallowRef, watch } from 'vue'

interface RecognitionResult { readonly isFinal: boolean; readonly [index: number]: { readonly transcript: string } }
interface RecognitionEvent extends Event { readonly resultIndex: number; readonly results: { readonly length: number; readonly [index: number]: RecognitionResult } }
interface RecognitionErrorEvent extends Event { readonly error: string }
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onaudiostart: (() => void) | null
  start: () => void
  abort: () => void
}
type RecognitionConstructor = new () => Recognition

export type CallLanguage = 'id-ID' | 'en-US'
export const CALL_LANGUAGES: { id: CallLanguage; label: string }[] = [{ id: 'id-ID', label: 'Indonesia' }, { id: 'en-US', label: 'English' }]

const SILENCE_MS = 1400
const RESTART_MS = 250
const NETWORK_RETRIES = 2
const NETWORK_RETRY_MS = 1500
const STALL_MS = 6000
const SPEECH_LIMIT = 1500
const CHUNK_LIMIT = 200

function recognizerConstructor(): RecognitionConstructor | undefined {
  const speechWindow = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

/** Turns an AI answer into text that is pleasant to hear: no code, markup or URLs, bounded in length. */
export function speechText(markdown: string, language: CallLanguage): string {
  const indonesian = language === 'id-ID'
  const text = markdown
    .replace(/```[\s\S]*?```/g, indonesian ? ' Blok kode dilewati. ' : ' Code block skipped. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]*[^\s).,;:!?]/g, indonesian ? 'tautan' : 'link')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= SPEECH_LIMIT) return text
  return `${text.slice(0, SPEECH_LIMIT).replace(/\s\S*$/, '')}… ${indonesian ? 'Selengkapnya ada di teks.' : 'The rest is in the text.'}`
}

/** Splits at sentence ends: Chrome silently stops utterances that run longer than about fifteen seconds. */
export function speechChunks(text: string): string[] {
  const chunks: string[] = []
  for (const sentence of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    const last = chunks.at(-1)
    if (last !== undefined && last.length + sentence.length <= CHUNK_LIMIT) chunks[chunks.length - 1] = last + sentence
    else chunks.push(sentence)
  }
  return chunks.map((chunk) => chunk.trim()).filter(Boolean)
}

/**
 * Meet-style call with one agent: mic on/off toggle, spoken sentences are transcribed with the browser's
 * speech recognition and handed to `send`, and answers can be read back. Listening pauses while the agent
 * works or speaks so the microphone never hears the answer.
 */
export function useVoiceCall(options: { send: (text: string) => Promise<void>; busy: () => boolean }) {
  const Recognizer = recognizerConstructor()
  const supported = Boolean(Recognizer)
  const active = shallowRef(false)
  const micOn = shallowRef(true)
  const speakReplies = shallowRef(true)
  const language = shallowRef<CallLanguage>('id-ID')
  const speaking = shallowRef(false)
  const listening = shallowRef(false)
  const caption = shallowRef('')
  const error = shallowRef('')
  let recognition: Recognition | null = null
  let finalText = ''
  let interimText = ''
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  // Chrome reports transient "network" errors on long sessions; retry a couple of times before giving up.
  let networkFailures = 0
  let restartDelay = RESTART_MS
  // Safari can sit "listening" forever when the site's microphone permission is blocked; surface that instead of staying silent.
  let stallTimer: ReturnType<typeof setTimeout> | undefined

  const shouldListen = (): boolean => active.value && micOn.value && !speaking.value && !options.busy()

  function flush(): void {
    clearTimeout(silenceTimer)
    const text = `${finalText} ${interimText}`.trim()
    finalText = interimText = caption.value = ''
    if (text) void options.send(text)
  }

  function stopListening(): void {
    clearTimeout(restartTimer)
    if (recognition) {
      recognition.onend = recognition.onresult = recognition.onerror = recognition.onaudiostart = null
      clearTimeout(stallTimer)
      recognition.abort()
      recognition = null
    }
    listening.value = false
  }

  function startListening(): void {
    if (recognition || !Recognizer || !shouldListen()) return
    const next = new Recognizer()
    next.lang = language.value
    next.continuous = true
    next.interimResults = true
    next.onaudiostart = () => {
      clearTimeout(stallTimer)
      if (error.value.startsWith('Mikrofon belum aktif')) error.value = ''
    }
    next.onresult = (event) => {
      error.value = ''
      networkFailures = 0
      restartDelay = RESTART_MS
      interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!
        if (result.isFinal) finalText = `${finalText} ${result[0]?.transcript ?? ''}`.trim()
        else interimText += result[0]?.transcript ?? ''
      }
      caption.value = `${finalText} ${interimText}`.trim()
      clearTimeout(silenceTimer)
      silenceTimer = setTimeout(flush, SILENCE_MS)
    }
    next.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (event.error === 'network' && ++networkFailures <= NETWORK_RETRIES) {
        restartDelay = NETWORK_RETRY_MS
        return
      }
      if (event.error === 'not-allowed') error.value = 'Izin mikrofon ditolak. Di Safari: menu Safari › Pengaturan › Situs Web › Mikrofon, ubah localhost menjadi Izinkan, lalu muat ulang. Di Chrome: ikon gembok di address bar › Mikrofon › Izinkan.'
      else if (event.error === 'service-not-allowed') error.value = 'Layanan pengenalan suara tidak diizinkan. Di Mac aktifkan Dictation (Pengaturan Sistem › Keyboard › Dictation) dan Siri, lalu coba lagi.'
      else if (event.error === 'language-not-supported') error.value = 'Bahasa ini belum didukung pengenalan suara browser. Coba ganti ke English.'
      else if (event.error === 'audio-capture') error.value = 'Mikrofon tidak ditemukan.'
      else if (event.error === 'network') error.value = 'Browser tidak bisa menghubungi layanan pengenalan suara penyedianya (Chrome memakai server Google), jadi ini bukan soal internet biasa. Brave, Chromium, dan Firefox tidak mendukungnya; VPN, proxy, firewall, atau pemblokir iklan/DNS juga dapat memblokirnya. Coba Chrome, Edge, atau Safari tanpa VPN.'
      else error.value = `Pengenalan suara gagal (kode: ${event.error}).`
      micOn.value = false
    }
    next.onend = () => {
      recognition = null
      listening.value = false
      clearTimeout(restartTimer)
      restartTimer = setTimeout(startListening, restartDelay)
    }
    recognition = next
    try {
      next.start()
      listening.value = true
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (recognition === next && !error.value) error.value = 'Mikrofon belum aktif setelah beberapa detik. Periksa izin mikrofon situs ini di browser dan input suara di Pengaturan Sistem › Suara.'
      }, STALL_MS)
    } catch {
      recognition = null
      error.value = 'Mikrofon tidak dapat dimulai. Coba matikan lalu nyalakan lagi.'
      micOn.value = false
    }
  }

  watch(shouldListen, (listen) => {
    if (listen) startListening()
    else {
      stopListening()
      if (!micOn.value) flush()
      else {
        finalText = interimText = caption.value = ''
        clearTimeout(silenceTimer)
      }
    }
  })
  watch(language, () => {
    stopListening()
    finalText = interimText = caption.value = ''
    clearTimeout(silenceTimer)
    startListening()
  })

  // Answers queue up: in a group meeting each agent's reply is read after the previous one.
  let pendingChunks = 0
  let generation = 0

  function stopSpeaking(): void {
    generation++
    pendingChunks = 0
    speechSynthesis.cancel()
    speaking.value = false
  }

  function speak(text: string): void {
    if (!active.value || !speakReplies.value) return
    const chunks = speechChunks(speechText(text, language.value))
    if (!chunks.length) return
    const voice = speechSynthesis.getVoices().find((entry) => entry.lang.replace('_', '-').startsWith(language.value.slice(0, 2)))
    const current = generation
    const finished = (): void => {
      if (current !== generation) return
      pendingChunks = Math.max(0, pendingChunks - 1)
      speaking.value = pendingChunks > 0
    }
    pendingChunks += chunks.length
    speaking.value = true
    for (const chunk of chunks) {
      const utterance = new SpeechSynthesisUtterance(chunk)
      utterance.lang = language.value
      if (voice) utterance.voice = voice
      utterance.onend = finished
      utterance.onerror = finished
      speechSynthesis.speak(utterance)
    }
  }

  function start(): void {
    if (!supported || active.value) return
    error.value = ''
    networkFailures = 0
    restartDelay = RESTART_MS
    micOn.value = true
    active.value = true
    startListening()
  }

  function end(): void {
    active.value = false
    stopListening()
    clearTimeout(silenceTimer)
    finalText = interimText = caption.value = ''
    stopSpeaking()
  }

  function toggleMic(): void {
    micOn.value = !micOn.value
    if (micOn.value) error.value = ''
  }

  function toggleSpeakReplies(): void {
    speakReplies.value = !speakReplies.value
    if (!speakReplies.value) stopSpeaking()
  }

  onBeforeUnmount(end)

  return { supported, active, micOn, speakReplies, language, speaking, listening, caption, error, start, end, toggleMic, toggleSpeakReplies, stopSpeaking, speak }
}
