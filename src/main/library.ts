import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Recording } from '../shared/types'

/** Exported MP4s land here, where the user can find them. */
export const rootDir = (): string => path.join(app.getPath('videos'), 'Froom')

/** Recordings made before the rename lived in Videos\LoomClone. */
export function migrateOldFolder(): void {
  const old = path.join(app.getPath('videos'), 'LoomClone')
  if (fs.existsSync(old) && !fs.existsSync(rootDir())) fs.renameSync(old, rootDir())
}
/** Raw recordings, thumbnails and edit state live in a hidden subfolder. */
const dataDir = (): string => path.join(rootDir(), '.recordings')

export const isValidId = (id: string): boolean => /^[\w-]+$/.test(id)
export const recDir = (id: string): string => {
  if (!isValidId(id)) throw new Error('Bad recording id')
  return path.join(dataDir(), id)
}
export const rawPath = (id: string): string => path.join(recDir(id), 'raw.webm')
export const videoPath = (id: string): string => path.join(recDir(id), 'video.webm')
export const thumbPath = (id: string): string => path.join(recDir(id), 'thumb.jpg')
export const filmstripPath = (id: string): string => path.join(recDir(id), 'frames.jpg')
export const peaksPath = (id: string): string => path.join(recDir(id), 'peaks.json')
const metaPath = (id: string): string => path.join(recDir(id), 'meta.json')

export function newId(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
}

export function defaultTitle(): string {
  const d = new Date()
  return `Recording ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function list(): Recording[] {
  if (!fs.existsSync(dataDir())) return []
  const out: Recording[] = []
  for (const id of fs.readdirSync(dataDir())) {
    const rec = get(id)
    if (rec) out.push(rec)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function get(id: string): Recording | null {
  try {
    const rec = JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as Recording
    // Exports made before the rename moved along with the folder.
    const oldRoot = path.join(app.getPath('videos'), 'LoomClone')
    if (rec.exportedPath?.startsWith(oldRoot)) rec.exportedPath = rootDir() + rec.exportedPath.slice(oldRoot.length)
    return rec
  } catch {
    return null
  }
}

export function save(rec: Recording): void {
  fs.mkdirSync(recDir(rec.id), { recursive: true })
  fs.writeFileSync(metaPath(rec.id), JSON.stringify(rec, null, 2))
}

export function update(id: string, patch: Partial<Recording>): Recording | null {
  const rec = get(id)
  if (!rec) return null
  const next = { ...rec, ...patch, id }
  save(next)
  return next
}

export function remove(id: string): void {
  fs.rmSync(recDir(id), { recursive: true, force: true })
}

/** A free "<title>.mp4" path in the root folder. */
export function exportPathFor(title: string): string {
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Recording'
  fs.mkdirSync(rootDir(), { recursive: true })
  let candidate = path.join(rootDir(), `${safe}.mp4`)
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(rootDir(), `${safe} (${i}).mp4`)
  return candidate
}
