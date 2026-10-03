import { useState } from 'react'
import { getOllamaUrl, setOllamaUrl } from '../core/llm/ollama'
import { RETENTION_DAYS, useModel, useVoice } from '../hooks'

export function SettingsPage() {
  const v = useVoice()
  const m = useModel()
  const [ollama, setOllama] = useState(getOllamaUrl())
  return (
    <div className="page">
      <h3>Voice</h3>
      <label>
        Voice{' '}
        <select value={v.settings.voiceURI ?? ''} onChange={(e) => v.updateSettings({ voiceURI: e.target.value || null })}>
          <option value="">Auto (calibrated masculine: {v.autoVoice?.name ?? 'none found'})</option>
          {v.voices.map((x) => (
            <option key={x.voiceURI} value={x.voiceURI}>
              {x.name} ({x.lang}){x.localService ? ' · offline' : ''}
            </option>
          ))}
        </select>
      </label>
      <p>
        Pitch {v.settings.pitch.toFixed(2)}{' '}
        <input type="range" min={0.5} max={1.5} step={0.05} value={v.settings.pitch} onChange={(e) => v.updateSettings({ pitch: +e.target.value })} />
      </p>
      <p>
        Rate {v.settings.rate.toFixed(2)}{' '}
        <input type="range" min={0.6} max={1.6} step={0.05} value={v.settings.rate} onChange={(e) => v.updateSettings({ rate: +e.target.value })} />
      </p>
      <label>
        <input type="checkbox" checked={v.settings.autoSpeak} onChange={(e) => v.updateSettings({ autoSpeak: e.target.checked })} /> Read replies aloud
      </label>{' '}
      <button onClick={() => void v.speak('Hello, I am Shreyan dot A I. I run privately on your device.')}>Test voice</button>

      <h3>Local model server (Ollama)</h3>
      <input value={ollama} onChange={(e) => setOllama(e.target.value)} style={{ width: 280 }} />{' '}
      <button
        onClick={() => {
          setOllamaUrl(ollama)
          void m.refreshOllama()
        }}
      >
        Save & detect
      </button>
      <p className="meta">Detected: {m.available.filter((s) => s.provider === 'ollama').map((s) => s.modelId).join(', ') || 'none'}</p>

      <h3>Device</h3>
      <pre className="meta">{JSON.stringify(m.device, null, 2)}</pre>

      <h3>Privacy</h3>
      <p className="meta">Chats and telemetry are automatically deleted after {RETENTION_DAYS} days, on this device and in the cloud.</p>
    </div>
  )
}
