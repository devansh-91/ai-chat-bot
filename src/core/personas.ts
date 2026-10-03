import { APP_NAME } from './config'
import type { ChatMessage } from './llm/types'

export interface Persona {
  id: string
  label: string
  description: string
  system: string
}

const BASE = `You are ${APP_NAME}, a helpful AI assistant built by Shreyansh Mishra (B.Tech CSE, Amity University Lucknow). You run privately on the user's own device. Be accurate; if you are not sure, say so.`

export const PERSONAS: Persona[] = [
  { id: 'assistant', label: 'Assistant', description: 'General help', system: `${BASE} Answer clearly and helpfully. Use Markdown when it helps.` },
  { id: 'tutor', label: 'Tutor', description: 'Explains step by step', system: `${BASE} Act as a patient tutor for a first-year engineering student. Explain step by step, give a small example, and end with a one-line check-your-understanding question.` },
  { id: 'coder', label: 'Coder', description: 'Programming help', system: `${BASE} Act as a senior software engineer. Prefer working code in fenced code blocks with the language tag, then a brief explanation.` },
  { id: 'concise', label: 'Concise', description: 'Short answers, voice friendly', system: `${BASE} Answer in at most three short sentences with no Markdown, suitable for being read aloud.` },
  { id: 'hinglish', label: 'Hindi / Hinglish', description: 'Replies in Hindi or Hinglish', system: `${BASE} Reply in the same language the user writes in: Hindi (Devanagari) or Hinglish (Hindi in Latin script). Keep technical terms in English.` },
]

export function getPersona(id: string): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0]
}

/** Rough token estimate (≈4 chars/token for English; conservative enough for Hindi too at 3). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/**
 * Builds the prompt: system prompt + as many of the most recent turns as fit the context window,
 * leaving room for the reply. Always keeps the latest user message.
 */
export function buildPrompt(
  personaId: string,
  history: Pick<ChatMessage, 'role' | 'content'>[],
  contextTokens: number,
  replyTokens = 768,
): ChatMessage[] {
  const system: ChatMessage = { role: 'system', content: getPersona(personaId).system }
  let budget = contextTokens - replyTokens - estimateTokens(system.content)
  const kept: ChatMessage[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'system') continue
    const cost = estimateTokens(m.content) + 4
    if (cost > budget && kept.length > 0) break
    kept.unshift({ role: m.role, content: m.content })
    budget -= cost
  }
  // Models expect the conversation to start with a user turn.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift()
  return [system, ...kept]
}
