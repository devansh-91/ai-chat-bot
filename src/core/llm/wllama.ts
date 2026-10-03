import { LoggerWithoutDebug, Wllama } from '@wllama/wllama'
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url'
import type { ChatMessage, GenerateOptions, GenerateResult, LoadProgress, ModelSpec, Provider } from './types'

/**
 * llama.cpp compiled to WebAssembly. Slowest tier, but runs on any modern browser, including
 * phones without WebGPU. Model files are cached in OPFS, so it works offline after first load.
 */
export class WllamaProvider implements Provider {
  readonly id = 'wllama' as const
  private wllama: Wllama | null = null
  private loadedModel: string | null = null

  async load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void> {
    if (!spec.hf) throw new Error(`${spec.key} has no Hugging Face source`)
    if (this.wllama && this.loadedModel === spec.modelId) return
    await this.unload()
    this.wllama = new Wllama({ default: wasmUrl }, { logger: LoggerWithoutDebug, allowOffline: true })
    await this.wllama.loadModelFromHF(spec.hf, {
      n_ctx: spec.contextTokens,
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
        onProgress({
          fraction: total ? loaded / total : null,
          text: `Downloading ${spec.label}: ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`,
        }),
    })
    this.loadedModel = spec.modelId
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions): Promise<GenerateResult> {
    if (!this.wllama) throw new Error('Model not loaded')
    const stream = await this.wllama.createChatCompletion({
      messages,
      stream: true,
      abortSignal: opts.signal,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 512,
    })
    let text = ''
    let outputTokens: number | null = null
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      if (delta) {
        text += delta
        opts.onToken?.(delta)
      }
      if (chunk.usage) outputTokens = chunk.usage.completion_tokens
    }
    return { text, outputTokens }
  }

  async unload(): Promise<void> {
    await this.wllama?.exit()
    this.wllama = null
    this.loadedModel = null
  }
}
