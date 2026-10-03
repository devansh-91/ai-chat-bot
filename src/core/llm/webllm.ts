import { CreateWebWorkerMLCEngine, type WebWorkerMLCEngine } from '@mlc-ai/web-llm'
import type { ChatMessage, GenerateOptions, GenerateResult, LoadProgress, ModelSpec, Provider } from './types'

/** WebGPU inference via MLC WebLLM, running in a dedicated worker so the UI never blocks. */
export class WebLLMProvider implements Provider {
  readonly id = 'webllm' as const
  private engine: WebWorkerMLCEngine | null = null
  private loadedModel: string | null = null

  async load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void> {
    const initProgressCallback = (r: { progress: number; text: string }) =>
      onProgress({ fraction: r.progress, text: r.text })
    if (this.engine) {
      if (this.loadedModel === spec.modelId) return
      this.engine.setInitProgressCallback(initProgressCallback)
      await this.engine.reload(spec.modelId)
    } else {
      const worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module' })
      this.engine = await CreateWebWorkerMLCEngine(worker, spec.modelId, { initProgressCallback })
    }
    this.loadedModel = spec.modelId
  }

  async generate(messages: ChatMessage[], opts: GenerateOptions): Promise<GenerateResult> {
    const engine = this.engine
    if (!engine) throw new Error('Model not loaded')
    const onAbort = () => engine.interruptGenerate()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = await engine.chat.completions.create({
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 1024,
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
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  async unload(): Promise<void> {
    await this.engine?.unload()
    this.loadedModel = null
  }
}
