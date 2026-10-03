export type ProviderId = 'webllm' | 'wllama' | 'ollama'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelSpec {
  /** Unique id across providers, e.g. "webllm:Qwen2.5-1.5B-Instruct-q4f16_1-MLC". */
  key: string
  provider: ProviderId
  /** Provider-native model id. */
  modelId: string
  label: string
  /** Approximate one-time download, in MB (0 = not downloaded by the browser). */
  downloadMB: number
  contextTokens: number
  /** WebLLM only: requires the shader-f16 GPU feature. */
  needsF16?: boolean
  /** wllama only: Hugging Face repo + file. */
  hf?: { repo: string; file: string }
}

export interface LoadProgress {
  /** 0..1, or null when indeterminate. */
  fraction: number | null
  text: string
}

export interface GenerateOptions {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  onToken?: (delta: string) => void
}

export interface GenerateResult {
  text: string
  /** Provider-reported completion token count, if available. */
  outputTokens: number | null
}

export interface Provider {
  readonly id: ProviderId
  load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void>
  generate(messages: ChatMessage[], opts: GenerateOptions): Promise<GenerateResult>
  unload(): Promise<void>
}
