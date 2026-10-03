import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PERSONAS, useChat, useConversations, useModel, useVoice } from '../hooks'

export function ChatView({ conversationId }: { conversationId: string }) {
  const chat = useChat(conversationId)
  const { remove, setPersona } = useConversations()
  const model = useModel()
  const voice = useVoice()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [chat.messages.length, chat.streamingText])

  if (!chat.conversation) return <div className="page">Chat not found.</div>
  const ready = model.status === 'ready'

  const submit = async () => {
    const t = text
    setText('')
    await chat.send(t)
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
        {chat.streamingText !== undefined && <div className="msg assistant">{chat.streamingText || '…'}</div>}
        {chat.error && <div className="bad">{chat.error}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <button onClick={() => void toggleMic()} title={voice.dictation.engine ?? ''}>
          {voice.dictation.listening ? '■ Stop mic' : voice.dictation.transcribing ? '…' : '🎤'}
        </button>
        <textarea
          rows={2}
          value={voice.dictation.listening && voice.dictation.interim ? voice.dictation.interim : text}
          placeholder={ready ? 'Message Shreyan.ai' : 'Load a model to start'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (ready && !chat.isGenerating) void submit()
            }
          }}
        />
        {chat.isGenerating ? (
          <button onClick={chat.stop}>Stop</button>
        ) : (
          <button disabled={!ready || !text.trim()} onClick={() => void submit()}>Send</button>
        )}
        {voice.isSpeaking && <button onClick={voice.stopSpeaking}>Mute</button>}
      </div>
      {voice.dictation.error && <div className="bad" style={{ padding: '0 12px 8px' }}>{voice.dictation.error}</div>}
    </>
  )
}
