import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Scissors } from 'lucide-react'
import type { Edits } from '../../../shared/types'
import { formatTime } from '../../../shared/edits'

interface Props {
  duration: number
  peaks: number[]
  filmstrip: string | null
  edits: Edits
  time: number
  selection: { start: number; end: number } | null
  selectedCut: number | null
  onSeek(t: number): void
  onSelect(s: { start: number; end: number }): void
  onSelectCut(i: number): void
  onCutSelection(): void
  onRestoreCut(): void
  onTrimStart(): void
  onTrim(trimStart: number, trimEnd: number, which: 'start' | 'end'): void
}

const MIN_KEEP = 0.5

export default function Timeline(p: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const filmRef = useRef<HTMLCanvasElement>(null)
  const [film, setFilm] = useState<HTMLImageElement | null>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const drag = useRef<{ x: number; t: number; moved: boolean } | null>(null)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!p.filmstrip) return
    const img = new Image()
    img.onload = () => setFilm(img)
    img.src = p.filmstrip
  }, [p.filmstrip])

  // Filmstrip: tile frames at their real aspect, each showing the moment under it.
  useEffect(() => {
    const canvas = filmRef.current
    if (!canvas || !width || !film) return
    const dpr = window.devicePixelRatio || 1
    const height = canvas.clientHeight
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    const frames = 16
    const fw = film.naturalWidth / frames
    const fh = film.naturalHeight
    const tileW = (height * fw) / fh
    for (let x = 0; x < width; x += tileW) {
      const i = Math.min(frames - 1, Math.floor(((x + tileW / 2) / width) * frames))
      ctx.drawImage(film, i * fw, 0, fw, fh, x, 0, tileW, height)
    }
  }, [film, width])

  // Waveform.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const dpr = window.devicePixelRatio || 1
    const height = canvas.clientHeight
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (!p.peaks.length) return
    const bar = 2
    const gap = 1.5
    const perBar = p.peaks.length / (width / (bar + gap))
    const sorted = [...p.peaks].sort((a, b) => a - b)
    const loud = Math.max(0.05, sorted[Math.floor(sorted.length * 0.98)] ?? 0.05)
    ctx.fillStyle = '#8b85ff'
    for (let x = 0, i = 0; x < width; x += bar + gap, i += perBar) {
      let m = 0
      for (let j = Math.floor(i); j < Math.min(p.peaks.length, Math.floor(i + perBar) + 1); j++) m = Math.max(m, p.peaks[j])
      const h = Math.max(1.5, Math.min(1, m / loud) * (height - 6))
      ctx.beginPath()
      ctx.roundRect(x, (height - h) / 2, bar, h, 1)
      ctx.fill()
    }
  }, [p.peaks, width])

  const pct = (t: number): string => `${(t / p.duration) * 100}%`
  const timeAt = (clientX: number): number => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(p.duration, ((clientX - rect.left) / rect.width) * p.duration))
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, t: timeAt(e.clientX), moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    setHover(timeAt(e.clientX))
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(e.clientX - d.x) < 4) return
    d.moved = true
    const t = timeAt(e.clientX)
    const start = Math.max(p.edits.trimStart, Math.min(d.t, t))
    const end = Math.min(p.edits.trimEnd, Math.max(d.t, t))
    if (end > start) p.onSelect({ start, end })
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const t = timeAt(e.clientX)
    const hit = p.edits.cuts.findIndex((c) => t >= c.start && t <= c.end)
    if (hit >= 0) p.onSelectCut(hit)
    else p.onSeek(Math.max(p.edits.trimStart, Math.min(p.edits.trimEnd, t)))
  }

  const handleDown = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    p.onTrimStart()
    const { trimStart, trimEnd } = p.edits
    const move = (ev: PointerEvent): void => {
      const t = timeAt(ev.clientX)
      if (which === 'start') p.onTrim(Math.min(t, trimEnd - MIN_KEEP), trimEnd, 'start')
      else p.onTrim(trimStart, Math.max(t, trimStart + MIN_KEEP), 'end')
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('lostpointercapture', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('lostpointercapture', up)
  }

  // Tick marks spaced at least ~80px apart.
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => (width / p.duration) * s > 80) ?? 1200
  const ticks: number[] = []
  for (let t = 0; t < p.duration - step * 0.4; t += step) ticks.push(t)

  const cut = p.selectedCut !== null ? p.edits.cuts[p.selectedCut] : null
  const stop = (e: React.PointerEvent): void => e.stopPropagation()

  return (
    <div className="timeline">
      <div className="ticks">
        {ticks.map((t) => (
          <span key={t} style={{ left: pct(t) }}>
            {formatTime(t)}
          </span>
        ))}
      </div>
      <div
        ref={trackRef}
        className="track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
      >
        <canvas ref={filmRef} className="film" />
        <canvas ref={canvasRef} className="wave" />

        {p.edits.trimStart > 0 && <div className="trimmed" style={{ left: 0, width: pct(p.edits.trimStart) }} />}
        {p.edits.trimEnd < p.duration && <div className="trimmed" style={{ left: pct(p.edits.trimEnd), right: 0 }} />}
        <div className="keep-frame" style={{ left: pct(p.edits.trimStart), width: pct(p.edits.trimEnd - p.edits.trimStart) }} />

        {p.edits.cuts.map((c, i) => (
          <div
            key={`${c.start}-${i}`}
            className={`cut ${c.kind} ${p.selectedCut === i ? 'selected' : ''}`}
            style={{ left: pct(c.start), width: pct(c.end - c.start) }}
          />
        ))}
        {p.selection && (
          <div className="selection" style={{ left: pct(p.selection.start), width: pct(p.selection.end - p.selection.start) }} />
        )}

        <div className="handle" style={{ left: pct(p.edits.trimStart) }} onPointerDown={handleDown('start')} title="Trim start" />
        <div className="handle" style={{ left: pct(p.edits.trimEnd) }} onPointerDown={handleDown('end')} title="Trim end" />

        {hover !== null && !drag.current && (
          <div className="hover-line" style={{ left: pct(hover) }}>
            <span>{formatTime(hover)}</span>
          </div>
        )}
        <div className="playhead" style={{ left: pct(p.time) }} />
      </div>

      {p.selection && (
        <div className="float-action" style={{ left: pct((p.selection.start + p.selection.end) / 2) }}>
          <button onPointerDown={stop} onClick={p.onCutSelection}>
            <Scissors size={14} /> Cut {(p.selection.end - p.selection.start).toFixed(1)}s
          </button>
        </div>
      )}
      {cut && (
        <div className="float-action" style={{ left: pct((cut.start + cut.end) / 2) }}>
          <button onPointerDown={stop} onClick={p.onRestoreCut}>
            <RotateCcw size={14} /> Restore
          </button>
        </div>
      )}
    </div>
  )
}
