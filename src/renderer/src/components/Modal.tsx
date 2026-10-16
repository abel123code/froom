import { useEffect, type ReactNode } from 'react'

export function Modal({ children, onClose, className = '' }: { children: ReactNode; onClose?: () => void; className?: string }) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${className}`}>{children}</div>
    </div>
  )
}

export function Confirm({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal onClose={onCancel}>
      <div className="dialog">
        <h3>{title}</h3>
        <p className="muted">{body}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
