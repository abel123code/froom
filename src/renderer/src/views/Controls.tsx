import { useEffect, useState } from 'react'
import type { RecState } from '../../../shared/types'
import { formatTime } from '../../../shared/edits'
import { Circle, GripVertical, MoveUpRight, Pause, Pencil, Play, RotateCcw, Trash2, Video, VideoOff } from 'lucide-react'
import type { DrawTool } from '../../../shared/types'

const TOOLS: { id: DrawTool; icon: typeof Pencil; label: string }[] = [
  { id: 'pen', icon: Pencil, label: 'Pen' },
  { id: 'arrow', icon: MoveUpRight, label: 'Arrow' },
  { id: 'circle', icon: Circle, label: 'Circle' }
]
const COLORS = ['#ff3b5c', '#ffc83d', '#2ecc71', '#625df5', '#ffffff']

/** Floating control bar. Content-protected, so it never appears in the recording. */
export default function Controls() {
  const [state, setState] = useState<RecState | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    void window.api.getState().then(setState)
    const off = window.api.onState(setState)
    const timer = setInterval(() => tick((n) => n + 1), 250)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  if (!state) return null
  const elapsed = (state.elapsedBefore + (state.runningSince ? Date.now() - state.runningSince : 0)) / 1000
  const paused = state.status === 'paused'

  return (
    <div className="controls">
      <div className="grip" title="Drag">
        <GripVertical size={16} />
      </div>
      <button className="ctl stop" onClick={() => window.api.control('stop')} title="Finish recording (Alt+Shift+L)">
        <span className="stop-square" />
      </button>
      <span className={`time ${paused ? 'paused' : ''}`}>{paused ? 'Paused' : formatTime(elapsed)}</span>
      <span className="sep" />
      <button
        className="ctl"
        onClick={() => window.api.control(paused ? 'resume' : 'pause')}
        title={paused ? 'Resume (Alt+Shift+P)' : 'Pause (Alt+Shift+P)'}
      >
        {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
      </button>
      <button className="ctl" onClick={() => window.api.control('restart')} title="Restart recording">
        <RotateCcw size={18} />
      </button>
      <button className="ctl" onClick={() => window.api.control('cancel')} title="Delete recording">
        <Trash2 size={18} />
      </button>
      {state.canAnnotate && (
        <button
          className={`ctl ${state.drawing ? 'active' : ''}`}
          onClick={() => window.api.control('toggle-draw')}
          title={state.drawing ? 'Stop drawing (Esc)' : 'Draw on screen (Alt+Shift+D)'}
        >
          <Pencil size={18} />
        </button>
      )}
      {state.hasCam && (
        <button className="ctl" onClick={() => window.api.control('toggle-cam')} title="Show/hide camera">
          {state.camVisible ? <Video size={18} /> : <VideoOff size={18} />}
        </button>
      )}
      {state.drawing && (
        <>
          <span className="sep" />
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`ctl sm ${state.drawTool === t.id ? 'active' : ''}`}
              onClick={() => window.api.setDraw({ drawTool: t.id })}
              title={t.label}
            >
              <t.icon size={16} />
            </button>
          ))}
          <span className="sep" />
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${state.drawColor === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => window.api.setDraw({ drawColor: c })}
              title="Colour"
            />
          ))}
        </>
      )}
    </div>
  )
}
