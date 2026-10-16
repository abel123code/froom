import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import Home from './views/Home'
import Editor from './views/Editor'
import Bubble from './views/Bubble'
import Controls from './views/Controls'
import Countdown from './views/Countdown'
import Overlay from './views/Overlay'
import { Modal } from './components/Modal'
import { navigate } from './nav'
import { handleCommand, setRecorderCallbacks, updateFromState } from './recorder'

function parseHash(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, '') || '/home'
  const [path, query] = raw.split('?')
  return { path, params: new URLSearchParams(query) }
}

/** The main window: library/editor, and the hidden recorder. */
function MainWindow() {
  const [route, setRoute] = useState(parseHash())
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    setRecorderCallbacks(
      (rec) => {
        setProcessing(false)
        if (rec) navigate(`/editor/${rec.id}`)
      },
      (msg) => {
        setProcessing(false)
        setError(msg)
      }
    )
    const offCmd = window.api.onCommand((cmd) => {
      if (cmd === 'stop') setProcessing(true)
      void handleCommand(cmd)
    })
    const offState = window.api.onState(updateFromState)
    return () => {
      window.removeEventListener('hashchange', onHash)
      offCmd()
      offState()
    }
  }, [])

  const editorId = route.path.startsWith('/editor/') ? route.path.slice('/editor/'.length) : null
  return (
    <>
      {editorId ? <Editor key={editorId} id={editorId} /> : <Home onError={setError} />}
      {processing && (
        <Modal>
          <div className="busy">
            <div className="spinner" />
            <div>
              <div className="busy-title">Finishing your video</div>
              <div className="muted">This only takes a moment…</div>
            </div>
          </div>
        </Modal>
      )}
      {error && (
        <Modal onClose={() => setError(null)}>
          <div className="dialog">
            <div className="dialog-icon danger">
              <AlertCircle size={22} />
            </div>
            <h3>Something went wrong</h3>
            <p className="muted">{error}</p>
            <div className="dialog-actions">
              <button className="btn primary" onClick={() => setError(null)}>
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

export default function App() {
  const { path, params } = parseHash()
  useEffect(() => {
    document.body.dataset.route = path.split('/')[1] || 'home'
  }, [path])
  if (path === '/bubble') return <Bubble initialCamera={params.get('cam') ?? ''} />
  if (path === '/controls') return <Controls />
  if (path === '/countdown') return <Countdown />
  if (path === '/overlay') return <Overlay />
  return <MainWindow />
}
