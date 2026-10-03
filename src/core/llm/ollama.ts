import { DEFAULT_OLLAMA_URL } from '../config'
import type { ChatMessage, GenerateOptions, GenerateResult, ModelSpec, Provider } from './types'

const URL_KEY = 'shreyan.ollamaUrl'

export function getOllamaUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_OLLAMA_URL
  } catch {
    return DEFAULT_OLLAMA_URL
  }
}

export function setOllamaUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url.replace(/\/+$/, ''))
  } catch {
    // storage unavailable; default URL stays in use
  }
}

/** Lists models installed in a reachable Ollama server, or [] if none is reachable. */
export async function listOllamaModels(baseUrl = getOllamaUrl()): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return []
    const body = (await res.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}

/** Streams NDJSON lines from a fetch response body. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield line
    }
  }
  if (buffer.trim()) yield buffer.trim()
}

/**
 * A local Ollama server (e.g. on the demo laptop). Not "in-browser", but still fully offline and free.
 * The server must allow the app's origin: OLLAMA_ORIGINS="https://<your-site>,http://localhost:*".
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama' as const
  private modelId: string | null = null

  async load(spec: ModelSpec): Promise<void> {
    const models = await listOllamaModels()
    if (!models.length) throw new Error(`No Ollama server reachable at ${getOllamaUrl()}`)
    if (!models.includes(spec.modelId)) {
      throw new Error(`Model ${spec.modelId} is not installed. Run: ollama pull ${spec.modelId}`)
    }
    this.modelId = spec.modelId
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions): Promise<GenerateResult> {
    if (!this.modelId) throw new Error('Model not loaded')
    const res = await fetch(`${getOllamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model: this.modelId,
        messages,
        stream: true,
        options: { temperature: opts.temperature ?? 0.7, num_predict: opts.maxTokens ?? 1024 },
      }),
    })
    if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}`)
    let text = ''
    let outputTokens: number | null = null
    for await (const line of ndjsonLines(res.body)) {
      const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; eval_count?: number; error?: string }
      if (chunk.error) throw new Error(chunk.error)
      const delta = chunk.message?.content ?? ''
      if (delta) {
        text += delta
        opts.onToken?.(delta)
      }
      if (chunk.done) outputTokens = chunk.eval_count ?? null
    }
    return { text, outputTokens }
  }

  async unload(): Promise<void> {
    this.modelId = null
  }
}
