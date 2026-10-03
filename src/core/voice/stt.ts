import { createStore } from '../store'

export type SttMode = 'auto' | 'on-device' | 'browser'

export interface DictationState {
  listening: boolean
  transcribing: boolean
  interim: string
  engine: 'browser' | 'on-device' | null
  /** Whisper model download progress, 0..1, while first loading. */
  modelProgress: number | null
  error: string | null
}

export const dictation = createStore<DictationState>({
  listening: false,
  transcribing: false,
  interim: '',
  engine: null,
  modelProgress: null,
  error: null,
})

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null
}

export function browserSttAvailable(): boolean {
  return getSpeechRecognition() != null
}

export function onDeviceSttAvailable(): boolean {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

/**
 * Browser recognition (Chrome/Edge/Safari) streams audio to the vendor's servers and needs a network.
 * On-device uses Whisper in a worker: private and offline, but transcribes after you stop talking.
 */
export function resolveEngine(mode: SttMode, online = navigator.onLine): 'browser' | 'on-device' | null {
  if (mode === 'browser') return browserSttAvailable() ? 'browser' : null
  if (mode === 'on-device') return onDeviceSttAvailable() ? 'on-device' : null
  if (online && browserSttAvailable()) return 'browser'
  return onDeviceSttAvailable() ? 'on-device' : browserSttAvailable() ? 'browser' : null
}

const WHISPER_LANG: Record<string, string> = { en: 'english', hi: 'hindi' }

let worker: Worker | null = null
let reqId = 0
function whisper(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<{ type: string; fraction?: number }>) => {
      if (e.data.type === 'progress') dictation.set((s) => ({ ...s, modelProgress: e.data.fraction ?? null }))
    })
  }
  return worker
}

function transcribe(audio: Float32Array, lang: string): Promise<string> {
  const id = ++reqId
  const w = whisper()
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ type: string; id: number; text?: string; error?: string }>) => {
      if (e.data.id !== id) return
      w.removeEventListener('message', onMsg)
      if (e.data.type === 'result') resolve(e.data.text ?? '')
      else reject(new Error(e.data.error))
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ id, audio, language: WHISPER_LANG[lang.split('-')[0]] ?? null }, [audio.buffer])
  })
}

async function decodeTo16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 })
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    return buf.getChannelData(0).slice()
  } finally {
    void ctx.close()
  }
}

let stopFn: (() => Promise<string>) | null = null
let cancelFn: (() => void) | null = null

/** Starts listening. Call stopDictation() to get the final text. */
export async function startDictation(mode: SttMode = 'auto', lang = 'en-IN'): Promise<void> {
  if (stopFn) return
  const engine = resolveEngine(mode)
  if (!engine) {
    dictation.set((s) => ({ ...s, error: 'Speech input is not supported in this browser' }))
    return
  }
  dictation.set({ listening: true, transcribing: false, interim: '', engine, modelProgress: null, error: null })

  if (engine === 'browser') {
    const Rec = getSpeechRecognition()!
    const rec = new Rec()
    rec.lang = lang
    rec.interimResults = true
    rec.continuous = true
    let finalText = ''
    let resolveEnd: (() => void) | null = null
    const ended = new Promise<void>((r) => (resolveEnd = r))
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interim += r[0].transcript
      }
      dictation.set((s) => ({ ...s, interim: (finalText + interim).trim() }))
    }
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') dictation.set((s) => ({ ...s, error: `Speech error: ${e.error}` }))
    }
    rec.onend = () => resolveEnd?.()
    rec.start()
    stopFn = async () => {
      rec.stop()
      await ended
      return finalText.trim()
    }
    cancelFn = () => rec.abort()
    return
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    dictation.set((s) => ({ ...s, listening: false, error: 'Microphone permission denied' }))
    return
  }
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => chunks.push(e.data)
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()))
  recorder.start()
  whisper() // start loading the model while the user talks
  const release = () => stream.getTracks().forEach((t) => t.stop())
  stopFn = async () => {
    recorder.stop()
    await stopped
    release()
    dictation.set((s) => ({ ...s, listening: false, transcribing: true }))
    const audio = await decodeTo16k(new Blob(chunks, { type: recorder.mimeType }))
    return transcribe(audio, lang)
  }
  cancelFn = () => {
    recorder.stop()
    release()
  }
}

export async function stopDictation(): Promise<string> {
  const fn = stopFn
  stopFn = null
  cancelFn = null
  if (!fn) return ''
  try {
    return await fn()
  } catch (e) {
    dictation.set((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }))
    return ''
  } finally {
    dictation.set((s) => ({ ...s, listening: false, transcribing: false, interim: '' }))
  }
}

export function cancelDictation(): void {
  cancelFn?.()
  stopFn = null
  cancelFn = null
  dictation.set((s) => ({ ...s, listening: false, transcribing: false, interim: '' }))
}
