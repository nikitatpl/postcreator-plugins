/** Text helpers shared by the scene templates. */

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/** A value as a JavaScript literal that is safe inside a <script>. */
export const js = value => JSON.stringify(value).replace(/</g, '\\u003c')

/** Font size that keeps `text` on about `maxLines` lines of `width` px. */
export function fit(text, base, width, maxLines = 2, minRatio = 0.45, em = 0.62) {
  const chars = Math.max(1, String(text).length)
  const perLine = width / (base * em)
  const lines = chars / perLine
  const size = lines <= maxLines ? base : Math.max(base * minRatio, base * Math.sqrt(maxLines / lines))
  // A word never wraps (only after a hyphen), so the longest one must fit a line.
  const longest = Math.max(1, ...String(text).split(/\s+|(?<=-)/).map(word => word.length))
  return Math.round(Math.min(size, width / (longest * em)))
}

// Average glyph width in em: bold capitals, and spaced-out mono capitals.
export const UPPER = 0.76
export const MONO_UPPER = 0.86

/** Seeded random numbers in [0, 1) (mulberry32): the same layout on every build. */
export function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A clip-path polygon with ragged edges, like paper torn by hand; `depth` in percent of the box. */
export function tornEdge(seed, { points = 16, depth = 4 } = {}) {
  const random = seeded(seed)
  const edge = []
  for (let i = 0; i <= points; i += 1) edge.push([(i * 100) / points, random() * depth])
  for (let i = 1; i <= points; i += 1) edge.push([100 - random() * depth * 0.6, (i * 100) / points])
  for (let i = 1; i <= points; i += 1) edge.push([100 - (i * 100) / points, 100 - random() * depth])
  for (let i = 1; i < points; i += 1) edge.push([random() * depth * 0.6, 100 - (i * 100) / points])
  return `polygon(${edge.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(',')})`
}
