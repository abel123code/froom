export type RecordMode = 'screen-cam' | 'screen' | 'cam'

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  displayId: string
  thumbnail: string
}

export interface RecordOptions {
  mode: RecordMode
  sourceId?: string
  sourceKind?: 'screen' | 'window'
  displayId?: string
  cameraId?: string
  micId: string | null
  systemAudio: boolean
  highlightClicks: boolean
}

export interface Cut {
  start: number
  end: number
  kind: 'manual' | 'silence'
}

export interface Edits {
  trimStart: number
  trimEnd: number
  cuts: Cut[]
}

export interface Recording {
  id: string
  title: string
  createdAt: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
  edits?: Edits
  exportedPath?: string
}

/** Where the face bubble sits, as fractions of the recorded screen. */
export interface BubbleGeom {
  x: number
  y: number
  w: number
  h: number
  shape: 'circle' | 'squircle'
}

export type DrawTool = 'pen' | 'arrow' | 'circle'

export type RecStatus = 'idle' | 'countdown' | 'recording' | 'paused' | 'processing'

export interface RecState {
  status: RecStatus
  /** ms recorded before the current running stretch */
  elapsedBefore: number
  /** epoch ms when the current running stretch began (0 when not running) */
  runningSince: number
  camVisible: boolean
  hasCam: boolean
  /** null = no screen position to follow (window/cam recordings): use the bottom-left corner */
  bubble: BubbleGeom | null
  /** Drawing and click rings only show up in full-screen recordings. */
  canAnnotate: boolean
  drawing: boolean
  drawTool: DrawTool
  drawColor: string
}

export type RecCommand = 'start' | 'pause' | 'resume' | 'stop' | 'restart' | 'cancel'
export type ControlAction = 'pause' | 'resume' | 'stop' | 'restart' | 'cancel' | 'toggle-cam' | 'toggle-draw'
