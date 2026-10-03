export type DeviceTier = 'high' | 'mid' | 'low' | 'cpu'

export interface DeviceProfile {
  webgpu: boolean
  shaderF16: boolean
  /** GPU max buffer size in MB (0 when no WebGPU). */
  maxBufferMB: number
  /** navigator.deviceMemory (GB, coarse and capped at 8 by browsers), null if unsupported. */
  memoryGB: number | null
  mobile: boolean
  tier: DeviceTier
  recommendedModelKey: string
}

export interface DeviceSignals {
  webgpu: boolean
  shaderF16: boolean
  maxBufferMB: number
  memoryGB: number | null
  mobile: boolean
}

/** Pure tier classification, kept separate from browser probing so it can be unit tested. */
export function classifyDevice(s: DeviceSignals): { tier: DeviceTier; recommendedModelKey: string } {
  if (!s.webgpu) {
    return { tier: 'cpu', recommendedModelKey: 'wllama:qwen2.5-0.5b-instruct-q4_k_m' }
  }
  const mem = s.memoryGB ?? (s.mobile ? 4 : 8)
  const suffix = s.shaderF16 ? 'q4f16_1' : 'q4f32_1'
  if (!s.mobile && mem >= 8 && s.maxBufferMB >= 1024 && s.shaderF16) {
    return { tier: 'high', recommendedModelKey: `webllm:Qwen2.5-1.5B-Instruct-${suffix}-MLC` }
  }
  if (mem >= 4 && s.maxBufferMB >= 256) {
    return { tier: 'mid', recommendedModelKey: `webllm:Qwen2.5-1.5B-Instruct-${suffix}-MLC` }
  }
  return { tier: 'low', recommendedModelKey: `webllm:Qwen2.5-0.5B-Instruct-${suffix}-MLC` }
}

export function isMobileUA(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
}

type NavigatorWithMemory = Navigator & { deviceMemory?: number; gpu?: GPU }

let cached: Promise<DeviceProfile> | null = null

export function detectDevice(): Promise<DeviceProfile> {
  cached ??= (async () => {
    const nav = navigator as NavigatorWithMemory
    let webgpu = false
    let shaderF16 = false
    let maxBufferMB = 0
    try {
      const adapter = await nav.gpu?.requestAdapter()
      if (adapter) {
        webgpu = true
        shaderF16 = adapter.features.has('shader-f16')
        maxBufferMB = Math.floor(adapter.limits.maxBufferSize / (1024 * 1024))
      }
    } catch {
      // WebGPU present but unusable (blocklisted driver etc.) -> CPU tier.
    }
    const signals: DeviceSignals = {
      webgpu,
      shaderF16,
      maxBufferMB,
      memoryGB: nav.deviceMemory ?? null,
      mobile: isMobileUA(nav.userAgent),
    }
    return { ...signals, ...classifyDevice(signals) }
  })()
  return cached
}
