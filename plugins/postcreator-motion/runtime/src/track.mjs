/**
 * How the camera moved, for words that sit in the shot: per analysed frame,
 * the similarity transform (zoom, roll, shift) that carries a point of the
 * shot's first frame to where it is now.
 *
 * Pure JS, no extra programs: ffmpeg hands over small grey frames, a grid of
 * textured patches is matched between neighbouring frames coarse to fine, and
 * a similarity transform is fitted with outliers (the speaker's own motion)
 * thrown out. Cuts come from the shot detector; a step the matcher cannot
 * fit (a whip, motion blur) is taken as no motion rather than as a cut.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'

import { readJson, readProject, writeJson } from './project.mjs'
import { analyzeShots } from './shots.mjs'
import { MotionError, round, run, tool } from './tools.mjs'

const WIDTH = 144
const COLS = 6
const ROWS = 10
const PATCH = 12
const COARSE = 6
const FINE = 2

/** Half-size copy by 2×2 averaging. */
function half(image, w, h) {
  const hw = w >> 1
  const hh = h >> 1
  const out = new Uint8Array(hw * hh)
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < hw; x += 1) {
      const i = 2 * y * w + 2 * x
      out[y * hw + x] = (image[i] + image[i + 1] + image[i + w] + image[i + w + 1]) >> 2
    }
  }
  return out
}

function sad(a, b, w, ax, ay, bx, by, size, limit) {
  let sum = 0
  for (let y = 0; y < size; y += 1) {
    const ra = (ay + y) * w + ax
    const rb = (by + y) * w + bx
    for (let x = 0; x < size; x += 1) sum += Math.abs(a[ra + x] - b[rb + x])
    if (sum >= limit) return sum
  }
  return sum
}

function ssd(a, b, w, ax, ay, bx, by, size) {
  let sum = 0
  for (let y = 0; y < size; y += 1) {
    const ra = (ay + y) * w + ax
    const rb = (by + y) * w + bx
    for (let x = 0; x < size; x += 1) sum += (a[ra + x] - b[rb + x]) ** 2
  }
  return sum
}

function variance(image, w, x0, y0, size) {
  let sum = 0
  let squares = 0
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const v = image[(y0 + y) * w + x0 + x]
    sum += v
    squares += v * v
  }
  const n = size * size
  return squares / n - (sum / n) ** 2
}

/** Best shift of one patch: a coarse search on the half-size frames, then a fine one around it. */
function matchPatch(a, b, w, h, ha, hb, x0, y0) {
  const hw = w >> 1
  const hh = h >> 1
  const hp = PATCH >> 1
  let best = Infinity
  let cx = 0
  let cy = 0
  const hx = x0 >> 1
  const hy = y0 >> 1
  for (let dy = -COARSE; dy <= COARSE; dy += 1) {
    for (let dx = -COARSE; dx <= COARSE; dx += 1) {
      const bx = hx + dx
      const by = hy + dy
      if (bx < 0 || by < 0 || bx + hp > hw || by + hp > hh) continue
      const score = sad(ha, hb, hw, hx, hy, bx, by, hp, best)
      if (score < best) { best = score; cx = dx * 2; cy = dy * 2 }
    }
  }
  best = Infinity
  let fx = cx
  let fy = cy
  for (let dy = cy - FINE; dy <= cy + FINE; dy += 1) {
    for (let dx = cx - FINE; dx <= cx + FINE; dx += 1) {
      const bx = x0 + dx
      const by = y0 + dy
      if (bx < 0 || by < 0 || bx + PATCH > w || by + PATCH > h) continue
      const score = sad(a, b, w, x0, y0, bx, by, PATCH, best)
      if (score < best) { best = score; fx = dx; fy = dy }
    }
  }
  // Sub-pixel: a parabola through the squared error at the best shift and its neighbours.
  const at = (dx, dy) => {
    const bx = x0 + dx
    const by = y0 + dy
    return bx < 0 || by < 0 || bx + PATCH > w || by + PATCH > h ? Infinity : ssd(a, b, w, x0, y0, bx, by, PATCH)
  }
  const centre = at(fx, fy)
  const vertex = (minus, plus) => {
    const curve = minus - 2 * centre + plus
    return Number.isFinite(curve) && curve > 0 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve))) : 0
  }
  return { dx: fx + vertex(at(fx - 1, fy), at(fx + 1, fy)), dy: fy + vertex(at(fx, fy - 1), at(fx, fy + 1)), error: best / (PATCH * PATCH) }
}

/**
 * Least-squares similarity q = [a -b; b a]·p + t over point pairs (centred
 * coordinates), refitted twice without the pairs that disagree with the rest.
 */
export function fitSimilarity(pairs) {
  let used = pairs
  let fit = null
  for (let pass = 0; pass < 3 && used.length >= 4; pass += 1) {
    const n = used.length
    const mp = [0, 0]
    const mq = [0, 0]
    for (const { p, q } of used) { mp[0] += p[0] / n; mp[1] += p[1] / n; mq[0] += q[0] / n; mq[1] += q[1] / n }
    let num = 0
    let cross = 0
    let den = 0
    for (const { p, q } of used) {
      const px = p[0] - mp[0]
      const py = p[1] - mp[1]
      const qx = q[0] - mq[0]
      const qy = q[1] - mq[1]
      num += px * qx + py * qy
      cross += px * qy - py * qx
      den += px * px + py * py
    }
    if (den === 0) return null
    const a = num / den
    const b = cross / den
    fit = { a, b, tx: mq[0] - (a * mp[0] - b * mp[1]), ty: mq[1] - (b * mp[0] + a * mp[1]) }
    const residual = ({ p, q }) => Math.hypot(fit.a * p[0] - fit.b * p[1] + fit.tx - q[0], fit.b * p[0] + fit.a * p[1] + fit.ty - q[1])
    const errors = used.map(residual).sort((x, y) => x - y)
    // Within 3 px of the fit (≈20 px of the output frame), however scattered the rest is.
    const limit = Math.min(3, Math.max(1.5, 2.5 * errors[Math.floor(errors.length / 2)]))
    const kept = used.filter(pair => residual(pair) <= limit)
    if (kept.length === used.length) break
    used = kept
  }
  return fit && { ...fit, inliers: used.length }
}

/** Motion from frame `a` to frame `b` (same size, grey), in centred pixel coordinates; null on a cut. */
export function estimateMotion(a, b, w, h) {
  const ha = half(a, w, h)
  const hb = half(b, w, h)
  const margin = 2 * COARSE + FINE + 2
  const pairs = []
  let errors = 0
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const x0 = Math.round(margin + ((w - 2 * margin - PATCH) * c) / (COLS - 1))
      const y0 = Math.round(margin + ((h - 2 * margin - PATCH) * r) / (ROWS - 1))
      if (variance(a, w, x0, y0, PATCH) < 40) continue
      const found = matchPatch(a, b, w, h, ha, hb, x0, y0)
      errors += found.error
      const p = [x0 + PATCH / 2 - w / 2, y0 + PATCH / 2 - h / 2]
      pairs.push({ p, q: [p[0] + found.dx, p[1] + found.dy] })
    }
  }
  if (pairs.length < 6) return null
  // A cut: nothing matches well, or the match is a wild jump.
  if (errors / pairs.length > 28) return null
  const fit = fitSimilarity(pairs)
  // A new picture matches by chance only: most patches disagree with any single motion.
  if (!fit || fit.inliers < Math.max(5, pairs.length * 0.35) || Math.abs(Math.hypot(fit.a, fit.b) - 1) > 0.12) return null
  return fit
}

const compose = (next, prev) => ({
  a: next.a * prev.a - next.b * prev.b,
  b: next.a * prev.b + next.b * prev.a,
  tx: next.a * prev.tx - next.b * prev.ty + next.tx,
  ty: next.b * prev.tx + next.a * prev.ty + next.ty,
})

/** Chain per-step motions into "where the shot's first frame is now", restarting at cuts. */
export function accumulate(steps) {
  let current = { a: 1, b: 0, tx: 0, ty: 0 }
  const frames = [current]
  const cuts = []
  steps.forEach((step, i) => {
    if (!step) {
      current = { a: 1, b: 0, tx: 0, ty: 0 }
      cuts.push(i + 1)
    } else current = compose(step, current)
    frames.push(current)
  })
  return { frames, cuts }
}

/**
 * How a generated frame sits on the original one: generation models often
 * reframe (zoom in, shift), so a swapped piece is fitted back by scale and
 * shift — original = s · generated + (tx, ty), in pixels of the w×h frames.
 * Brute force over a small frame, then refined on the full one; the error
 * is the mean grey difference where the two overlap.
 */
export function alignFrames(original, generated, w, h) {
  const sample = (image, iw, ih, x, y) => {
    if (x < 0 || y < 0 || x > iw - 1 || y > ih - 1) return -1
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = Math.min(iw - 1, x0 + 1)
    const y1 = Math.min(ih - 1, y0 + 1)
    const fx = x - x0
    const fy = y - y0
    const top = image[y0 * iw + x0] * (1 - fx) + image[y0 * iw + x1] * fx
    const bottom = image[y1 * iw + x0] * (1 - fx) + image[y1 * iw + x1] * fx
    return top * (1 - fy) + bottom * fy
  }
  const score = (F, G, fw, fh, s, tx, ty, step) => {
    let sum = 0
    let n = 0
    for (let y = 0; y < fh; y += step) {
      for (let x = 0; x < fw; x += step) {
        const g = sample(G, fw, fh, (x - tx) / s, (y - ty) / s)
        if (g < 0) continue
        sum += Math.abs(F[y * fw + x] - g)
        n += 1
      }
    }
    // Too little overlap is not a fit.
    return n > (fw * fh) / (step * step) * 0.3 ? sum / n : Infinity
  }
  const small = (image, factor) => {
    const sw = Math.floor(w / factor)
    const sh = Math.floor(h / factor)
    const out = new Float32Array(sw * sh)
    for (let y = 0; y < sh; y += 1) for (let x = 0; x < sw; x += 1) {
      let sum = 0
      for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) sum += image[(y * factor + dy) * w + x * factor + dx]
      out[y * sw + x] = sum / (factor * factor)
    }
    return { image: out, w: sw, h: sh }
  }
  const F4 = small(original, 4)
  const G4 = small(generated, 4)
  let best = { error: Infinity, s: 1, tx: 0, ty: 0 }
  for (let s = 0.5; s <= 1.5001; s += 0.02) {
    for (let tx = -0.15 * F4.w; tx <= F4.w * (1.15 - s); tx += 1) {
      for (let ty = -0.15 * F4.h; ty <= F4.h * (1.15 - s); ty += 1) {
        const error = score(F4.image, G4.image, F4.w, F4.h, s, tx, ty, 1)
        if (error < best.error) best = { error, s, tx: tx * 4, ty: ty * 4 }
      }
    }
  }
  let fine = { ...best, error: Infinity }
  for (let s = best.s - 0.025; s <= best.s + 0.0251; s += 0.005) {
    for (let tx = best.tx - 6; tx <= best.tx + 6; tx += 1) {
      for (let ty = best.ty - 6; ty <= best.ty + 6; ty += 1) {
        const error = score(original, generated, w, h, s, tx, ty, 2)
        if (error < fine.error) fine = { error, s, tx, ty }
      }
    }
  }
  return { s: round(fine.s, 4), tx: round(fine.tx, 2), ty: round(fine.ty, 2), error: round(fine.error, 2) }
}

async function greyFrame(file, time, w, h) {
  const result = await run(await tool('ffmpeg'), ['-hide_banner', '-nostdin', '-ss', String(Math.max(0, time)), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { binary: true, timeoutMs: 120_000 })
  if (result.code !== 0 || result.stdout.length < w * h) throw new MotionError('frame_missing', `Не удалось взять кадр ${path.basename(file)} на ${round(time, 2)} с.`)
  return result.stdout.subarray(0, w * h)
}

/** Fit a generated clip onto the footage it replaces, from the first frames (before anything new appears). */
export async function alignClip(footage, start, clip, { width, height }) {
  const w = WIDTH
  const h = Math.round((WIDTH * height) / width / 2) * 2
  const fit = alignFrames(await greyFrame(footage, start + 0.08, w, h), await greyFrame(clip, 0.08, w, h), w, h)
  const scale = width / w
  return { scale: fit.s, x: round(fit.tx * scale, 1), y: round(fit.ty * scale, 1), error: fit.error }
}

/** Cut times of the footage from the shot detector; cached in work/cuts.json until the footage changes. */
export async function footageCuts(dir) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) return []
  const file = path.join(paths.root, project.footage.file)
  const info = await stat(file)
  const source = { file: project.footage.file, size: info.size, mtime: Math.round(info.mtimeMs) }
  const cachePath = path.join(paths.work, 'cuts.json')
  const cached = await readJson(cachePath, null)
  if (cached && JSON.stringify(cached.source) === JSON.stringify(source)) return cached.cuts
  const { shots } = await analyzeShots(file, project.footage.duration)
  const cuts = shots.slice(1).map(shot => round(shot.start, 3))
  await writeJson(cachePath, { source, cuts })
  return cuts
}

/** Track the project's footage; cached in work/track.json until the footage changes. */
export async function trackFootage(dir, { fps: wanted } = {}) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const file = path.join(paths.root, project.footage.file)
  const info = await stat(file)
  const fps = wanted ?? Math.min(12.5, project.fps ?? 25)
  const source = { file: project.footage.file, size: info.size, mtime: Math.round(info.mtimeMs), fps }
  const cachePath = path.join(paths.work, 'track.json')
  const cached = await readJson(cachePath, null)
  if (cached && JSON.stringify(cached.source) === JSON.stringify(source)) return { file: 'work/track.json', frames: cached.frames.length, cuts: cached.cuts.length, cached: true }
  const w = WIDTH
  const h = Math.round((WIDTH * project.height) / project.width / 2) * 2
  const result = await run(await tool('ffmpeg'), ['-hide_banner', '-nostdin', '-i', file, '-vf', `fps=${fps},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { binary: true, timeoutMs: 30 * 60_000 })
  if (result.code !== 0) throw new MotionError('tool_failed', `ffmpeg не отдал кадры для трекинга: ${result.stderr.trim().split('\n').slice(-2).join(' ')}`)
  const raw = result.stdout
  const size = w * h
  const count = Math.floor(raw.length / size)
  const cutFrames = new Set((await footageCuts(dir)).map(cut => Math.round(cut * fps)))
  const still = { a: 1, b: 0, tx: 0, ty: 0 }
  const steps = []
  for (let i = 1; i < count; i += 1) {
    steps.push(cutFrames.has(i) ? null : estimateMotion(raw.subarray((i - 1) * size, i * size), raw.subarray(i * size, (i + 1) * size), w, h) ?? still)
  }
  const { frames, cuts } = accumulate(steps)
  const scale = project.width / w
  const track = {
    source,
    fps,
    width: project.width,
    height: project.height,
    // [a, b, tx, ty] per analysed frame, shifts in output pixels about the frame centre.
    frames: frames.map(m => [round(m.a, 5), round(m.b, 5), round(m.tx * scale, 2), round(m.ty * scale, 2)]),
    cuts,
  }
  await writeJson(cachePath, track)
  return { file: 'work/track.json', frames: track.frames.length, cuts: cuts.length, cached: false }
}
