import { useEffect, useRef } from 'react'
import type { DrawTool, RecState } from '../../../shared/types'

/**
 * Full-screen see-through layer over the recorded display. Unlike the control
 * bar it is NOT content-protected, so what's drawn here lands in the video.
 */

interface Point {
  x: number
  y: number
}
interface Stroke {
  tool: DrawTool
  color: string
  points: Point[]
  /** set when the stroke is finished; it fades out after that */
  doneAt: number | null
}
interface Ripple extends Point {
  at: number
}

const HOLD_MS = 4000
const FADE_MS = 1000
const RIPPLE_MS = 650
const LINE = 6

function drawArrow(ctx: CanvasRenderingContext2D, a: Point, b: Point): void {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const len = Math.min(28, Math.hypot(b.x - a.x, b.y - a.y) * 0.5)
  ctx.beginPath()
  ctx.moveTo(b.x - len * Math.cos(angle - 0.5), b.y - len * Math.sin(angle - 0.5))
  ctx.lineTo(b.x, b.y)
  ctx.lineTo(b.x - len * Math.cos(angle + 0.5), b.y - len * Math.sin(angle + 0.5))
  ctx.stroke()
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const pts = s.points
  if (!pts.length) return
  ctx.strokeStyle = s.color
  if (s.tool === 'pen') {
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    // Smooth with midpoints between samples.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2
      const my = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  } else if (pts.length > 1) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (s.tool === 'arrow') drawArrow(ctx, a, b)
    else {
      ctx.beginPath()
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

export default function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useRef<RecState | null>(null)
  const strokes = useRef<Stroke[]>([])
  const ripples = useRef<Ripple[]>([])
  const current = useRef<Stroke | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = innerWidth * dpr
      canvas.height = innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const apply = (s: RecState): void => {
      state.current = s
      document.body.classList.toggle('drawing', s.drawing)
    }
    void window.api.getState().then(apply)
    const offState = window.api.onState(apply)
    const offClick = window.api.onOverlayClick((p) => ripples.current.push({ ...p, at: performance.now() }))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && state.current?.drawing) window.api.control('toggle-draw')
    }
    window.addEventListener('keydown', onKey)

    let raf = 0
    const frame = (): void => {
      const now = performance.now()
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = LINE
      ctx.shadowColor = 'rgba(0,0,0,0.25)'
      ctx.shadowBlur = 4

      strokes.current = strokes.current.filter((s) => s.doneAt === null || now - s.doneAt < HOLD_MS + FADE_MS)
      for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
        const age = s.doneAt === null ? 0 : now - s.doneAt
        ctx.globalAlpha = age < HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS)
        drawStroke(ctx, s)
      }

      ctx.shadowBlur = 0
      ripples.current = ripples.current.filter((r) => now - r.at < RIPPLE_MS)
      for (const r of ripples.current) {
        const t = (now - r.at) / RIPPLE_MS
        const ease = 1 - Math.pow(1 - t, 3)
        ctx.globalAlpha = 1 - t
        ctx.fillStyle = 'rgba(255, 200, 61, 0.35)'
        ctx.beginPath()
        ctx.arc(r.x, r.y, 10 + ease * 22, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#ffc83d'
        ctx.lineWidth = 3
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKey)
      offState()
      offClick()
    }
  }, [])

  const onDown = (e: React.PointerEvent): void => {
    const s = state.current
    if (!s?.drawing || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    current.current = { tool: s.drawTool, color: s.drawColor, points: [{ x: e.clientX, y: e.clientY }], doneAt: null }
  }
  const onMove = (e: React.PointerEvent): void => {
    const c = current.current
    if (!c) return
    const p = { x: e.clientX, y: e.clientY }
    if (c.tool === 'pen') c.points.push(p)
    else c.points = [c.points[0], p]
  }
  const onUp = (e: React.PointerEvent): void => {
    const c = current.current
    current.current = null
    if (!c) return
    // Include the release point; the last move event can be coalesced away.
    const p = { x: e.clientX, y: e.clientY }
    if (c.tool === 'pen') c.points.push(p)
    else c.points = [c.points[0], p]
    c.doneAt = performance.now()
    strokes.current.push(c)
  }

  return (
    <canvas
      ref={canvasRef}
      className="overlay-canvas"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  )
}
