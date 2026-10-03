import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PERSONAS, reportTyping, useChat, useConversations, useModel, useVoice } from '../hooks'

export function ChatView({ conversationId }: { conversationId: string }) {
  const chat = useChat(conversationId)
  const { remove, setPersona } = useConversations()
  const model = useModel()
  const voice = useVoice()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and React would treat a
  // returned value as a cleanup function and crash.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [chat.messages.length, chat.streamingText, model.status, model.progress?.fraction])

  if (!chat.conversation) return <div className="page">Chat not found.</div>
  const ready = model.status === 'ready'
  const loading = model.status === 'loading'
  const defaultKey = model.spec?.key ?? model.lastUsedKey ?? model.recommendedKey
  const defaultSpec = model.available.find((s) => s.key === defaultKey)
  const busy = sending || chat.isGenerating

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    setSendError(null)
    setSending(true)
    try {
      await chat.send(t)
    } catch (e) {
      setText(t) // keep the draft if the model could not load
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const toggleMic = async () => {
    if (voice.dictation.listening) {
      const said = await voice.stopDictation()
      if (said) setText((t) => (t ? `${t} ${said}` : said))
    } else {
      await voice.startDictation('auto', chat.conversation?.persona === 'hinglish' ? 'hi-IN' : 'en-IN')
    }
  }

  return (
    <>
      <div className="topbar">
        <select value={chat.conversation.persona} onChange={(e) => void setPersona(conversationId, e.target.value)}>
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <button
          onClick={async () => {
            await remove(conversationId)
            navigate('/')
          }}
        >
          Delete chat
        </button>
      </div>
      <div className="messages">
        {!ready && !loading && (
          <div className="notice">
            <b>No AI model loaded yet.</b>
            <div className="meta">
              {defaultSpec
                ? `${defaultSpec.label}${defaultSpec.downloadMB ? ` · ${defaultSpec.downloadMB} MB, downloaded once (use Wi-Fi), then works offline` : ''}`
                : 'Pick a model from the list at the top.'}
            </div>
            {defaultKey && (
              <button onClick={() => void model.load(defaultKey).catch(() => {})}>
                {defaultSpec?.downloadMB ? 'Download & load model' : 'Load model'}
              </button>
            )}
            <div className="meta">Or just type a message and press Send: the model loads automatically.</div>
          </div>
        )}
        {chat.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.content}
            {m.role === 'assistant' && (
              <div className="meta">
                {m.model}
                {m.metrics && ` · TTFT ${m.metrics.ttftMs} ms · ${m.metrics.tokensPerSec ?? '–'} tok/s · ${m.metrics.totalMs} ms`}{' '}
                <button onClick={() => void voice.speak(m.content)}>🔊</button>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="notice">
            <b>Loading {model.spec?.label ?? 'model'}…</b>
            <progress value={model.progress?.fraction ?? undefined} max={1} style={{ width: '100%' }} />
            <div className="meta">{model.progress?.text}</div>
            {sending && <div className="meta">Your message will be sent as soon as it's ready.</div>}
          </div>
        )}
        {chat.streamingText !== undefined && <div className="msg assistant">{chat.streamingText || '…'}</div>}
        {(chat.error || sendError || (model.status === 'error' && model.error)) && (
          <div className="bad">{chat.error ?? sendError ?? model.error}</div>
        )}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <button onClick={() => void toggleMic()} title={voice.dictation.engine ?? ''} aria-label="Voice input">
          {voice.dictation.listening ? '■' : voice.dictation.transcribing ? '…' : '🎤'}
        </button>
        <textarea
          rows={2}
          value={voice.dictation.listening && voice.dictation.interim ? voice.dictation.interim : text}
          placeholder="Message Shreyan.ai"
          enterKeyHint="send"
          onChange={(e) => {
            setText(e.target.value)
            reportTyping()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {chat.isGenerating ? (
          <button onClick={chat.stop}>Stop</button>
        ) : (
          <button className="send" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {sending && !ready ? 'Loading…' : 'Send'}
          </button>
        )}
        {voice.isSpeaking && <button onClick={voice.stopSpeaking}>Mute</button>}
      </div>
      {voice.dictation.error && <div className="bad" style={{ padding: '0 12px 8px' }}>{voice.dictation.error}</div>}
    </>
  )
}
