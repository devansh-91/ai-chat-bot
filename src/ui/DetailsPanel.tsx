import { useNavigate } from 'react-router-dom'
import { PERSONAS, useAuth, useChat, useConversations, useSyncStatus } from '../hooks'
import { ModelPicker } from './ModelPicker'
import { TelemetryHud } from './TelemetryHud'

/** Everything that used to crowd the top bar. Shown only when the user taps ⚙ or the model chip. */
export function DetailsPanel({ conversationId }: { conversationId: string }) {
  const { conversation } = useChat(conversationId)
  const { setPersona, remove } = useConversations()
  const auth = useAuth()
  const sync = useSyncStatus()
  const navigate = useNavigate()
  return (
    <section className="details">
      <div className="row">
        <span className="label">Model</span>
        <ModelPicker />
      </div>
      <div className="row">
        <span className="label">Speed</span>
        <TelemetryHud />
      </div>
      {conversation && (
        <div className="row">
          <span className="label">This chat</span>
          <select value={conversation.persona} onChange={(e) => void setPersona(conversationId, e.target.value)} aria-label="Persona">
            {PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm('Delete this chat on all your devices?')) return
              await remove(conversationId)
              navigate('/')
            }}
          >
            Delete chat
          </button>
        </div>
      )}
      <div className="row">
        <span className="label">Account</span>
        {auth.status === 'signedIn' && (
          <>
            <span className="meta">
              {auth.user?.email}{auth.isAdmin && ' · admin'} · sync {sync.phase}{sync.realtime ? ' · live' : ''}
              {sync.pending ? ` · ${sync.pending} waiting` : ''}
            </span>
            <button onClick={() => void auth.signOut()}>Sign out</button>
          </>
        )}
        {auth.status === 'signedOut' && <button onClick={() => void auth.signInWithGoogle()}>Sign in with Google to sync</button>}
        {auth.status === 'disabled' && <span className="meta">Guest mode: chats are saved on this device only.</span>}
      </div>
    </section>
  )
}
