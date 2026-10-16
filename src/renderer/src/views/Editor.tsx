import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Undo2,
  Wand2
} from 'lucide-react'
import type { Cut, Edits, Recording } from '../../../shared/types'
import { defaultEdits, finalDuration, formatTime, keepRanges, mergeCuts } from '../../../shared/edits'
import Timeline from '../components/Timeline'
import { Modal } from '../components/Modal'
import { navigate } from '../nav'

const SILENCE_PADDING = 0.25

export default function Editor({ id }: { id: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [rec, setRec] = useState<Recording | null>(null)
  const [edits, setEdits] = useState<Edits | null>(null)
  const [history, setHistory] = useState<Edits[]>([])
  const [peaks, setPeaks] = useState<number[]>([])
  const [filmstrip, setFilmstrip] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [selectedCut, setSelectedCut] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [noiseDb, setNoiseDb] = useState(-35)
  const [minSilence, setMinSilence] = useState(1)
  const [detecting, setDetecting] = useState(false)
  const [silenceNote, setSilenceNote] = useState<string | null>(null)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [justExported, setJustExported] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getRecording(id).then((r) => {
      if (!r) return navigate('/home')
      setRec(r)
      setTitle(r.title)
      setEdits(r.edits ?? defaultEdits(r.duration))
      setExported(r.exportedPath ?? null)
    })
    void window.api.getPeaks(id).then(setPeaks).catch(() => setPeaks([]))
    void window.api.getFilmstrip(id).then(setFilmstrip).catch(() => setFilmstrip(null))
    return window.api.onExportProgress(setExportProgress)
  }, [id])

  // Autosave edits.
  useEffect(() => {
    if (!edits) return
    const t = setTimeout(() => void window.api.saveEdits(id, edits), 400)
    return () => clearTimeout(t)
  }, [id, edits])

  const ranges = useMemo(() => (edits ? keepRanges(edits) : []), [edits])

  const commit = useCallback(
    (next: Edits) => {
      if (edits) setHistory((h) => [...h.slice(-49), edits])
      setEdits({ ...next, cuts: mergeCuts(next.cuts) })
      setSelectedCut(null)
    },
    [edits]
  )

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h
      setEdits(h[h.length - 1])
      setSelectedCut(null)
      setSelection(null)
      return h.slice(0, -1)
    })
  }, [])

  // Playback that skips everything trimmed or cut.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const v = videoRef.current
      if (v) {
        const t = v.currentTime
        const r = ranges.find((r) => t < r.end - 0.03)
        if (!r) {
          v.pause()
          if (ranges.length) v.currentTime = ranges[ranges.length - 1].end
        } else if (t < r.start - 0.03) v.currentTime = r.start
        setTime(v.currentTime)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, ranges])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v || !ranges.length) return
    if (v.paused) {
      const last = ranges[ranges.length - 1]
      if (v.currentTime >= last.end - 0.05 || v.currentTime < ranges[0].start - 0.05) v.currentTime = ranges[0].start
      void v.play()
    } else v.pause()
  }, [ranges])

  const seek = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t
    setTime(t)
  }, [])

  const cutSelection = useCallback(() => {
    if (!edits || !selection) return
    commit({ ...edits, cuts: [...edits.cuts, { ...selection, kind: 'manual' }] })
    setSelection(null)
  }, [edits, selection, commit])

  const restoreCut = useCallback(
    (index: number | null = selectedCut) => {
      if (!edits || index === null) return
      commit({ ...edits, cuts: edits.cuts.filter((_, i) => i !== index) })
    },
    [edits, selectedCut, commit]
  )

  const removeSilences = async (): Promise<void> => {
    if (!rec || !edits) return
    setDetecting(true)
    setSilenceNote(null)
    try {
      const silent = await window.api.detectSilences(id, noiseDb, minSilence)
      const cuts: Cut[] = silent
        .map((s) => ({
          start: s.start <= 0.05 ? 0 : s.start + SILENCE_PADDING,
          end: s.end >= rec.duration - 0.05 ? rec.duration : s.end - SILENCE_PADDING,
          kind: 'silence' as const
        }))
        .filter((c) => c.end - c.start > 0.2)
      const next = { ...edits, cuts: [...edits.cuts.filter((c) => c.kind !== 'silence'), ...cuts] }
      const saved = finalDuration(edits) - finalDuration({ ...next, cuts: mergeCuts(next.cuts) })
      commit(next)
      setSilenceNote(
        cuts.length
          ? `Removed ${cuts.length} pause${cuts.length > 1 ? 's' : ''} · ${saved.toFixed(1)}s shorter`
          : 'No long pauses found. Try a shorter minimum pause or a higher level.'
      )
    } catch (err) {
      setSilenceNote('Couldn’t analyse the audio: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDetecting(false)
    }
  }

  const doExport = async (): Promise<void> => {
    if (!edits) return
    videoRef.current?.pause()
    setExportProgress(0)
    setExportError(null)
    try {
      await window.api.saveEdits(id, edits)
      const out = await window.api.exportVideo(id, edits)
      setExported(out)
      setJustExported(true)
    } catch (err) {
      setExportError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setExportProgress(null)
    }
  }

  const rename = async (): Promise<void> => {
    if (!rec) return
    if (!title.trim()) return setTitle(rec.title)
    if (title.trim() === rec.title) return
    const r = await window.api.renameRecording(id, title)
    if (r) {
      setRec(r)
      setTitle(r.title)
    }
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || exportProgress !== null) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection) cutSelection()
        else if (selectedCut !== null) restoreCut()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if (e.key === 'Escape') {
        setSelection(null)
        setSelectedCut(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, cutSelection, restoreCut, undo, selection, selectedCut, exportProgress])

  if (!rec || !edits) {
    return (
      <div className="editor">
        <div className="editor-bar drag" />
        <div className="center-fill">
          <div className="spinner" />
        </div>
      </div>
    )
  }

  const editedTotal = finalDuration(edits)
  const editedNow = ranges.reduce((sum, r) => sum + Math.max(0, Math.min(time, r.end) - r.start), 0)
  const removed = rec.duration - editedTotal
  const untouched = !edits.cuts.length && edits.trimStart === 0 && edits.trimEnd === rec.duration
  const silenceCount = edits.cuts.filter((c) => c.kind === 'silence').length

  return (
    <div className="editor">
      <header className="editor-bar drag">
        <button className="btn ghost no-drag" onClick={() => navigate('/home')}>
          <ArrowLeft size={17} /> Library
        </button>
        <div className="divider" />
        <input
          className="title-input no-drag"
          value={title}
          spellCheck={false}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <div className="bar-actions no-drag">
          {exported && (
            <button className="btn ghost" onClick={() => void window.api.showInFolder(exported)}>
              <FolderOpen size={17} /> Show file
            </button>
          )}
          <button className="btn primary" onClick={() => void doExport()} disabled={exportProgress !== null}>
            <Download size={17} /> Download MP4
          </button>
        </div>
      </header>

      <div className="editor-body">
        <section className="editor-main">
          <div className="stage">
            <div className="video-wrap" onClick={togglePlay}>
              <video
                ref={videoRef}
                src={`media://${id}/video.webm`}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onSeeked={(e) => !playing && setTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => (e.currentTarget.currentTime = edits.trimStart)}
              />
              {!playing && (
                <span className="big-play">
                  <Play size={30} fill="currentColor" />
                </span>
              )}
            </div>
          </div>

          <div className="player-bar">
            <button className="play-btn" onClick={togglePlay} title="Play / pause (Space)">
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
            <span className="clock">
              {formatTime(editedNow)} <span className="muted">/ {formatTime(editedTotal)}</span>
            </span>
            <div className="spacer" />
            <button className="btn ghost sm" disabled={!history.length} onClick={undo} title="Undo (Ctrl+Z)">
              <Undo2 size={16} /> Undo
            </button>
          </div>

          <Timeline
            duration={rec.duration}
            peaks={peaks}
            filmstrip={filmstrip}
            edits={edits}
            time={time}
            selection={selection}
            selectedCut={selectedCut}
            onSeek={(t) => {
              setSelection(null)
              setSelectedCut(null)
              seek(t)
            }}
            onSelect={(s) => {
              setSelectedCut(null)
              setSelection(s)
            }}
            onSelectCut={(i) => {
              setSelection(null)
              setSelectedCut(i)
            }}
            onCutSelection={cutSelection}
            onRestoreCut={() => restoreCut()}
            onTrimStart={() => setHistory((h) => [...h.slice(-49), edits])}
            onTrim={(trimStart, trimEnd, which) => {
              setEdits((e) => (e ? { ...e, trimStart, trimEnd } : e))
              seek(which === 'start' ? trimStart : Math.max(trimStart, trimEnd - 0.05))
            }}
          />
        </section>

        <aside className="edit-side">
          <div className="side-card summary">
            <div className="summary-label">Final length</div>
            <div className="summary-value">{formatTime(editedTotal)}</div>
            <div className="muted small">
              {removed > 0.05 ? `${formatTime(rec.duration)} original · ${removed.toFixed(1)}s removed` : 'No edits yet'}
            </div>
          </div>

          <div className="side-card">
            <div className="side-title">
              <Wand2 size={17} /> Remove silences
            </div>
            <p className="muted small">Automatically cut the pauses where nobody is talking.</p>
            <label className="slider">
              <span>
                Minimum pause <b>{minSilence.toFixed(1)}s</b>
              </span>
              <input type="range" min={0.5} max={3} step={0.1} value={minSilence} onChange={(e) => setMinSilence(Number(e.target.value))} />
            </label>
            <label className="slider">
              <span>
                Sensitivity <b>{noiseDb} dB</b>
              </span>
              <input type="range" min={-55} max={-20} step={1} value={noiseDb} onChange={(e) => setNoiseDb(Number(e.target.value))} />
              <span className="slider-ends muted">
                <span>Quiet rooms</span>
                <span>Noisy rooms</span>
              </span>
            </label>
            <button className="btn accent full" onClick={() => void removeSilences()} disabled={detecting || !rec.hasAudio}>
              {detecting ? (
                <>
                  <span className="spinner sm" /> Analysing…
                </>
              ) : !rec.hasAudio ? (
                'This video has no sound'
              ) : silenceCount ? (
                'Re-run with these settings'
              ) : (
                <>
                  <Wand2 size={16} /> Remove silences
                </>
              )}
            </button>
            {silenceNote && <p className="note">{silenceNote}</p>}
          </div>

          <div className="side-card grow">
            <div className="side-title">
              <Scissors size={17} /> Cuts
              {edits.cuts.length > 0 && <span className="count">{edits.cuts.length}</span>}
            </div>
            {edits.cuts.length === 0 ? (
              <p className="muted small">
                Drag across the timeline to select a part, then press <kbd>Delete</kbd> to cut it. Drag the purple handles to trim
                the start and end.
              </p>
            ) : (
              <ul className="cut-list">
                {edits.cuts.map((c, i) => (
                  <li
                    key={`${c.start}-${i}`}
                    className={selectedCut === i ? 'on' : ''}
                    onClick={() => {
                      setSelection(null)
                      setSelectedCut(i)
                      seek(Math.max(edits.trimStart, c.start - 1))
                    }}
                  >
                    <span className={`dot ${c.kind}`} />
                    <span className="cut-range">
                      {formatTime(c.start)} – {formatTime(c.end)}
                    </span>
                    <span className="muted small">{(c.end - c.start).toFixed(1)}s</span>
                    <button
                      className="icon-btn sm"
                      title="Restore this part"
                      onClick={(e) => {
                        e.stopPropagation()
                        restoreCut(i)
                      }}
                    >
                      <RotateCcw size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!untouched && (
              <button className="link-btn" onClick={() => commit(defaultEdits(rec.duration))}>
                Revert all edits
              </button>
            )}
          </div>
        </aside>
      </div>

      {exportProgress !== null && (
        <Modal>
          <div className="dialog">
            <h3>Creating your MP4…</h3>
            <div className="progress">
              <div style={{ width: `${Math.max(3, exportProgress * 100)}%` }} />
            </div>
            <p className="muted small">{Math.round(exportProgress * 100)}% · {formatTime(editedTotal)} video</p>
          </div>
        </Modal>
      )}
      {justExported && exported && (
        <Modal onClose={() => setJustExported(false)}>
          <div className="dialog">
            <div className="dialog-icon success">
              <CheckCircle2 size={24} />
            </div>
            <h3>Your video is ready</h3>
            <p className="muted path">{exported}</p>
            <div className="dialog-actions">
              <button className="btn" onClick={() => void window.api.showInFolder(exported)}>
                <FolderOpen size={16} /> Show in folder
              </button>
              <button className="btn" onClick={() => void window.api.openPath(exported)}>
                <Play size={16} /> Play
              </button>
              <button className="btn primary" onClick={() => setJustExported(false)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
      {exportError && (
        <Modal onClose={() => setExportError(null)}>
          <div className="dialog">
            <h3>Couldn’t save the MP4</h3>
            <p className="muted">{exportError}</p>
            <div className="dialog-actions">
              <button className="btn primary" onClick={() => setExportError(null)}>
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
