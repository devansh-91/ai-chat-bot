import { useEffect, useRef, useState } from 'react'
import { reportTyping, useChat, useModel, useVoice } from '../hooks'

export function ChatView({ conversationId }: { conversationId: string }) {
  const chat = useChat(conversationId)
  const model = useModel()
  const voice = useVoice()
  const [text, setText] = useState('')
  const [openMeta, setOpenMeta] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // Follow new messages, but don't yank the view if the user scrolled up to read.
  useEffect(() => {
    const el = list.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, chat.streamingText, model.status, model.progress?.fraction])

  // Always jump to the bottom when switching tabs.
  useEffect(() => {
    const t = setTimeout(() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight
    }, 0)
    return () => clearTimeout(t)
  }, [conversationId, chat.conversation?.id])

  // Auto-grow the composer up to a few lines.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  if (!chat.conversation) return <div className="page">Chat not found.</div>
  const ready = model.status === 'ready'
  const loading = model.status === 'loading'
  const defaultKey = model.spec?.key ?? model.lastUsedKey ?? model.recommendedKey
  const defaultSpec = model.available.find((s) => s.key === defaultKey)

  const submit = () => {
    const t = text.trim()
    if (!t || chat.isGenerating) return
    setText('')
    void chat.send(t)
    input.current?.focus()
  }

  const toggleMic = async () => {
    if (voice.dictation.listening) {
      const said = await voice.stopDictation()
      if (said) setText((t) => (t ? `${t} ${said}` : said))
    } else {
      await voice.startDictation('auto', chat.conversation?.persona === 'hinglish' ? 'hi-IN' : 'en-IN')
    }
  }

  const empty = chat.messages.length === 0 && !chat.isGenerating

  return (
    <>
      <div className="messages" ref={list}>
        <div className="thread">
          {empty && !ready && !loading && (
            <div className="notice">
              <b>Load an AI model to start</b>
              <span className="meta">
                {defaultSpec
                  ? `${defaultSpec.label}${defaultSpec.downloadMB ? ` · ${defaultSpec.downloadMB} MB, downloaded once (use Wi-Fi), then works offline` : ''}`
                  : 'Tap ⚙ to pick a model.'}
              </span>
              {defaultKey && (
                <button className="primary" onClick={() => void model.load(defaultKey).catch(() => {})}>
                  {defaultSpec?.downloadMB ? 'Download & load' : 'Load model'}
                </button>
              )}
              <span className="meta">Or just type below: the model loads automatically when you send.</span>
            </div>
          )}
          {empty && (ready || loading) && <p className="meta center">Ask me anything.</p>}

          {chat.messages.map((m) => (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role}`}>
                {m.role === 'user' && <span className="who">You</span>}
                <div className="text">{m.content}</div>
                {m.role === 'assistant' && (
                  <div className="bubble-actions">
                    <button className="tiny" onClick={() => void voice.speak(m.content)} aria-label="Read aloud">🔊</button>
                    {m.metrics && (
                      <button className="tiny" onClick={() => setOpenMeta(openMeta === m.id ? null : m.id)} aria-label="Speed details">ⓘ</button>
                    )}
                    {openMeta === m.id && m.metrics && (
                      <span className="meta">
                        {m.model} · first word {m.metrics.ttftMs} ms · {m.metrics.tokensPerSec ?? '–'} tok/s · total {(m.metrics.totalMs / 1000).toFixed(1)} s
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {chat.isGenerating && loading && (
            <div className="notice">
              <b>Loading {model.spec?.label ?? 'model'}… {Math.round((model.progress?.fraction ?? 0) * 100)}%</b>
              <progress value={model.progress?.fraction ?? undefined} max={1} />
              <span className="meta">{model.progress?.text}</span>
              <span className="meta">First time only. Your message will be answered as soon as it's ready.</span>
            </div>
          )}
          {chat.isGenerating && !loading && (
            <div className="bubble-row assistant">
              <div className="bubble assistant">
                {chat.streamingText ? <div className="text">{chat.streamingText}</div> : <span className="typing"><i /><i /><i /></span>}
              </div>
            </div>
          )}
          {chat.error && (
            <div className="notice bad-notice">
              <span>{chat.error}</span>
              {chat.canRetry && <button onClick={() => void chat.retry()}>Try again</button>}
            </div>
          )}
          {!chat.error && chat.canRetry && !chat.isGenerating && (
            <div className="center">
              <button onClick={() => void chat.retry()}>Get a reply</button>
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        <button
          className={`icon ${voice.dictation.listening ? 'on' : ''}`}
          onClick={() => void toggleMic()}
          title={voice.dictation.engine ?? 'Voice input'}
          aria-label="Voice input"
        >
          {voice.dictation.listening ? '■' : voice.dictation.transcribing ? '…' : '🎤'}
        </button>
        <textarea
          ref={input}
          rows={1}
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
              submit()
            }
          }}
        />
        {chat.isGenerating ? (
          <button className="send" onClick={chat.stop} aria-label="Stop">■</button>
        ) : (
          <button className="send" disabled={!text.trim()} onClick={submit} aria-label="Send">➤</button>
        )}
        {voice.isSpeaking && <button className="icon" onClick={voice.stopSpeaking} aria-label="Stop speaking">🔇</button>}
      </div>
      {voice.dictation.error && <div className="bad center small">{voice.dictation.error}</div>}
    </>
  )
}
