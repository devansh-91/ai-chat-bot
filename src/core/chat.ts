import { currentOwnerId, requestSync } from './auth'
import { GUEST_OWNER } from './config'
import { db, type LocalMessage } from './db'
import { generate, modelState } from './llm/engine'
import { buildPrompt } from './personas'
import { createStore } from './store'
import { recordTurn } from './telemetry'

export interface StreamingState {
  /** conversationId -> partial assistant text while generating. */
  partial: Record<string, string>
  errors: Record<string, string | null>
}

export const streaming = createStore<StreamingState>({ partial: {}, errors: {} })

const controllers = new Map<string, AbortController>()

export async function createConversation(persona = 'assistant'): Promise<string> {
  const now = Date.now()
  const id = crypto.randomUUID()
  await db.conversations.add({
    id,
    ownerId: currentOwnerId(),
    title: null,
    persona,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    dirty: 1,
  })
  requestSync()
  return id
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await db.conversations.update(id, { title: title.trim().slice(0, 120) || null, updatedAt: Date.now(), dirty: 1 })
  requestSync()
}

export async function setConversationPersona(id: string, persona: string): Promise<void> {
  await db.conversations.update(id, { persona, updatedAt: Date.now(), dirty: 1 })
  requestSync()
}

/** Signed-in: leaves a content-free tombstone that syncs the deletion. Guest: deletes outright. */
export async function deleteConversation(id: string): Promise<void> {
  stopGeneration(id)
  await db.transaction('rw', db.conversations, db.messages, async () => {
    await db.messages.where('conversationId').equals(id).delete()
    const conv = await db.conversations.get(id)
    if (!conv) return
    if (conv.ownerId === GUEST_OWNER) await db.conversations.delete(id)
    else await db.conversations.update(id, { deletedAt: Date.now(), title: null, updatedAt: Date.now(), dirty: 1 })
  })
  requestSync()
}

export function stopGeneration(conversationId: string): void {
  controllers.get(conversationId)?.abort()
}

export function isGenerating(conversationId: string): boolean {
  return controllers.has(conversationId)
}

function setPartial(conversationId: string, text: string | null) {
  streaming.set((s) => {
    const partial = { ...s.partial }
    if (text == null) delete partial[conversationId]
    else partial[conversationId] = text
    return { ...s, partial }
  })
}

function setError(conversationId: string, error: string | null) {
  streaming.set((s) => ({ ...s, errors: { ...s.errors, [conversationId]: error } }))
}

/**
 * Appends the user's message, streams the assistant reply, and stores it with its latency metrics.
 * `onDelta` lets callers (e.g. text-to-speech) consume tokens as they arrive.
 */
export async function sendMessage(
  conversationId: string,
  text: string,
  onDelta?: (delta: string) => void,
): Promise<LocalMessage | null> {
  const content = text.trim()
  if (!content || controllers.has(conversationId)) return null
  const conv = await db.conversations.get(conversationId)
  if (!conv || conv.deletedAt) throw new Error('Conversation not found')
  const { spec, device } = modelState.get()
  if (!spec || modelState.get().status !== 'ready') throw new Error('Load a model first')

  const now = Date.now()
  await db.messages.add({
    id: crypto.randomUUID(),
    conversationId,
    ownerId: conv.ownerId,
    role: 'user',
    content,
    model: null,
    createdAt: now,
    dirty: 1,
  })
  await db.conversations.update(conversationId, {
    title: conv.title ?? content.replace(/\s+/g, ' ').slice(0, 60),
    updatedAt: now,
    dirty: 1,
  })
  requestSync()

  const history = await db.messages.where('[conversationId+createdAt]').between([conversationId, 0], [conversationId, Infinity]).toArray()
  const prompt = buildPrompt(conv.persona, history, spec.contextTokens)

  const controller = new AbortController()
  controllers.set(conversationId, controller)
  setError(conversationId, null)
  setPartial(conversationId, '')
  let partial = ''
  try {
    const { text: reply, metrics } = await generate(prompt, {
      signal: controller.signal,
      onToken: (delta) => {
        partial += delta
        setPartial(conversationId, partial)
        onDelta?.(delta)
      },
    })
    await recordTurn(metrics, { ownerId: conv.ownerId, device })
    if (!reply.trim()) return null
    const message: LocalMessage = {
      id: crypto.randomUUID(),
      conversationId,
      ownerId: conv.ownerId,
      role: 'assistant',
      content: reply.trim(),
      model: spec.modelId,
      createdAt: Date.now(),
      dirty: 1,
      metrics,
    }
    await db.messages.add(message)
    await db.conversations.update(conversationId, { updatedAt: message.createdAt, dirty: 1 })
    requestSync()
    return message
  } catch (e) {
    const aborted = controller.signal.aborted
    if (aborted && partial.trim()) {
      // Keep what was generated before the user pressed stop.
      await db.messages.add({
        id: crypto.randomUUID(),
        conversationId,
        ownerId: conv.ownerId,
        role: 'assistant',
        content: partial.trim(),
        model: spec.modelId,
        createdAt: Date.now(),
        dirty: 1,
      })
      requestSync()
    }
    if (!aborted) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(conversationId, msg)
      await recordTurn(
        { provider: spec.provider, model: spec.modelId, ttftMs: null, totalMs: Date.now() - now, outputTokens: 0, tokensPerSec: null },
        { ownerId: conv.ownerId, device, error: msg },
      )
    }
    return null
  } finally {
    controllers.delete(conversationId)
    setPartial(conversationId, null)
  }
}
