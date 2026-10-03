/**
 * Public UI API. Screens should only import from here (and from core types), so the UI can be
 * redesigned freely without touching models, sync, voice, or security code.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { describeActivity, reportTyping, setPresencePage, track } from '../core/activity'
import {
  adminApi,
  applyPresence,
  expirePresence,
  sortLiveUsers,
  subscribeActivity,
  type ActivityEvent,
  type ActivityStats,
  type AdminOverview,
  type AdminUser,
  type AuditEntry,
  type LatencyBucket,
  type LiveUser,
  type ModelLatencyRow,
} from '../core/admin'
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

export { PERSONAS, RETENTION_DAYS, LATENCY_TARGET_MS, CLOUD_ENABLED, describeActivity }
export type { LocalConversation, LocalMessage, ModelSpec, LiveUser, ActivityEvent, ActivityStats }

// ───────────── presence reporting (for the admin activity monitor) ─────────────
/** Call from the router whenever the path changes. Ids are stripped before anything is sent. */
export function usePageReporting(pathname: string): void {
  useEffect(() => {
    setPresencePage(pathname)
    void track('page_view', { page: pathname.replace(/\/c\/[^/]+/, '/c/:id') })
  }, [pathname])
}

/** Call on composer input so admins see "typing". Never sends the text itself. */
export { reportTyping }

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
      const msg = await sendMessage(conversationId, text, speaker ? (d) => speaker.push(d) : undefined, { spoken: autoSpeak })
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
    speak: (text: string) => {
      void track('voice_output')
      return speak(text)
    },
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

// ───────────── admin: live activity monitor ─────────────
export interface LiveActivityOptions {
  windowHours?: number
  /** Only show this user's events. */
  userId?: string | null
  /** Only show this event kind (e.g. 'reply'). */
  kind?: string | null
  maxEvents?: number
}

/**
 * Who is online and what they are doing, updated in real time.
 * Activity is metadata only: admins never see message text.
 */
export function useLiveActivity({ windowHours = 24, userId = null, kind = null, maxEvents = 200 }: LiveActivityOptions = {}) {
  const [users, setUsers] = useState<LiveUser[]>([])
  const [feed, setFeed] = useState<ActivityEvent[]>([])
  const [stats, setStats] = useState<ActivityStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [tick, setTick] = useState(0)
  const usersRef = useRef(users)
  useEffect(() => {
    usersRef.current = users
  }, [users])

  // Initial load + whenever filters change.
  useEffect(() => {
    let alive = true
    const since = new Date(Date.now() - windowHours * 3600_000)
    Promise.all([adminApi.liveUsers(), adminApi.activityFeed({ since, userId, kind, limit: maxEvents }), adminApi.activityStats(since)])
      .then(([u, f, st]) => {
        if (!alive) return
        setUsers(sortLiveUsers(u))
        setFeed(f)
        setStats(st)
        setError(null)
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [windowHours, userId, kind, maxEvents, tick])

  // Realtime: new events stream into the feed, presence changes update the user list.
  useEffect(() => {
    if (!CLOUD_ENABLED) return
    return subscribeActivity({
      onStatus: setLive,
      onEvent: (row) => {
        if ((userId && row.user_id !== userId) || (kind && row.kind !== kind)) return
        const u = usersRef.current.find((x) => x.user_id === row.user_id)
        if (!u) setTick((t) => t + 1) // a new user appeared: reload the list
        const event: ActivityEvent = {
          ...row,
          email: u?.email ?? null,
          display_name: u?.display_name ?? null,
          avatar_url: u?.avatar_url ?? null,
        }
        setFeed((f) => (f.some((e) => e.id === event.id) ? f : [event, ...f].slice(0, maxEvents)))
        setUsers((prev) =>
          prev.map((x) =>
            x.user_id === row.user_id ? { ...x, last_event: row.kind, last_event_at: row.created_at, events_1h: x.events_1h + 1 } : x,
          ),
        )
        setStats((st) => (st ? { ...st, by_kind: { ...st.by_kind, [row.kind]: (st.by_kind[row.kind] ?? 0) + 1 } } : st))
      },
      onPresence: (row) => setUsers((prev) => sortLiveUsers(applyPresence(prev, row))),
    })
  }, [userId, kind, maxEvents])

  // Heartbeats stop when someone closes the app: age them out locally, refresh stats periodically.
  useEffect(() => {
    const expire = setInterval(() => setUsers((prev) => sortLiveUsers(expirePresence(prev))), 10_000)
    const refresh = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => {
      clearInterval(expire)
      clearInterval(refresh)
    }
  }, [])

  const online = users.filter((u) => u.online)
  return {
    /** All users, online first. */
    users,
    online,
    /** Newest first. Use describeActivity(e.kind, e.meta) for a readable line. */
    feed,
    stats: stats ? { ...stats, online_now: online.length } : null,
    /** true while the realtime connection is up. */
    live,
    error,
    reload: () => setTick((t) => t + 1),
  }
}
