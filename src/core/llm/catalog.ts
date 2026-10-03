import type { ModelSpec } from './types'

/**
 * Models that run entirely in the browser (after a one-time download, cached for offline use).
 * Ollama models are discovered at runtime from the local server (see ollamaSpec).
 */
export const MODEL_CATALOG: ModelSpec[] = [
  {
    key: 'webllm:Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    provider: 'webllm',
    modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 1.5B (GPU, recommended)',
    downloadMB: 1000,
    contextTokens: 4096,
    needsF16: true,
  },
  {
    key: 'webllm:Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    provider: 'webllm',
    modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5 1.5B (GPU, compatibility)',
    downloadMB: 1100,
    contextTokens: 4096,
  },
  {
    key: 'webllm:Qwen2.5-3B-Instruct-q4f16_1-MLC',
    provider: 'webllm',
    modelId: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 3B (GPU, high quality)',
    downloadMB: 1900,
    contextTokens: 4096,
    needsF16: true,
  },
  {
    key: 'webllm:Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    provider: 'webllm',
    modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 0.5B (GPU, lite)',
    downloadMB: 400,
    contextTokens: 4096,
    needsF16: true,
  },
  {
    key: 'webllm:Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    provider: 'webllm',
    modelId: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5 0.5B (GPU, lite, compatibility)',
    downloadMB: 450,
    contextTokens: 4096,
  },
  {
    key: 'wllama:qwen2.5-0.5b-instruct-q4_k_m',
    provider: 'wllama',
    modelId: 'qwen2.5-0.5b-instruct-q4_k_m',
    label: 'Qwen2.5 0.5B (CPU, works everywhere)',
    downloadMB: 400,
    contextTokens: 2048,
    hf: { repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf' },
  },
]

export function findModel(key: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.key === key)
}

/** Ollama models are discovered at runtime; this builds a spec for any of them. */
export function ollamaSpec(modelId: string): ModelSpec {
  return {
    key: `ollama:${modelId}`,
    provider: 'ollama',
    modelId,
    label: `Ollama ${modelId} (local server)`,
    downloadMB: 0,
    contextTokens: 8192,
  }
}
