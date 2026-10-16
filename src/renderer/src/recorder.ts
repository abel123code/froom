import type { BubbleGeom, RecCommand, RecordOptions, Recording, RecState } from '../../shared/types'

/**
 * Lives in the main window. The window is hidden while recording, so nothing
 * here may depend on painting: compositing uses insertable streams
 * (MediaStreamTrackProcessor/Generator), not <video> + canvas.
 */

// Chromium-only insertable streams APIs.
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
declare const MediaStreamTrackGenerator: new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }

// Output is capped at 1080p.
const MAX_W = 1920
const MAX_H = 1080

interface Composite {
  track: MediaStreamTrack
  update(s: Pick<RecState, 'camVisible' | 'bubble'>): void
  stop(): void
}

interface Active {
  opts: RecordOptions
  stream: MediaStream
  cleanups: (() => void)[]
  recorder: MediaRecorder | null
  composite: Composite | null
}

let active: Active | null = null
// Blob reads are async; chaining keeps chunks in order.
let chunkChain: Promise<void> = Promise.resolve()
let onFinished: ((rec: Recording | null) => void) | null = null
let onError: ((msg: string) => void) | null = null

export function setRecorderCallbacks(finished: typeof onFinished, error: typeof onError): void {
  onFinished = finished
  onError = error
}

function stopAll(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop())
}

/** Keep only the latest frame from a track; optionally notify on each new one. */
function frameReader(track: MediaStreamTrack, onFrame?: () => void): { latest(): VideoFrame | null; stop(): void } {
  let latest: VideoFrame | null = null
  let stopped = false
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
  void (async () => {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done || !value) break
      latest?.close()
      latest = value
      onFrame?.()
    }
  })().catch(() => {})
  return {
    latest: () => latest,
    stop: () => {
      stopped = true
      void reader.cancel().catch(() => {})
      latest?.close()
      latest = null
    }
  }
}

function shapePath(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, shape: BubbleGeom['shape']): void {
  ctx.beginPath()
  if (shape === 'circle') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.22)
}

/** Screen with the camera bubble drawn where it sits on screen (or bottom-left). */
function createComposite(screenTrack: MediaStreamTrack, camTrack: MediaStreamTrack, initial: Pick<RecState, 'camVisible' | 'bubble'>): Composite {
  const s = screenTrack.getSettings()
  const sw = s.width ?? 1920
  const sh = s.height ?? 1080
  const scale = Math.min(1, MAX_W / sw, MAX_H / sh)
  const width = (Math.round(sw * scale) >> 1) << 1
  const height = (Math.round(sh * scale) >> 1) << 1
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  let { camVisible, bubble } = initial
  let busy = false
  let lastDraw = 0

  const draw = async (): Promise<void> => {
    const now = performance.now()
    if (busy || now - lastDraw < 30) return
    busy = true
    lastDraw = now
    try {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      const sf = screenFrames.latest()
      if (sf) {
        // Fit (letterbox) in case a recorded window is resized.
        const k = Math.min(width / sf.displayWidth, height / sf.displayHeight)
        const w = sf.displayWidth * k
        const h = sf.displayHeight * k
        ctx.drawImage(sf, (width - w) / 2, (height - h) / 2, w, h)
      }
      const cf = camFrames.latest()
      if (camVisible && cf) {
        let bx: number, by: number, bw: number, bh: number
        const shape = bubble?.shape ?? 'circle'
        if (bubble) {
          bx = bubble.x * width
          by = bubble.y * height
          bw = bubble.w * width
          bh = bubble.h * height
        } else {
          bw = bh = Math.round(Math.min(width, height) * 0.24)
          bx = Math.round(bw * 0.16)
          by = height - bh - Math.round(bw * 0.16)
        }
        // Crop the camera to the bubble's aspect (square).
        const src = Math.min(cf.displayWidth, cf.displayHeight)
        const sx = (cf.displayWidth - src) / 2
        const sy = (cf.displayHeight - src) / 2
        const ring = Math.max(2, bw * 0.012)
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.3)'
        ctx.shadowBlur = bw * 0.06
        ctx.shadowOffsetY = bw * 0.015
        shapePath(ctx, bx, by, bw, bh, shape)
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.restore()
        ctx.save()
        shapePath(ctx, bx + ring, by + ring, bw - ring * 2, bh - ring * 2, shape)
        ctx.clip()
        // Mirrored, matching the on-screen bubble.
        ctx.translate(bx * 2 + bw, 0)
        ctx.scale(-1, 1)
        ctx.drawImage(cf, sx, sy, src, src, bx, by, bw, bh)
        ctx.restore()
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) })
      await writer.write(frame)
      frame.close()
    } catch {
      /* track ended */
    } finally {
      busy = false
    }
  }

  // Camera frames arrive at a steady ~30fps, so they drive the output;
  // the timer is a fallback for when the camera stalls.
  const screenFrames = frameReader(screenTrack)
  const camFrames = frameReader(camTrack, () => void draw())
  const timer = setInterval(() => {
    if (performance.now() - lastDraw > 60) void draw()
  }, 50)

  return {
    track: generator as MediaStreamTrack,
    update: (st) => {
      camVisible = st.camVisible
      bubble = st.bubble
    },
    stop: () => {
      clearInterval(timer)
      screenFrames.stop()
      camFrames.stop()
      void writer.close().catch(() => {})
      generator.stop()
    }
  }
}

/** Acquire streams, then hand off to main for the 3-2-1 countdown. */
export async function startSession(opts: RecordOptions): Promise<void> {
  if (active) return
  const cleanups: (() => void)[] = []
  try {
    await window.api.prepareRecording(opts)

    let screen: MediaStream | null = null
    let cam: MediaStream | null = null
    if (opts.mode !== 'screen') {
      cam = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      })
      cleanups.push(() => stopAll(cam))
    }
    if (opts.mode !== 'cam') {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: opts.systemAudio })
      cleanups.push(() => stopAll(screen))
    }

    let videoTrack: MediaStreamTrack
    let composite: Composite | null = null
    if (opts.mode === 'cam') videoTrack = cam!.getVideoTracks()[0]
    else if (opts.mode === 'screen-cam') {
      composite = createComposite(screen!.getVideoTracks()[0], cam!.getVideoTracks()[0], await window.api.getState())
      cleanups.push(() => composite?.stop())
      videoTrack = composite.track
    } else videoTrack = screen!.getVideoTracks()[0]

    // Mix mic + system audio into one track.
    const audioTracks: MediaStreamTrack[] = []
    if (opts.micId !== null) {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.micId ? { exact: opts.micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      cleanups.push(() => stopAll(mic))
      audioTracks.push(...mic.getAudioTracks())
    }
    if (screen) audioTracks.push(...screen.getAudioTracks())
    let audioOut: MediaStreamTrack[] = audioTracks
    if (audioTracks.length > 1) {
      const ctx = new AudioContext()
      const dest = ctx.createMediaStreamDestination()
      for (const t of audioTracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest)
      cleanups.push(() => void ctx.close())
      audioOut = dest.stream.getAudioTracks()
    }

    // If the recorded window closes, finish the recording.
    screen?.getVideoTracks()[0].addEventListener('ended', () => window.api.control('stop'))

    active = {
      opts,
      stream: new MediaStream([videoTrack, ...audioOut]),
      cleanups,
      recorder: null,
      composite
    }
    await window.api.startCountdown()
  } catch (err) {
    cleanups.forEach((fn) => fn())
    active = null
    await window.api.discardRecording()
    throw err
  }
}

function pickMime(): string {
  return (
    ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    ) ?? 'video/webm'
  )
}

function begin(): void {
  if (!active) return
  const recorder = new MediaRecorder(active.stream, {
    mimeType: pickMime(),
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000
  })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chunkChain = chunkChain.then(async () => window.api.writeChunk(await e.data.arrayBuffer()))
  }
  active.recorder = recorder
  recorder.start(1000)
  void window.api.recordingStarted()
}

function stopRecorder(): Promise<void> {
  const r = active?.recorder
  if (!r || r.state === 'inactive') return Promise.resolve()
  return new Promise((resolve) => {
    r.onstop = () => void chunkChain.then(() => resolve())
    r.stop()
  })
}

function teardown(): void {
  active?.cleanups.forEach((fn) => fn())
  active = null
}

export async function handleCommand(cmd: RecCommand): Promise<void> {
  if (!active) return
  try {
    switch (cmd) {
      case 'start':
        begin()
        break
      case 'pause':
        active.recorder?.pause()
        break
      case 'resume':
        active.recorder?.resume()
        break
      case 'restart':
        await stopRecorder()
        active.recorder = null
        await window.api.restartRecording()
        break
      case 'cancel':
        await stopRecorder()
        teardown()
        await window.api.discardRecording()
        onFinished?.(null)
        break
      case 'stop': {
        await stopRecorder()
        teardown()
        const rec = await window.api.finishRecording()
        onFinished?.(rec)
        break
      }
    }
  } catch (err) {
    teardown()
    await window.api.discardRecording().catch(() => {})
    onError?.(err instanceof Error ? err.message : String(err))
  }
}

export function updateFromState(s: RecState): void {
  active?.composite?.update(s)
}
