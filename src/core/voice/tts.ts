import { createStore } from '../store'

export interface VoiceSettings {
  voiceURI: string | null
  /** 0.5–1.5. Below 1 deepens the voice; 0.85 is the calibrated default. */
  pitch: number
  rate: number
  autoSpeak: boolean
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { voiceURI: null, pitch: 0.85, rate: 1.0, autoSpeak: false }

const SETTINGS_KEY = 'shreyan.voice'

function loadSettings(): VoiceSettings {
  try {
    return { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_VOICE_SETTINGS
  }
}

export const voiceSettings = createStore<VoiceSettings>(loadSettings())
voiceSettings.subscribe(() => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(voiceSettings.get()))
  } catch {
    // settings just won't persist
  }
})

export const speaking = createStore<boolean>(false)

export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
  voiceURI: string
}

const MALE = /\b(male|man|david|mark|guy|daniel|alex|fred|ravi|rishi|prabhat|madhur|hemant|aaron|arthur|george|james|thomas|oliver|tom|matthew|ryan|liam|christopher|eric|roger|brian|andrew|davis|jason|tony|reed|rocko|grandpa)\b/i
const FEMALE = /\b(female|woman|zira|susan|samantha|victoria|karen|moira|tessa|veena|heera|kalpana|swara|neerja|aria|jenny|hazel|catherine|fiona|kate|serena|allison|ava|lekha|ana|emma|michelle|sonia|libby|natasha|nicky|grandma|shelley|sandy|flo)\b/i

/**
 * Ranks system voices for the "calibrated masculine" profile. The Web Speech API exposes no gender
 * field, so we score by well-known voice names, then prefer the requested language and on-device
 * (localService) voices, which keep working offline.
 */
export function scoreVoice(v: VoiceLike, lang = 'en-IN'): number {
  let score = 0
  if (MALE.test(v.name)) score += 50
  if (FEMALE.test(v.name)) score -= 50
  const want = lang.toLowerCase()
  const have = v.lang.toLowerCase().replace('_', '-')
  if (have === want) score += 20
  else if (have.split('-')[0] === want.split('-')[0]) score += 10
  if (v.localService) score += 15
  if (/natural|neural|enhanced|premium/i.test(v.name)) score += 5
  return score
}

export function pickVoice<T extends VoiceLike>(voices: T[], lang = 'en-IN'): T | null {
  let best: T | null = null
  let bestScore = -Infinity
  for (const v of voices) {
    const s = scoreVoice(v, lang)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  return best
}

/** Turns Markdown into something pleasant to listen to. */
export function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' (code shown on screen) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits streamed text into speakable sentences as soon as each one is complete. */
export class SentenceChunker {
  private buffer = ''
  private inCode = false

  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    for (;;) {
      const fence = this.buffer.indexOf('```')
      const end = this.buffer.search(/[.!?।]\s|\n\n/)
      if (fence >= 0 && (end < 0 || fence < end)) {
        if (!this.inCode) {
          const before = this.buffer.slice(0, fence).trim()
          if (before) out.push(before)
          out.push('(code shown on screen)')
        }
        this.inCode = !this.inCode
        this.buffer = this.buffer.slice(fence + 3)
        continue
      }
      if (this.inCode || end < 0) break
      const sentence = this.buffer.slice(0, end + 1).trim()
      this.buffer = this.buffer.slice(end + 2)
      if (sentence) out.push(sentence)
    }
    return out
  }

  flush(): string {
    const rest = this.inCode ? '' : this.buffer.trim()
    this.buffer = ''
    this.inCode = false
    return rest
  }
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

let pending = 0

/** Queues one chunk of speech using the calibrated settings. */
export async function speak(text: string, lang = 'en-IN'): Promise<void> {
  if (!ttsSupported()) return
  const clean = stripForSpeech(text)
  if (!clean) return
  const voices = await getVoices()
  const s = voiceSettings.get()
  const voice = voices.find((v) => v.voiceURI === s.voiceURI) ?? pickVoice(voices, lang)
  const u = new SpeechSynthesisUtterance(clean)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  u.pitch = s.pitch
  u.rate = s.rate
  pending++
  speaking.set(true)
  const finish = () => {
    pending = Math.max(0, pending - 1)
    if (pending === 0) speaking.set(false)
  }
  u.onend = finish
  u.onerror = finish
  speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
  if (!ttsSupported()) return
  pending = 0
  speechSynthesis.cancel()
  speaking.set(false)
}

/** Speaks a streaming reply sentence by sentence, so audio starts before generation finishes. */
export function createStreamingSpeaker(lang = 'en-IN') {
  const chunker = new SentenceChunker()
  return {
    push(delta: string) {
      for (const s of chunker.push(delta)) void speak(s, lang)
    },
    end() {
      const rest = chunker.flush()
      if (rest) void speak(rest, lang)
    },
  }
}
