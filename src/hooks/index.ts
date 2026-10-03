/**
 * Public UI API. Screens should only import from here (and from core types), so the UI can be
 * redesigned freely without touching models, sync, voice, or security code.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { adminApi, type AdminOverview, type AdminUser, type AuditEntry, type LatencyBucket, type ModelLatencyRow } from '../core/admin'
import { authState, signInWithGoogle, signOut } from '../core/auth'
import {
  createConversation,
  deleteConversation,
  renameConversation,
  sendMessage,
  setConversationPersona,
  stopGeneration,
  streaming,
} from '../core/chat'
import { CLOUD_ENABLED, LATENCY_TARGET_MS, RETENTION_DAYS } from '../core/config'
import { db, type LocalConversation, type LocalMessage } from '../core/db'
import { MODEL_CATALOG, ollamaSpec } from '../core/llm/catalog'
import { getSelectedModelKey, loadModel, modelState } from '../core/llm/engine'
import { listOllamaModels } from '../core/llm/ollama'
import type { ModelSpec } from '../core/llm/types'
import { PERSONAS } from '../core/personas'
import { expiresInMs } from '../core/privacy'
import { useStore } from '../core/store'
import { syncState } from '../core/sync'
import { recentTurns, summarize } from '../core/telemetry'
import { dictation, startDictation, stopDictation, cancelDictation, type SttMode } from '../core/voice/stt'
import { createStreamingSpeaker, getVoices, speak, speaking, stopSpeaking, voiceSettings, pickVoice } from '../core/voice/tts'

export { PERSONAS, RETENTION_DAYS, LATENCY_TARGET_MS, CLOUD_ENABLED }
export type { LocalConversation, LocalMessage, ModelSpec }

// ───────────── auth ─────────────
export function useAuth() {
  const s = useStore(authState)
  return {
    ...s,
    isAdmin: s.role === 'admin',
    cloudEnabled: CLOUD_ENABLED,
    signInWithGoogle,
    signOut,
  }
}

// ───────────── connectivity & sync ─────────────
function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

export function useSyncStatus() {
  const s = useStore(syncState)
  const pending = useLiveQuery(async () => (await db.conversations.where('dirty').equals(1).count()) + (await db.messages.where('dirty').equals(1).count()), [], 0)
  return { ...s, pending }
}

// ───────────── conversations ─────────────
export function useConversations() {
  const { user } = useStore(authState)
  const ownerId = user?.id ?? 'guest'
  const conversations = useLiveQuery(
    () =>
      db.conversations
        .where('[ownerId+updatedAt]')
        .between([ownerId, 0], [ownerId, Infinity])
        .reverse()
        .filter((c) => c.deletedAt == null)
        .toArray(),
    [ownerId],
  )
  return {
    conversations: conversations ?? [],
    loading: conversations === undefined,
    create: createConversation,
    rename: renameConversation,
    remove: deleteConversation,
    setPersona: setConversationPersona,
    /** ms until auto-purge for a conversation. */
    expiresIn: (c: LocalConversation) => expiresInMs(c.updatedAt),
  }
}

// ───────────── a single chat ─────────────
export function useChat(conversationId: string | null) {
  const conversation = useLiveQuery(() => (conversationId ? db.conversations.get(conversationId) : undefined), [conversationId])
  const messages = useLiveQuery(
    () =>
      conversationId
        ? db.messages.where('[conversationId+createdAt]').between([conversationId, 0], [conversationId, Infinity]).toArray()
        : [],
    [conversationId],
  )
  const stream = useStore(streaming)
  const { autoSpeak } = useStore(voiceSettings)
  const partial = conversationId ? stream.partial[conversationId] : undefined

  const send = useCallback(
    async (text: string) => {
      if (!conversationId) return null
      const speaker = autoSpeak ? createStreamingSpeaker() : null
      const msg = await sendMessage(conversationId, text, speaker ? (d) => speaker.push(d) : undefined)
      speaker?.end()
      return msg
    },
    [conversationId, autoSpeak],
  )

  return {
    conversation: conversation ?? null,
    messages: messages ?? [],
    /** Assistant text streamed so far (undefined when not generating). */
    streamingText: partial,
    isGenerating: partial !== undefined,
    error: conversationId ? (stream.errors[conversationId] ?? null) : null,
    send,
    stop: () => conversationId && stopGeneration(conversationId),
  }
}

// ───────────── models ─────────────
export function useModel() {
  const s = useStore(modelState)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const refreshOllama = useCallback(async () => setOllamaModels(await listOllamaModels()), [])
  useEffect(() => {
    void refreshOllama()
  }, [refreshOllama])

  const available: ModelSpec[] = useMemo(() => {
    const browser = MODEL_CATALOG.filter((m) => {
      if (m.provider === 'ollama') return false
      if (m.provider === 'webllm') return !!s.device?.webgpu && (!m.needsF16 || s.device.shaderF16)
      return true
    })
    return [...browser, ...ollamaModels.map(ollamaSpec)]
  }, [s.device, ollamaModels])

  return {
    ...s,
    available,
    recommendedKey: s.device?.recommendedModelKey ?? null,
    lastUsedKey: getSelectedModelKey(),
    load: loadModel,
    refreshOllama,
  }
}

// ───────────── telemetry HUD (this device, live) ─────────────
export function useTelemetryHud() {
  const samples = useStore(recentTurns)
  return { samples, last: samples.at(-1) ?? null, stats: summarize(samples), targetMs: LATENCY_TARGET_MS }
}

// ───────────── voice ─────────────
export function useVoice() {
  const settings = useStore(voiceSettings)
  const isSpeaking = useStore(speaking)
  const dict = useStore(dictation)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    void getVoices().then(setVoices)
  }, [])
  return {
    settings,
    updateSettings: (patch: Partial<typeof settings>) => voiceSettings.set((s) => ({ ...s, ...patch })),
    voices,
    autoVoice: pickVoice(voices),
    isSpeaking,
    speak: (text: string) => speak(text),
    stopSpeaking,
    dictation: dict,
    startDictation: (mode?: SttMode, lang?: string) => startDictation(mode, lang),
    stopDictation,
    cancelDictation,
  }
}

// ───────────── admin ─────────────
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    fn()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, loading: data === null && error === null, reload: () => setTick((t) => t + 1) }
}

export function useAdmin(windowHours = 24, refreshMs = 10_000) {
  const since = () => new Date(Date.now() - windowHours * 3600_000)
  const bucket = windowHours <= 1 ? 1 : windowHours <= 24 ? 15 : 60
  const overview = useAsync<AdminOverview>(() => adminApi.overview(), [])
  const byModel = useAsync<ModelLatencyRow[]>(() => adminApi.latencyByModel(since()), [windowHours])
  const series = useAsync<LatencyBucket[]>(() => adminApi.latencySeries(since(), bucket), [windowHours])
  const users = useAsync<AdminUser[]>(() => adminApi.users(), [])
  const audit = useAsync<AuditEntry[]>(() => adminApi.audit(), [])

  useEffect(() => {
    const t = setInterval(() => {
      overview.reload()
      byModel.reload()
      series.reload()
    }, refreshMs)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs])

  return {
    overview,
    byModel,
    series,
    users,
    audit,
    setRole: async (id: string, role: 'user' | 'admin') => {
      await adminApi.setRole(id, role)
      users.reload()
      audit.reload()
    },
    runPurge: async () => {
      const r = await adminApi.runPurge()
      overview.reload()
      audit.reload()
      return r
    },
  }
}
