import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FolderOpen, Library, Play, Plus, Search, Trash2, Video } from 'lucide-react'
import type { Recording } from '../../../shared/types'
import { formatTime } from '../../../shared/edits'
import RecorderPanel from '../components/RecorderPanel'
import { Confirm } from '../components/Modal'
import { navigate } from '../nav'
import { timeAgo } from '../util'
import { Logo } from '../components/Logo'

export default function Home({ onError }: { onError: (msg: string) => void }) {
  const [recordings, setRecordings] = useState<Recording[] | null>(null)
  const [recorderOpen, setRecorderOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [toDelete, setToDelete] = useState<Recording | null>(null)

  const refresh = useCallback(() => void window.api.listRecordings().then(setRecordings), [])
  useEffect(refresh, [refresh])

  const shown = useMemo(
    () => (recordings ?? []).filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase())),
    [recordings, query]
  )

  const confirmDelete = async (): Promise<void> => {
    if (!toDelete) return
    await window.api.deleteRecording(toDelete.id)
    setToDelete(null)
    refresh()
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand drag">
          <Logo size={28} />
          <span>Froom</span>
        </div>
        <button className="btn primary new-video" onClick={() => setRecorderOpen(true)}>
          <Plus size={18} /> New video
        </button>
        <nav>
          <a className="nav-item on">
            <Library size={18} /> My library
          </a>
          <a className="nav-item" onClick={() => void window.api.openLibraryFolder()}>
            <FolderOpen size={18} /> Open videos folder
          </a>
        </nav>
        <div className="sidebar-foot">
          <div className="tip">
            <div className="tip-title">Shortcuts</div>
            <div>
              <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> stop
            </div>
            <div>
              <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pause
            </div>
          </div>
        </div>
      </aside>

      <main className="content">
        <div className="content-bar drag">
          <div className="search no-drag">
            <Search size={16} />
            <input placeholder="Search videos" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        <div className="content-scroll">
          <div className="page-head">
            <div>
              <h1>My library</h1>
              <p className="muted">
                {recordings ? `${recordings.length} video${recordings.length === 1 ? '' : 's'}` : ' '}
              </p>
            </div>
            <button className="btn primary" onClick={() => setRecorderOpen(true)}>
              <Video size={17} /> Record a video
            </button>
          </div>

          {recordings && recordings.length === 0 && (
            <div className="empty">
              <div className="empty-icon">
                <Video size={28} />
              </div>
              <h2>Record your first video</h2>
              <p className="muted">Capture your screen and camera, trim it, and save it as an MP4.</p>
              <button className="btn primary" onClick={() => setRecorderOpen(true)}>
                <Plus size={18} /> New video
              </button>
            </div>
          )}

          {recordings && recordings.length > 0 && shown.length === 0 && <p className="muted">No videos match “{query}”.</p>}

          <div className="grid">
            {shown.map((r) => (
              <article key={r.id} className="card" onClick={() => navigate(`/editor/${r.id}`)}>
                <div className="thumb">
                  <img src={`media://${r.id}/thumb.jpg`} alt="" draggable={false} />
                  <span className="play-hover">
                    <Play size={22} fill="currentColor" />
                  </span>
                  <span className="duration">{formatTime(r.duration)}</span>
                  <button
                    className="card-delete"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setToDelete(r)
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="card-body">
                  <div className="card-title">{r.title}</div>
                  <div className="card-meta">
                    <span>{timeAgo(r.createdAt)}</span>
                    {r.exportedPath && (
                      <span className="saved-badge">
                        <CheckCircle2 size={13} /> MP4 saved
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </main>

      {recorderOpen && <RecorderPanel onClose={() => setRecorderOpen(false)} onError={onError} />}
      {toDelete && (
        <Confirm
          title="Delete this video?"
          body={`“${toDelete.title}” will be removed from your library. MP4 files you already saved are kept.`}
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  )
}
