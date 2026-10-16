import { useEffect, useState } from 'react'

export default function Countdown() {
  const [n, setN] = useState(3)

  useEffect(() => {
    if (n === 0) {
      window.api.countdownDone()
      return
    }
    const t = setTimeout(() => setN(n - 1), 1000)
    return () => clearTimeout(t)
  }, [n])

  return <div className="countdown">{n > 0 && <div key={n} className="countdown-num">{n}</div>}</div>
}
