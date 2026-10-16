import { useEffect, useRef, useState } from 'react'
import { Circle, Square } from 'lucide-react'

type Size = 's' | 'm' | 'l'
type Shape = 'circle' | 'squircle'

function load<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** The floating face bubble. Captured as part of the screen when recording a whole display. */
export default function Bubble({ initialCamera }: { initialCamera: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraId, setCameraId] = useState(initialCamera)
  const [size, setSize] = useState<Size>(load('bubble.size', 'm'))
  const [shape, setShape] = useState<Shape>(load('bubble.shape', 'circle'))
  const [failed, setFailed] = useState(false)

  useEffect(() => window.api.onBubbleCamera(setCameraId), [])
  useEffect(() => void window.api.setBubbleSize(size), [size])
  useEffect(() => void window.api.setBubbleShape(shape), [shape])

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    setFailed(false)
    navigator.mediaDevices
      .getUserMedia({
        video: {
          deviceId: cameraId ? { exact: cameraId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch(() => setFailed(true))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [cameraId])

  const pick = (s: Size): void => {
    setSize(s)
    store('bubble.size', s)
  }
  const toggleShape = (): void => {
    const next = shape === 'circle' ? 'squircle' : 'circle'
    setShape(next)
    store('bubble.shape', next)
  }

  return (
    <div className={`bubble ${shape}`}>
      <video ref={videoRef} autoPlay muted playsInline />
      {failed && <div className="bubble-error">Camera unavailable</div>}
      <div className="bubble-tools">
        {(['s', 'm', 'l'] as Size[]).map((s) => (
          <button key={s} className={size === s ? 'on' : ''} onClick={() => pick(s)} title={`Size ${s.toUpperCase()}`}>
            {s.toUpperCase()}
          </button>
        ))}
        <button onClick={toggleShape} title="Change shape">
          {shape === 'circle' ? <Square size={13} /> : <Circle size={13} />}
        </button>
      </div>
    </div>
  )
}
