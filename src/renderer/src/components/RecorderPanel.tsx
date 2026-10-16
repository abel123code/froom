import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowLeft, ChevronRight, Mic, MicOff, Monitor, MonitorPlay, MousePointerClick, User, Video, Volume2, X } from 'lucide-react'
import type { CaptureSource, RecordMode } from '../../../shared/types'
import { Modal } from './Modal'
import { startSession } from '../recorder'

interface Settings {
  mode: RecordMode
  cameraId: string
  micId: string | null
  systemAudio: boolean
  highlightClicks: boolean
}

const DEFAULTS: Settings = { mode: 'screen-cam', cameraId: '', micId: '', systemAudio: false, highlightClicks: true }

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }
  } catch {
    return DEFAULTS
  }
}

const MODES: { id: RecordMode; label: string; icon: typeof Monitor }[] = [
  { id: 'screen-cam', label: 'Screen + Cam', icon: MonitorPlay },
  { id: 'screen', label: 'Screen only', icon: Monitor },
  { id: 'cam', label: 'Cam only', icon: User }
]

/** Live input level for the chosen mic, 0..1. */
function useMicLevel(micId: string | null): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (micId === null) {
      setLevel(0)
      return
    }
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0
    let cancelled = false
    void navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(s).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        let smooth = 0
        const tick = (): void => {
          analyser.getFloatTimeDomainData(data)
          let sum = 0
          for (const v of data) sum += v * v
          const rms = Math.sqrt(sum / data.length)
          smooth = Math.max(rms * 4, smooth * 0.85)
          setLevel(Math.min(1, smooth))
          raf = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => setLevel(0))
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [micId])
  return level
}

export default function RecorderPanel({ onClose, onError }: { onClose: () => void; onError: (msg: string) => void }) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [source, setSource] = useState<CaptureSource | null>(null)
  const [view, setView] = useState<'main' | 'sources'>('main')
  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [starting, setStarting] = useState(false)
  const [devicesReady, setDevicesReady] = useState(false)
  const lastSourceId = useRef<string | null>(null)
  const level = useMicLevel(devicesReady && !starting ? settings.micId : null)

  const update = (patch: Partial<Settings>): void => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem('settings', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const refreshSources = useCallback(async () => {
    const list = await window.api.listSources()
    setSources(list)
    setSource((cur) => {
      const keep = cur?.id ?? lastSourceId.current
      return list.find((s) => s.id === keep) ?? list.find((s) => s.kind === 'screen') ?? null
    })
  }, [])

  useEffect(() => {
    try {
      lastSourceId.current = localStorage.getItem('sourceId')
    } catch {
      /* ignore */
    }
    void refreshSources()
    void (async () => {
      let devices = await navigator.mediaDevices.enumerateDevices()
      // Labels are blank until permission has been granted once.
      if (devices.some((d) => !d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
          s.getTracks().forEach((t) => t.stop())
        } catch {
          /* no camera or mic */
        }
        devices = await navigator.mediaDevices.enumerateDevices()
      }
      const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId)
      const ms = devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
      setCameras(cams)
      setMics(ms)
      setSettings((s) => ({
        ...s,
        cameraId: cams.some((c) => c.deviceId === s.cameraId) ? s.cameraId : (cams[0]?.deviceId ?? ''),
        micId: s.micId === null ? null : ms.some((m) => m.deviceId === s.micId) ? s.micId : (ms[0]?.deviceId ?? '')
      }))
      setDevicesReady(true)
    })()
  }, [refreshSources])

  // Live bubble preview while the panel is open.
  useEffect(() => {
    if (!devicesReady) return
    if (settings.mode !== 'screen' && cameras.length) void window.api.showBubble(settings.cameraId, source?.displayId)
    else void window.api.hideBubble()
  }, [devicesReady, settings.mode, settings.cameraId, cameras.length, source?.displayId])
  useEffect(() => () => void window.api.hideBubble(), [])

  const start = async (): Promise<void> => {
    if (settings.mode !== 'cam' && !source) return setView('sources')
    if (settings.mode !== 'screen' && !cameras.length) return onError('No camera found. Plug one in or choose "Screen only".')
    setStarting(true)
    try {
      await startSession({
        mode: settings.mode,
        sourceId: source?.id,
        sourceKind: source?.kind,
        displayId: source?.kind === 'screen' ? source.displayId : undefined,
        cameraId: settings.cameraId || undefined,
        micId: settings.micId,
        systemAudio: settings.systemAudio && settings.mode !== 'cam',
        highlightClicks: settings.highlightClicks
      })
      onClose()
    } catch (err) {
      setStarting(false)
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const pickSource = (s: CaptureSource): void => {
    setSource(s)
    setView('main')
    try {
      localStorage.setItem('sourceId', s.id)
    } catch {
      /* ignore */
    }
  }

  if (view === 'sources') {
    const list = sources.filter((s) => s.kind === tab)
    return (
      <Modal onClose={() => setView('main')} className="wide">
        <div className="panel-head">
          <button className="icon-btn" onClick={() => setView('main')} title="Back">
            <ArrowLeft size={18} />
          </button>
          <h3>Choose what to record</h3>
          <div className="tabs">
            <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
              <Monitor size={15} /> Screens
            </button>
            <button className={tab === 'window' ? 'on' : ''} onClick={() => setTab('window')}>
              <AppWindow size={15} /> Windows
            </button>
          </div>
        </div>
        <div className="source-grid">
          {list.map((s) => (
            <button key={s.id} className={`source-tile ${source?.id === s.id ? 'on' : ''}`} onClick={() => pickSource(s)}>
              <div className="source-thumb">
                <img src={s.thumbnail} alt="" />
              </div>
              <span>{s.kind === 'screen' && sources.filter((x) => x.kind === 'screen').length === 1 ? 'Entire screen' : s.name}</span>
            </button>
          ))}
          {!list.length && <p className="muted">Nothing to show.</p>}
        </div>
      </Modal>
    )
  }

  const showScreen = settings.mode !== 'cam'
  const showCam = settings.mode !== 'screen'

  return (
    <Modal onClose={starting ? undefined : onClose} className="recorder">
      <div className="panel-head">
        <h3>New recording</h3>
        <button className="icon-btn" onClick={onClose} title="Close" disabled={starting}>
          <X size={18} />
        </button>
      </div>

      <div className="mode-tabs">
        {MODES.map((m) => (
          <button key={m.id} className={settings.mode === m.id ? 'on' : ''} onClick={() => update({ mode: m.id })}>
            <m.icon size={20} strokeWidth={1.8} />
            {m.label}
          </button>
        ))}
      </div>

      <div className="rows">
        {showScreen && (
          <button
            className="row clickable"
            onClick={() => {
              void refreshSources()
              setTab(source?.kind ?? 'screen')
              setView('sources')
            }}
          >
            <span className="row-icon">{source?.kind === 'window' ? <AppWindow size={18} /> : <Monitor size={18} />}</span>
            <span className="row-main">
              <span className="row-label">{source?.kind === 'window' ? 'Window' : 'Full screen'}</span>
              <span className="row-value">{source ? (source.kind === 'window' ? source.name : 'Entire screen') : 'Choose…'}</span>
            </span>
            {source && <img className="row-thumb" src={source.thumbnail} alt="" />}
            <ChevronRight size={18} className="muted" />
          </button>
        )}

        {showCam && (
          <label className="row">
            <span className="row-icon">
              <Video size={18} />
            </span>
            <span className="row-main">
              <span className="row-label">Camera</span>
              <select value={settings.cameraId} onChange={(e) => update({ cameraId: e.target.value })}>
                {cameras.length === 0 && <option value="">No camera found</option>}
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || 'Camera'}
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}

        <label className="row">
          <span className="row-icon">{settings.micId === null ? <MicOff size={18} /> : <Mic size={18} />}</span>
          <span className="row-main">
            <span className="row-label">Microphone</span>
            <select
              value={settings.micId ?? '__none'}
              onChange={(e) => update({ micId: e.target.value === '__none' ? null : e.target.value })}
            >
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || 'Microphone'}
                </option>
              ))}
              <option value="__none">No microphone</option>
            </select>
            {settings.micId !== null && (
              <span className="meter">
                {Array.from({ length: 16 }, (_, i) => (
                  <i key={i} className={level * 16 > i ? 'lit' : ''} />
                ))}
              </span>
            )}
          </span>
        </label>

        {showScreen && (
          <label className="row">
            <span className="row-icon">
              <Volume2 size={18} />
            </span>
            <span className="row-main">
              <span className="row-label">Computer sound</span>
              <span className="row-value">Record audio playing on your PC</span>
            </span>
            <span className={`switch ${settings.systemAudio ? 'on' : ''}`}>
              <input type="checkbox" checked={settings.systemAudio} onChange={(e) => update({ systemAudio: e.target.checked })} />
            </span>
          </label>
        )}

        {showScreen && (
          <label className="row">
            <span className="row-icon">
              <MousePointerClick size={18} />
            </span>
            <span className="row-main">
              <span className="row-label">Highlight clicks</span>
              <span className="row-value">{source?.kind === 'window' ? 'Only when recording a full screen' : 'Show a ring where you click'}</span>
            </span>
            <span className={`switch ${settings.highlightClicks ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={settings.highlightClicks}
                onChange={(e) => update({ highlightClicks: e.target.checked })}
              />
            </span>
          </label>
        )}
      </div>

      <button className="btn record" disabled={starting || !devicesReady} onClick={() => void start()}>
        <span className="rec-dot" />
        {starting ? 'Starting…' : 'Start recording'}
      </button>
      <p className="hint">
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> stop · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pause · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> draw
      </p>
    </Modal>
  )
}
