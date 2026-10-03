import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

// On-device speech-to-text. ~40 MB model, cached by the browser after first use.
const MODEL = 'onnx-community/whisper-tiny'

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

function load() {
  asr ??= pipeline('automatic-speech-recognition', MODEL, {
    progress_callback: (p: { status: string; progress?: number; file?: string }) => {
      if (p.status === 'progress') self.postMessage({ type: 'progress', fraction: (p.progress ?? 0) / 100, file: p.file })
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>
  return asr
}

self.onmessage = async (e: MessageEvent<{ id: number; audio: Float32Array; language: string | null }>) => {
  const { id, audio, language } = e.data
  try {
    const transcriber = await load()
    const out = await transcriber(audio, { language: language ?? undefined, task: 'transcribe' })
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
    self.postMessage({ type: 'result', id, text: text.trim() })
  } catch (err) {
    self.postMessage({ type: 'error', id, error: err instanceof Error ? err.message : String(err) })
  }
}
