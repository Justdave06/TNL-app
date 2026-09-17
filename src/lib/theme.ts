/**
 * Brand palette, ported from the Tailwind classes used by the web app
 * (stone-950 base, amber accents, red highlights).
 */
export const colors = {
  bg: '#0c0a09', // stone-950
  surface: '#1c1917', // stone-900
  surfaceAlt: '#292524', // stone-800
  border: '#292524', // stone-800
  borderAlt: '#44403c', // stone-700

  text: '#f5f5f4', // stone-100
  textMuted: '#a8a29e', // stone-400
  textFaint: '#78716c', // stone-500

  amber: '#f59e0b', // amber-500
  amberLight: '#fbbf24', // amber-400
  amberText: '#fcd34d', // amber-300
  red: '#ef4444',
  emerald: '#34d399',
  emeraldText: '#6ee7b7',
  black: '#000000',
  white: '#ffffff',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const