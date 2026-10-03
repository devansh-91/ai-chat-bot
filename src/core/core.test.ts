import { describe, expect, it } from 'vitest'
import { classifyDevice } from './llm/device'
import { ndjsonLines } from './llm/ollama'
import { buildPrompt } from './personas'
import { percentile, summarize, type TurnSample } from './telemetry'
import { pickVoice, scoreVoice, SentenceChunker, stripForSpeech } from './voice/tts'

describe('device tiering', () => {
  it('uses the CPU fallback without WebGPU', () => {
    expect(classifyDevice({ webgpu: false, shaderF16: false, maxBufferMB: 0, memoryGB: 8, mobile: false }).tier).toBe('cpu')
  })
  it('recommends 1.5B f16 on a capable laptop', () => {
    const r = classifyDevice({ webgpu: true, shaderF16: true, maxBufferMB: 2048, memoryGB: 8, mobile: false })
    expect(r).toEqual({ tier: 'high', recommendedModelKey: 'webllm:Qwen2.5-1.5B-Instruct-q4f16_1-MLC' })
  })
  it('falls back to f32 weights when shader-f16 is missing', () => {
    const r = classifyDevice({ webgpu: true, shaderF16: false, maxBufferMB: 1024, memoryGB: 4, mobile: true })
    expect(r.recommendedModelKey).toBe('webllm:Qwen2.5-1.5B-Instruct-q4f32_1-MLC')
  })
  it('uses 0.5B on low-memory phones', () => {
    expect(classifyDevice({ webgpu: true, shaderF16: true, maxBufferMB: 256, memoryGB: 2, mobile: true }).tier).toBe('low')
  })
})

describe('prompt building', () => {
  it('keeps the system prompt and most recent turns within budget', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `message ${i} `.repeat(40),
    }))
    const p = buildPrompt('tutor', history, 2048, 512)
    expect(p[0].role).toBe('system')
    expect(p[1].role).toBe('user')
    expect(p.at(-1)?.content).toBe(history.at(-1)?.content)
    expect(p.length).toBeLessThan(history.length)
  })
  it('always includes the latest message even if it is huge', () => {
    const p = buildPrompt('assistant', [{ role: 'user', content: 'x'.repeat(100_000) }], 2048)
    expect(p).toHaveLength(2)
  })
})

describe('telemetry stats', () => {
  it('computes percentiles like percentile_cont', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([10], 0.95)).toBe(10)
    expect(percentile([], 0.5)).toBeNull()
  })
  it('summarizes, excluding errors from latency', () => {
    const base = { provider: 'webllm', model: 'm', outputTokens: 10, at: 0 }
    const s: TurnSample[] = [
      { ...base, ttftMs: 300, totalMs: 1000, tokensPerSec: 20, error: null },
      { ...base, ttftMs: 900, totalMs: 2000, tokensPerSec: 10, error: null },
      { ...base, ttftMs: null, totalMs: 50, tokensPerSec: null, error: 'boom' },
    ]
    const r = summarize(s)
    expect(r.count).toBe(3)
    expect(r.errors).toBe(1)
    expect(r.underTargetRatio).toBe(0.5)
    expect(r.avgTokensPerSec).toBe(15)
  })
})

describe('voice', () => {
  const v = (name: string, lang = 'en-US', localService = true) => ({ name, lang, localService, voiceURI: name })
  it('prefers a male, local, Indian-English voice', () => {
    const voices = [v('Microsoft Zira - English (United States)'), v('Google UK English Male', 'en-GB', false), v('Microsoft Ravi - English (India)', 'en-IN')]
    expect(pickVoice(voices)?.name).toBe('Microsoft Ravi - English (India)')
  })
  it('penalizes known female voices', () => {
    expect(scoreVoice(v('Samantha'))).toBeLessThan(scoreVoice(v('Daniel')))
  })
  it('strips markdown for speech', () => {
    expect(stripForSpeech('## Title\n**bold** `x` [link](http://a.b)\n```js\ncode\n```')).toBe('Title bold x link (code shown on screen)')
  })
  it('chunks streamed text into sentences and skips code', () => {
    const c = new SentenceChunker()
    const out = [...c.push('Hello there. How are'), ...c.push(' you? Here:\n```py\nprint(1)\n'), ...c.push('```\nDone')]
    expect(out).toEqual(['Hello there.', 'How are you?', 'Here:', '(code shown on screen)'])
    expect(c.flush()).toBe('Done')
  })
})

describe('ollama stream parsing', () => {
  it('reassembles NDJSON split across chunks', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(enc.encode('{"a":1}\n{"b"'))
        ctl.enqueue(enc.encode(':2}\n{"c":3}'))
        ctl.close()
      },
    })
    const lines: string[] = []
    for await (const l of ndjsonLines(body)) lines.push(l)
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })
})
