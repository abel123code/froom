import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  type Display,
  type IpcMainInvokeEvent
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { uIOhook } from 'uiohook-napi'
import * as lib from './library'
import * as ff from './ffmpeg'
import { keepRanges, mergeCuts } from '../shared/edits'
import type { BubbleGeom, CaptureSource, ControlAction, Edits, RecCommand, RecordOptions, RecState } from '../shared/types'

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

const preload = path.join(__dirname, '../preload/index.js')
const appIcon = path.join(__dirname, '../../resources/icon.png')
const BUBBLE_SIZES = { s: 180, m: 260, l: 360 } as const
const CONTROLS_SIZE = { width: 380, height: 64 }
/** Extra control-bar width for the pen tools and colours. */
const DRAW_TOOLS_WIDTH = 236

let mainWin: BrowserWindow | null = null
let bubbleWin: BrowserWindow | null = null
let controlsWin: BrowserWindow | null = null
let countdownWin: BrowserWindow | null = null
/** Full-screen see-through layer for click rings and drawings. It is recorded on purpose. */
let overlayWin: BrowserWindow | null = null
let hookRunning = false

interface Session {
  id: string
  opts: RecordOptions
  stream: fs.WriteStream | null
}
let rec: Session | null = null
let state: RecState = {
  status: 'idle',
  elapsedBefore: 0,
  runningSince: 0,
  camVisible: true,
  hasCam: false,
  bubble: null,
  canAnnotate: false,
  drawing: false,
  drawTool: 'pen',
  drawColor: '#ff3b5c'
}
let bubbleShape: BubbleGeom['shape'] = 'circle'

// ---------- windows ----------

function load(win: BrowserWindow, route: string): void {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route })
}

function webPrefs(): Electron.WebPreferences {
  return { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false }
}

function createMainWindow(): void {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'Froom',
    icon: appIcon,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1f1d2b', height: 52 },
    webPreferences: webPrefs()
  })
  load(mainWin, '/home')
  mainWin.on('closed', () => {
    mainWin = null
    app.quit()
  })
}

function overlayWindow(opts: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: webPrefs(),
    ...opts
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  return win
}

function displayFor(displayId?: string): Display {
  return screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay()
}

function showBubble(cameraId: string | undefined, displayId?: string): void {
  const display = displayFor(displayId)
  if (!bubbleWin || bubbleWin.isDestroyed()) {
    const size = BUBBLE_SIZES.m
    const wa = display.workArea
    bubbleWin = overlayWindow({ width: size, height: size, x: wa.x + 32, y: wa.y + wa.height - size - 32 })
    // The recorder draws the face into the video itself, so keep this window out of captures.
    bubbleWin.setContentProtection(true)
    bubbleWin.on('closed', () => (bubbleWin = null))
    bubbleWin.on('move', updateBubbleGeom)
    bubbleWin.on('resize', updateBubbleGeom)
    load(bubbleWin, `/bubble?cam=${encodeURIComponent(cameraId ?? '')}`)
    bubbleWin.once('ready-to-show', () => bubbleWin?.showInactive())
    return
  }
  bubbleWin.webContents.send('bubble:camera', cameraId ?? '')
  // Keep the bubble on the display being recorded.
  const b = bubbleWin.getBounds()
  const d = screen.getDisplayMatching(b)
  if (d.id !== display.id) {
    const wa = display.workArea
    bubbleWin.setBounds({ ...b, x: wa.x + 32, y: wa.y + wa.height - b.height - 32 })
  }
  if (!bubbleWin.isVisible()) bubbleWin.showInactive()
}

/** Bubble position relative to the screen being recorded. */
function bubbleGeom(): BubbleGeom | null {
  if (!rec || rec.opts.sourceKind !== 'screen' || !bubbleWin || bubbleWin.isDestroyed()) return null
  const d = displayFor(rec.opts.displayId).bounds
  const b = bubbleWin.getBounds()
  return { x: (b.x - d.x) / d.width, y: (b.y - d.y) / d.height, w: b.width / d.width, h: b.height / d.height, shape: bubbleShape }
}

function updateBubbleGeom(): void {
  if (rec) setState({ bubble: bubbleGeom() })
}

function closeBubble(): void {
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.close()
  bubbleWin = null
}

function showControls(displayId?: string): void {
  if (controlsWin && !controlsWin.isDestroyed()) {
    controlsWin.showInactive()
    return
  }
  const wa = displayFor(displayId).workArea
  controlsWin = overlayWindow({
    ...CONTROLS_SIZE,
    x: Math.round(wa.x + (wa.width - CONTROLS_SIZE.width) / 2),
    y: wa.y + wa.height - CONTROLS_SIZE.height - 24
  })
  // Hidden from screen capture so it never shows up in the video.
  controlsWin.setContentProtection(true)
  controlsWin.on('closed', () => (controlsWin = null))
  load(controlsWin, '/controls')
  controlsWin.once('ready-to-show', () => controlsWin?.showInactive())
}

function closeControls(): void {
  if (controlsWin && !controlsWin.isDestroyed()) controlsWin.close()
  controlsWin = null
}

// ---------- annotations (drawing + click rings) ----------

function showOverlay(displayId?: string): void {
  if (overlayWin && !overlayWin.isDestroyed()) return
  overlayWin = overlayWindow({ ...displayFor(displayId).bounds, focusable: true })
  overlayWin.setIgnoreMouseEvents(true)
  overlayWin.on('closed', () => (overlayWin = null))
  load(overlayWin, '/overlay')
  overlayWin.once('ready-to-show', () => {
    overlayWin?.showInactive()
    // Bubble and controls stay above the overlay so they can still be dragged and clicked.
    bubbleWin?.moveTop()
    controlsWin?.moveTop()
  })
}

function closeOverlay(): void {
  stopClickHook()
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
  overlayWin = null
}

function setDrawing(drawing: boolean): void {
  if (!overlayWin || overlayWin.isDestroyed() || !state.canAnnotate) drawing = false
  if (drawing === state.drawing) return
  overlayWin?.setIgnoreMouseEvents(!drawing)
  if (drawing) overlayWin?.focus()
  else overlayWin?.blur()
  if (controlsWin && !controlsWin.isDestroyed()) {
    const b = controlsWin.getBounds()
    const width = CONTROLS_SIZE.width + (drawing ? DRAW_TOOLS_WIDTH : 0)
    controlsWin.setBounds({ ...b, x: Math.round(b.x - (width - b.width) / 2), width })
    controlsWin.moveTop()
  }
  setState({ drawing })
}

function startClickHook(): void {
  if (hookRunning) return
  try {
    uIOhook.start()
    hookRunning = true
  } catch {
    /* hooks unavailable; recording still works without click rings */
  }
}

function stopClickHook(): void {
  if (!hookRunning) return
  uIOhook.stop()
  hookRunning = false
}

function onGlobalClick(x: number, y: number): void {
  if (!overlayWin || overlayWin.isDestroyed() || state.status !== 'recording' || state.drawing) return
  // The hook reports physical pixels; windows are laid out in DIPs.
  const p = process.platform === 'win32' ? screen.screenToDipPoint({ x, y }) : { x, y }
  const c = controlsWin && !controlsWin.isDestroyed() ? controlsWin.getBounds() : null
  if (c && p.x >= c.x && p.x <= c.x + c.width && p.y >= c.y && p.y <= c.y + c.height) return
  const o = overlayWin.getBounds()
  if (p.x < o.x || p.y < o.y || p.x > o.x + o.width || p.y > o.y + o.height) return
  overlayWin.webContents.send('overlay:click', { x: p.x - o.x, y: p.y - o.y })
}

function showCountdown(displayId?: string): void {
  closeCountdown()
  const bounds = displayFor(displayId).bounds
  countdownWin = overlayWindow({ ...bounds, focusable: false })
  countdownWin.setContentProtection(true)
  countdownWin.setIgnoreMouseEvents(true)
  countdownWin.on('closed', () => (countdownWin = null))
  load(countdownWin, '/countdown')
  countdownWin.once('ready-to-show', () => countdownWin?.showInactive())
}

function closeCountdown(): void {
  if (countdownWin && !countdownWin.isDestroyed()) countdownWin.close()
  countdownWin = null
}

// ---------- recording state ----------

function setState(patch: Partial<RecState>): void {
  state = { ...state, ...patch }
  for (const w of [mainWin, bubbleWin, controlsWin, overlayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('rec:state', state)
  }
}

function command(cmd: RecCommand): void {
  mainWin?.webContents.send('rec:command', cmd)
}

function elapsedNow(): number {
  return state.elapsedBefore + (state.runningSince ? Date.now() - state.runningSince : 0)
}

function openRawStream(id: string): fs.WriteStream {
  fs.mkdirSync(lib.recDir(id), { recursive: true })
  return fs.createWriteStream(lib.rawPath(id))
}

function closeStream(s: fs.WriteStream | null): Promise<void> {
  return new Promise((resolve) => {
    if (!s || s.closed) return resolve()
    s.end(() => resolve())
  })
}

function startCountdown(): void {
  if (!rec) return
  mainWin?.hide()
  setDrawing(false)
  closeControls()
  setState({ status: 'countdown', elapsedBefore: 0, runningSince: 0 })
  showCountdown(rec.opts.displayId)
}

function endSessionUi(): void {
  setState({ drawing: false })
  closeOverlay()
  closeCountdown()
  closeControls()
  closeBubble()
  if (mainWin) {
    mainWin.show()
    mainWin.focus()
  }
}

function control(action: ControlAction): void {
  if (!rec) return
  switch (action) {
    case 'pause':
      if (state.status !== 'recording') return
      setState({ status: 'paused', elapsedBefore: elapsedNow(), runningSince: 0 })
      command('pause')
      break
    case 'resume':
      if (state.status !== 'paused') return
      setState({ status: 'recording', runningSince: Date.now() })
      command('resume')
      break
    case 'stop':
      if (state.status !== 'recording' && state.status !== 'paused') return
      setDrawing(false)
      setState({ status: 'processing', elapsedBefore: elapsedNow(), runningSince: 0 })
      closeControls()
      command('stop')
      break
    case 'restart':
      command('restart')
      break
    case 'cancel':
      command('cancel')
      break
    case 'toggle-draw':
      if (state.status === 'recording' || state.status === 'paused') setDrawing(!state.drawing)
      break
    case 'toggle-cam': {
      const camVisible = !state.camVisible
      if (bubbleWin && !bubbleWin.isDestroyed()) {
        if (camVisible) bubbleWin.showInactive()
        else bubbleWin.hide()
      }
      setState({ camVisible })
      break
    }
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, fn)
  }

  handle('sources:list', async (): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false
    })
    return sources
      .filter((s) => !s.name.startsWith('Froom') && (s.id.startsWith('screen') || s.name.trim()))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        displayId: s.display_id,
        thumbnail: s.thumbnail.toDataURL()
      }))
  })

  handle('library:list', () => lib.list())
  handle('library:get', (_e, id: string) => lib.get(id))
  handle('library:delete', (_e, id: string) => lib.remove(id))
  handle('library:rename', (_e, id: string, title: string) => lib.update(id, { title: title.trim() || 'Untitled' }))
  handle('library:save-edits', (_e, id: string, edits: Edits) => lib.update(id, { edits }))
  handle('library:folder', () => {
    fs.mkdirSync(lib.rootDir(), { recursive: true })
    return shell.openPath(lib.rootDir())
  })

  handle('bubble:show', (_e, cameraId: string, displayId?: string) => showBubble(cameraId, displayId))
  handle('bubble:hide', () => {
    if (state.status === 'idle') closeBubble()
  })
  handle('bubble:shape', (_e, shape: BubbleGeom['shape']) => {
    bubbleShape = shape
    updateBubbleGeom()
  })
  handle('bubble:size', (_e, size: keyof typeof BUBBLE_SIZES) => {
    if (!bubbleWin) return
    const px = BUBBLE_SIZES[size] ?? BUBBLE_SIZES.m
    const b = bubbleWin.getBounds()
    // Grow/shrink from the bottom-left corner so the bubble stays anchored.
    bubbleWin.setBounds({ x: b.x, y: b.y + b.height - px, width: px, height: px })
  })

  handle('rec:prepare', (_e, opts: RecordOptions) => {
    const id = lib.newId()
    rec = { id, opts, stream: openRawStream(id) }
    const hasCam = opts.mode !== 'screen'
    if (hasCam) showBubble(opts.cameraId, opts.displayId)
    else closeBubble()
    setState({
      status: 'idle',
      camVisible: true,
      hasCam,
      bubble: hasCam ? bubbleGeom() : null,
      canAnnotate: opts.mode !== 'cam' && opts.sourceKind === 'screen',
      drawing: false
    })
    return id
  })
  handle('rec:countdown', () => startCountdown())
  handle('rec:started', () => {
    setState({ status: 'recording', elapsedBefore: 0, runningSince: Date.now() })
    showControls(rec?.opts.displayId)
    if (rec && state.canAnnotate) {
      showOverlay(rec.opts.displayId)
      if (rec.opts.highlightClicks) startClickHook()
    }
  })
  ipcMain.on('rec:chunk', (_e, buf: ArrayBuffer) => {
    rec?.stream?.write(Buffer.from(buf))
  })
  handle('rec:restart', async () => {
    if (!rec) return
    await closeStream(rec.stream)
    rec.stream = openRawStream(rec.id)
    startCountdown()
  })
  handle('rec:discard', async () => {
    if (rec) {
      await closeStream(rec.stream)
      lib.remove(rec.id)
    }
    rec = null
    setState({ status: 'idle', elapsedBefore: 0, runningSince: 0 })
    endSessionUi()
  })
  handle('rec:finish', async () => {
    if (!rec) return null
    const { id } = rec
    await closeStream(rec.stream)
    rec = null
    setState({ status: 'processing' })
    endSessionUi()
    try {
      const raw = lib.rawPath(id)
      const video = lib.videoPath(id)
      if (await ff.remux(raw, video)) fs.rmSync(raw, { force: true })
      else fs.renameSync(raw, video)
      const info = await ff.probe(video)
      await ff.thumbnail(video, lib.thumbPath(id), Math.min(1, info.duration / 2))
      const recording = {
        id,
        title: lib.defaultTitle(),
        createdAt: Date.now(),
        ...info,
        edits: { trimStart: 0, trimEnd: info.duration, cuts: [] }
      }
      lib.save(recording)
      return recording
    } finally {
      setState({ status: 'idle', elapsedBefore: 0, runningSince: 0 })
    }
  })

  ipcMain.on('countdown:done', () => {
    closeCountdown()
    // Give the overlay a beat to disappear before the first frame.
    setTimeout(() => command('start'), 150)
  })
  ipcMain.on('control', (_e, action: ControlAction) => control(action))
  ipcMain.on('draw:set', (_e, patch: Pick<RecState, 'drawTool' | 'drawColor'>) => {
    setState({ drawTool: patch.drawTool ?? state.drawTool, drawColor: patch.drawColor ?? state.drawColor })
    if (state.drawing) overlayWin?.focus()
  })
  handle('rec:get-state', () => state)

  handle('edit:peaks', async (_e, id: string) => {
    const cache = lib.peaksPath(id)
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'))
    const p = await ff.peaks(lib.videoPath(id))
    fs.writeFileSync(cache, JSON.stringify(p.map((v) => Math.round(v * 1000) / 1000)))
    return p
  })
  handle('edit:filmstrip', async (_e, id: string) => {
    const r = lib.get(id)
    if (!r) return null
    const file = lib.filmstripPath(id)
    if (!fs.existsSync(file)) await ff.filmstrip(lib.videoPath(id), file, r.duration)
    return fs.existsSync(file) ? `media://${id}/frames.jpg` : null
  })
  handle('edit:silences', async (_e, id: string, noiseDb: number, minDuration: number) => {
    const r = lib.get(id)
    if (!r) return []
    return ff.detectSilence(lib.videoPath(id), noiseDb, minDuration, r.duration)
  })
  handle('edit:export', async (e, id: string, edits: Edits) => {
    const r = lib.get(id)
    if (!r) throw new Error('Recording not found')
    const ranges = keepRanges({ ...edits, cuts: mergeCuts(edits.cuts) })
    // Re-exporting overwrites this recording's previous export of the same name.
    const prev = r.exportedPath
    const safeTitle = r.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
    const out =
      prev && path.basename(prev, '.mp4').startsWith(safeTitle) && fs.existsSync(path.dirname(prev))
        ? prev
        : lib.exportPathFor(r.title)
    await ff.exportMp4(lib.videoPath(id), out, ranges, r.hasAudio, (f) => e.sender.send('edit:export-progress', f))
    lib.update(id, { exportedPath: out, edits })
    return out
  })
  handle('shell:show', (_e, p: string) => shell.showItemInFolder(p))
  handle('shell:open', (_e, p: string) => shell.openPath(p))
}

// ---------- media:// protocol (with Range support so <video> can seek) ----------

function registerMediaProtocol(): void {
  protocol.handle('media', async (req) => {
    const url = new URL(req.url)
    const id = url.hostname
    const name = path.basename(decodeURIComponent(url.pathname))
    if (!lib.isValidId(id) || !['video.webm', 'thumb.jpg', 'frames.jpg'].includes(name)) return new Response('Not found', { status: 404 })
    const file = path.join(lib.recDir(id), name)
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 })
    const size = fs.statSync(file).size
    const type = name.endsWith('.jpg') ? 'image/jpeg' : 'video/webm'
    const range = req.headers.get('range')
    const m = range?.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
    const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream
    return new Response(body, {
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
    })
  })
}

// ---------- app ----------

app.setAppUserModelId('com.voltade.froom')

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  try {
    lib.migrateOldFolder()
  } catch {
    /* folder in use; keep using the new one */
  }
  registerMediaProtocol()
  registerIpc()

  // Serve the source picked in our own picker to getDisplayMedia().
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const wanted = rec?.opts.sourceId
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
    const source = sources.find((s) => s.id === wanted) ?? sources.find((s) => s.id.startsWith('screen'))
    if (!source) return callback({})
    callback(request.audioRequested && rec?.opts.systemAudio ? { video: source, audio: 'loopback' } : { video: source })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true))

  globalShortcut.register('Alt+Shift+L', () => control('stop'))
  globalShortcut.register('Alt+Shift+P', () => control(state.status === 'paused' ? 'resume' : 'pause'))
  globalShortcut.register('Alt+Shift+D', () => control('toggle-draw'))
  uIOhook.on('mousedown', (e) => onGlobalClick(e.x, e.y))

  createMainWindow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopClickHook()
})
app.on('window-all-closed', () => app.quit())
