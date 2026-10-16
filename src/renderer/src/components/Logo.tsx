import { useId } from 'react'

/** The Froom mark: a bold F with a record dot. Same art as resources/logo.svg. */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId()
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 512 512" aria-label="Froom">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8273FF" />
          <stop offset="1" stopColor="#4F3FE0" />
        </linearGradient>
        <linearGradient id={`${id}dot`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF7A8F" />
          <stop offset="1" stopColor="#F0365A" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}bg)`} />
      <g fill="#fff">
        <rect x="138" y="112" width="76" height="288" rx="38" />
        <rect x="138" y="112" width="236" height="76" rx="38" />
        <rect x="138" y="226" width="164" height="70" rx="35" />
        <circle cx="352" cy="352" r="58" />
      </g>
      <circle cx="352" cy="352" r="42" fill={`url(#${id}dot)`} />
    </svg>
  )
}
