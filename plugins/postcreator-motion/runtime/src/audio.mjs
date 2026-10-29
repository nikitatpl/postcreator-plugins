/**
 * Rhythm of a soundtrack: onsets, tempo and a beat grid, in plain JS so no
 * Python stack is needed on a colleague's machine.
 *
 * Onsets come from spectral flux (log-magnitude increase across FFT bins);
 * tempo from the autocorrelation of that envelope weighted towards 120 BPM;
 * beats from Ellis' dynamic-programming tracker on the same envelope.
 */
import { ffmpeg, round } from './tools.mjs'

export const SAMPLE_RATE = 22050
const FRAME = 1024
const HOP = 256

export async function decodeMono(file, rate = SAMPLE_RATE) {
  const { stdout } = await ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { binary: true })
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4))
}

/** In-place iterative radix-2 FFT on separate real/imaginary arrays. */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const wr = Math.cos(step * k)
        const wi = Math.sin(step * k)
        const a = start + k
        const b = a + size / 2
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

/** Spectral-flux onset strength per hop, mean-removed and scaled to 0..1. */
export function onsetEnvelope(samples, rate = SAMPLE_RATE) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1)
  const env = new Float32Array(frames)
  const window = new Float32Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)))
  const bins = FRAME / 2
  let previous = new Float32Array(bins)
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  for (let f = 0; f < frames; f += 1) {
    const offset = f * HOP
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[offset + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    const current = new Float32Array(bins)
    let flux = 0
    for (let k = 1; k < bins; k += 1) {
      current[k] = Math.log1p(10 * Math.hypot(re[k], im[k]))
      const rise = current[k] - previous[k]
      if (rise > 0) flux += rise
    }
    env[f] = flux
    previous = current
  }
  // Remove the slowly varying level so sustained loud passages do not read as onsets.
  const radius = Math.round((0.4 * rate) / HOP)
  const out = new Float32Array(frames)
  let max = 0
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    let count = 0
    for (let g = Math.max(0, f - radius); g <= Math.min(frames - 1, f + radius); g += 1) {
      sum += env[g]
      count += 1
    }
    out[f] = Math.max(0, env[f] - sum / count)
    if (out[f] > max) max = out[f]
  }
  if (max > 0) for (let f = 0; f < frames; f += 1) out[f] /= max
  return { env: out, hopSeconds: HOP / rate, frameSeconds: FRAME / rate }
}

/** Time of an envelope frame: the hop where the new energy first shows. */
function frameTime(frame, hopSeconds, frameSeconds) {
  return frame * hopSeconds + frameSeconds - hopSeconds
}

export function estimateTempo(env, hopSeconds, { min = 70, max = 180 } = {}) {
  const minLag = Math.max(1, Math.floor(60 / max / hopSeconds))
  const maxLag = Math.ceil(60 / min / hopSeconds)
  const scores = []
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let i = lag; i < env.length; i += 1) sum += env[i] * env[i - lag]
    const bpm = 60 / (lag * hopSeconds)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    scores.push({ lag, raw: sum, score: sum * prior })
  }
  if (scores.length === 0) return { bpm: 0, period: 0, confidence: 0 }
  let best = scores.reduce((a, b) => (b.score > a.score ? b : a))
  // Parabolic refinement of the peak for a fractional lag.
  const i = scores.indexOf(best)
  let lag = best.lag
  if (i > 0 && i < scores.length - 1) {
    const [a, b, c] = [scores[i - 1].raw, scores[i].raw, scores[i + 1].raw]
    const denominator = a - 2 * b + c
    if (denominator !== 0) lag += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator))
  }
  const mean = scores.reduce((sum, item) => sum + item.raw, 0) / scores.length
  return { bpm: round(60 / (lag * hopSeconds), 2), period: lag, confidence: round(mean > 0 ? Math.min(1, (best.raw / mean - 1) / 4) : 0, 2) }
}

/** Ellis (2007) dynamic programming: beats that land on onsets at a steady period. */
export function trackBeats(env, period, { tightness = 100 } = {}) {
  const n = env.length
  if (!period || n === 0) return []
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t += 1) {
    let best = 0
    let from = -1
    const lo = Math.max(0, Math.floor(t - 2 * period))
    const hi = Math.floor(t - period / 2)
    for (let p = lo; p <= hi; p += 1) {
      const penalty = tightness * Math.log((t - p) / period) ** 2
      const value = score[p] - penalty
      if (from < 0 || value > best) {
        best = value
        from = p
      }
    }
    score[t] = env[t] + (from >= 0 ? best : 0)
    back[t] = from
  }
  // End on the best-scoring frame within the last period.
  let end = n - 1
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t += 1) if (score[t] > score[end]) end = t
  const beats = []
  for (let t = end; t >= 0; t = back[t]) beats.push(t)
  return beats.reverse()
}

/** Local maxima above an adaptive threshold, at least 80 ms apart. */
export function pickOnsets(env, hopSeconds, { k = 1.5 } = {}) {
  const radius = Math.round(0.25 / hopSeconds)
  const minGap = Math.round(0.08 / hopSeconds)
  const peaks = []
  for (let f = 1; f < env.length - 1; f += 1) {
    if (env[f] < env[f - 1] || env[f] < env[f + 1]) continue
    let sum = 0
    let sq = 0
    let count = 0
    for (let g = Math.max(0, f - radius); g <= Math.min(env.length - 1, f + radius); g += 1) {
      sum += env[g]
      sq += env[g] * env[g]
      count += 1
    }
    const mean = sum / count
    const sd = Math.sqrt(Math.max(0, sq / count - mean * mean))
    if (env[f] > mean + k * sd && env[f] > 0.1 && (peaks.length === 0 || f - peaks.at(-1) >= minGap)) peaks.push(f)
  }
  return peaks
}

/** Beats, bar starts (4/4, the strongest phase) and onsets of an audio or video file. */
export async function analyzeRhythm(file) {
  const samples = await decodeMono(file)
  const duration = samples.length / SAMPLE_RATE
  const { env, hopSeconds, frameSeconds } = onsetEnvelope(samples)
  const tempo = estimateTempo(env, hopSeconds)
  const beatFrames = tempo.confidence > 0.05 ? trackBeats(env, tempo.period) : []
  const beats = beatFrames.map(frame => round(frameTime(frame, hopSeconds, frameSeconds)))
  let phase = 0
  let bestAccent = -1
  for (let k = 0; k < 4; k += 1) {
    const accent = beatFrames.filter((_, i) => i % 4 === k).reduce((sum, frame) => sum + env[frame], 0)
    if (accent > bestAccent) {
      bestAccent = accent
      phase = k
    }
  }
  return {
    duration: round(duration),
    bpm: beats.length > 1 ? tempo.bpm : 0,
    confidence: tempo.confidence,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === phase),
    onsets: pickOnsets(env, hopSeconds).map(frame => round(frameTime(frame, hopSeconds, frameSeconds))),
  }
}

/** Nearest beat to a time, and how far it is. */
export function nearestBeat(beats, time) {
  let best = null
  for (const beat of beats) if (best === null || Math.abs(beat - time) < Math.abs(best - time)) best = beat
  return best === null ? null : { beat: best, offset: round(time - best) }
}
