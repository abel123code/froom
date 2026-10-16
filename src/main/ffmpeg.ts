import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import type { Range } from '../shared/edits'

// In a packaged app the binary is unpacked next to the asar archive.
const ffmpegPath = (ffmpegStatic as unknown as string).replace('app.asar', 'app.asar.unpacked')

interface RunResult {
  code: number
  stderr: string
}

function run(args: string[], onStderr?: (text: string) => void, onStdout?: (buf: Buffer) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', ...args], { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderr += text
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000)
      onStderr?.(text)
    })
    proc.stdout.on('data', (d: Buffer) => onStdout?.(d))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

function parseTimestamp(ts: string): number {
  const [h, m, s] = ts.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

/** MediaRecorder WebM has no duration/cues; a stream copy fixes seeking. */
export async function remux(input: string, output: string): Promise<boolean> {
  const { code } = await run(['-y', '-i', input, '-c', 'copy', output])
  return code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0
}

export interface ProbeInfo {
  duration: number
  width: number
  height: number
  hasAudio: boolean
}

export async function probe(file: string): Promise<ProbeInfo> {
  // Copying to the null muxer reads every packet, so the last time= is the real duration.
  const { stderr } = await run(['-i', file, '-c', 'copy', '-f', 'null', '-'])
  const times = [...stderr.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)]
  let duration = times.length ? parseTimestamp(times[times.length - 1][1]) : 0
  if (!duration) {
    const m = stderr.match(/Duration: (\d+:\d+:\d+(?:\.\d+)?)/)
    if (m) duration = parseTimestamp(m[1])
  }
  const dims = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/)
  return {
    duration,
    width: dims ? Number(dims[1]) : 0,
    height: dims ? Number(dims[2]) : 0,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(stderr)
  }
}

export async function thumbnail(input: string, output: string, at: number): Promise<void> {
  await run(['-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', output])
}

/** A strip of `count` evenly spaced frames, side by side, for the editor timeline. */
export async function filmstrip(input: string, output: string, duration: number, count = 16): Promise<void> {
  const args = ['-y']
  for (let i = 0; i < count; i++) {
    const t = Math.max(0, Math.min(duration - 0.1, ((i + 0.5) / count) * duration))
    args.push('-ss', t.toFixed(2), '-i', input)
  }
  const scaled = Array.from({ length: count }, (_, i) => `[${i}:v]scale=-2:120,setsar=1[f${i}]`)
  const stack = Array.from({ length: count }, (_, i) => `[f${i}]`).join('') + `hstack=inputs=${count}[out]`
  args.push('-filter_complex', [...scaled, stack].join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '5', output)
  await run(args)
}

/** Audio loudness peaks, `perSecond` values per second, each 0..1. */
export async function peaks(input: string, perSecond = 50): Promise<number[]> {
  const rate = 8000
  const bucket = Math.round(rate / perSecond)
  const out: number[] = []
  let leftover: Buffer = Buffer.alloc(0)
  let max = 0
  let count = 0
  await run(['-i', input, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], undefined, (chunk) => {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
    const usable = buf.length - (buf.length % 2)
    for (let i = 0; i < usable; i += 2) {
      const v = Math.abs(buf.readInt16LE(i))
      if (v > max) max = v
      if (++count === bucket) {
        out.push(max / 32768)
        max = 0
        count = 0
      }
    }
    leftover = buf.subarray(usable)
  })
  if (count) out.push(max / 32768)
  return out
}

/** Silent stretches of at least `minDuration` seconds below `noiseDb`. */
export async function detectSilence(input: string, noiseDb: number, minDuration: number, duration: number): Promise<Range[]> {
  const { stderr } = await run([
    '-i', input, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`, '-f', 'null', '-'
  ])
  const ranges: Range[] = []
  let start: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start: (-?[\d.]+)/)
    if (s) start = Math.max(0, Number(s[1]))
    const e = line.match(/silence_end: ([\d.]+)/)
    if (e && start !== null) {
      ranges.push({ start, end: Number(e[1]) })
      start = null
    }
  }
  if (start !== null) ranges.push({ start, end: duration })
  return ranges
}

/** Cut the kept ranges out of the source and join them into an H.264/AAC MP4. */
export async function exportMp4(
  input: string,
  output: string,
  ranges: Range[],
  hasAudio: boolean,
  onProgress: (fraction: number) => void
): Promise<void> {
  const n = ranges.length
  if (!n) throw new Error('Nothing left to export — every part of the video is cut.')
  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0)

  const parts: string[] = []
  const vSplit = ranges.map((_, i) => `[sv${i}]`).join('')
  parts.push(`[0:v]split=${n}${vSplit}`)
  if (hasAudio) parts.push(`[0:a]asplit=${n}${ranges.map((_, i) => `[sa${i}]`).join('')}`)
  let concatIn = ''
  ranges.forEach((r, i) => {
    const s = r.start.toFixed(3)
    const e = r.end.toFixed(3)
    parts.push(`[sv${i}]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`)
    if (hasAudio) parts.push(`[sa${i}]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`)
    concatIn += hasAudio ? `[v${i}][a${i}]` : `[v${i}]`
  })
  parts.push(`${concatIn}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? '[cv][outa]' : '[cv]'}`)
  parts.push(`[cv]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[outv]`)

  const scriptFile = path.join(os.tmpdir(), `froom-filter-${Date.now()}.txt`)
  fs.writeFileSync(scriptFile, parts.join(';\n'))
  const tmpOut = output + '.part.mp4'
  try {
    const args = ['-y', '-i', input, '-filter_complex_script', scriptFile, '-map', '[outv]']
    if (hasAudio) args.push('-map', '[outa]', '-c:a', 'aac', '-b:a', '160k')
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', '30', '-movflags', '+faststart', tmpOut)
    const { code, stderr } = await run(args, (text) => {
      const m = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)
      if (m && total > 0) onProgress(Math.min(1, parseTimestamp(m[m.length - 1].slice(5)) / total))
    })
    if (code !== 0) throw new Error('ffmpeg failed: ' + stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' '))
    fs.renameSync(tmpOut, output)
    onProgress(1)
  } finally {
    fs.rmSync(scriptFile, { force: true })
    fs.rmSync(tmpOut, { force: true })
  }
}
