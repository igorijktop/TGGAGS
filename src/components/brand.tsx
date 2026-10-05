import type { LucideIcon } from 'lucide-react'
import type { SVGProps } from 'react'

type P = { size?: number | string; strokeWidth?: number | string; className?: string; style?: React.CSSProperties } & Omit<SVGProps<SVGSVGElement>, 'ref'>

/** GitHub mark (lucide dropped brand icons) – typed as a LucideIcon so it can be used interchangeably. */
export const GithubIcon = (({ size = 16, strokeWidth: _sw, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
)) as unknown as LucideIcon

/** The TGGAGS logo mark: a rounded tile with a code chevron and a spark. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#E2805D" /><stop offset="1" stopColor="#B24E2D" /></linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#lg-a)" />
      <path d="M24 22 14 32l10 10" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M34 44 42 20" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".92" />
      <path d="M47 14l1.8 4.4 4.4 1.8-4.4 1.8L47 26.4l-1.8-4.4-4.4-1.8 4.4-1.8z" fill="#FFE9DD" />
    </svg>
  )
}

/** Small friendly pixel creature used for empty states (original artwork). */
export function Mascot({ size = 72 }: { size?: number }) {
  const px = [
    '..CC....CC..', '..CCCCCCCC..', '.CCCCCCCCCC.', '.CCWWCCWWCC.', '.CCWKCCWKCC.', '.CCCCCCCCCC.', '.CCCCDDCCCC.', '..CCCCCCCC..', '.CC.CCCC.CC.', '.C..C..C..C.'
  ]
  const color: Record<string, string> = { C: '#D97757', W: '#FFF4EC', K: '#2B1B14', D: '#B24E2D' }
  return (
    <svg width={size} height={size * (px.length / 12)} viewBox={`0 0 12 ${px.length}`} shapeRendering="crispEdges" aria-hidden>
      {px.flatMap((row, y) => [...row].map((c, x) => (c === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={color[c]} />)))}
    </svg>
  )
}
