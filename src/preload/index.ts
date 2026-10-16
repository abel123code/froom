import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CaptureSource, ControlAction, DrawTool, Edits, RecCommand, Recording, RecordOptions, RecState } from '../shared/types'
import type { Range } from '../shared/edits'

function on<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('sources:list'),

  listRecordings: (): Promise<Recording[]> => ipcRenderer.invoke('library:list'),
  getRecording: (id: string): Promise<Recording | null> => ipcRenderer.invoke('library:get', id),
  deleteRecording: (id: string): Promise<void> => ipcRenderer.invoke('library:delete', id),
  renameRecording: (id: string, title: string): Promise<Recording | null> => ipcRenderer.invoke('library:rename', id, title),
  saveEdits: (id: string, edits: Edits): Promise<Recording | null> => ipcRenderer.invoke('library:save-edits', id, edits),
  openLibraryFolder: (): Promise<string> => ipcRenderer.invoke('library:folder'),

  showBubble: (cameraId: string, displayId?: string): Promise<void> => ipcRenderer.invoke('bubble:show', cameraId, displayId),
  hideBubble: (): Promise<void> => ipcRenderer.invoke('bubble:hide'),
  setBubbleShape: (shape: 'circle' | 'squircle'): Promise<void> => ipcRenderer.invoke('bubble:shape', shape),
  setBubbleSize: (size: 's' | 'm' | 'l'): Promise<void> => ipcRenderer.invoke('bubble:size', size),
  onBubbleCamera: (cb: (cameraId: string) => void) => on('bubble:camera', cb),

  prepareRecording: (opts: RecordOptions): Promise<string> => ipcRenderer.invoke('rec:prepare', opts),
  startCountdown: (): Promise<void> => ipcRenderer.invoke('rec:countdown'),
  countdownDone: (): void => ipcRenderer.send('countdown:done'),
  recordingStarted: (): Promise<void> => ipcRenderer.invoke('rec:started'),
  writeChunk: (buf: ArrayBuffer): void => ipcRenderer.send('rec:chunk', buf),
  finishRecording: (): Promise<Recording | null> => ipcRenderer.invoke('rec:finish'),
  restartRecording: (): Promise<void> => ipcRenderer.invoke('rec:restart'),
  discardRecording: (): Promise<void> => ipcRenderer.invoke('rec:discard'),
  getState: (): Promise<RecState> => ipcRenderer.invoke('rec:get-state'),
  onState: (cb: (s: RecState) => void) => on('rec:state', cb),
  onCommand: (cb: (cmd: RecCommand) => void) => on('rec:command', cb),
  control: (action: ControlAction): void => ipcRenderer.send('control', action),
  setDraw: (patch: { drawTool?: DrawTool; drawColor?: string }): void => ipcRenderer.send('draw:set', patch),
  onOverlayClick: (cb: (p: { x: number; y: number }) => void) => on('overlay:click', cb),

  getFilmstrip: (id: string): Promise<string | null> => ipcRenderer.invoke('edit:filmstrip', id),
  getPeaks: (id: string): Promise<number[]> => ipcRenderer.invoke('edit:peaks', id),
  detectSilences: (id: string, noiseDb: number, minDuration: number): Promise<Range[]> =>
    ipcRenderer.invoke('edit:silences', id, noiseDb, minDuration),
  exportVideo: (id: string, edits: Edits): Promise<string> => ipcRenderer.invoke('edit:export', id, edits),
  onExportProgress: (cb: (fraction: number) => void) => on('edit:export-progress', cb),
  showInFolder: (p: string): Promise<void> => ipcRenderer.invoke('shell:show', p),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:open', p)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
