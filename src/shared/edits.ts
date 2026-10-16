import type { Cut, Edits } from './types'

export interface Range {
  start: number
  end: number
}

export function defaultEdits(duration: number): Edits {
  return { trimStart: 0, trimEnd: duration, cuts: [] }
}

/** Sort and merge overlapping cuts. A merged cut is 'manual' if any part was. */
export function mergeCuts(cuts: Cut[]): Cut[] {
  const sorted = cuts.filter((c) => c.end - c.start > 0.01).sort((a, b) => a.start - b.start)
  const out: Cut[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + 0.01) {
      last.end = Math.max(last.end, c.end)
      if (c.kind === 'manual') last.kind = 'manual'
    } else {
      out.push({ ...c })
    }
  }
  return out
}

/** The parts of the video that survive trimming and cuts. */
export function keepRanges(edits: Edits): Range[] {
  const ranges: Range[] = []
  let cursor = edits.trimStart
  for (const c of mergeCuts(edits.cuts)) {
    if (c.end <= cursor) continue
    if (c.start >= edits.trimEnd) break
    if (c.start > cursor) ranges.push({ start: cursor, end: Math.min(c.start, edits.trimEnd) })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < edits.trimEnd) ranges.push({ start: cursor, end: edits.trimEnd })
  return ranges.filter((r) => r.end - r.start > 0.05)
}

export function finalDuration(edits: Edits): number {
  return keepRanges(edits).reduce((sum, r) => sum + (r.end - r.start), 0)
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const h = Math.floor(m / 60)
  const mm = h ? String(m % 60).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}
