/**
 * Where the people are, so no graphic ever covers the person on screen.
 *
 * Two sources, same shape — a coarse occupancy grid per moment:
 *   - `pc-motion people` (the build runs it when needed): HyperFrames' local
 *     matting model cuts the people out of a small 2 fps copy of the footage;
 *     the first run downloads the model, about 168 MB, then works offline;
 *   - `"people"` in inserts.json: boxes the agent read off the `look` frames,
 *     `{ "from": 0, "to": 13.2, "box": [x0, y0, x1, y1] }` in shares of the frame.
 *
 * The build then refuses a card or a word in the shot that touches a person,
 * a caption that touches a face, and graphics that sit on each other.
 */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { fit, UPPER } from './markup.mjs'
import { readJson, readProject, writeJson } from './project.mjs'
import { ffmpeg, hyperframesArgs, MotionError, npx, round, run, tool } from './tools.mjs'

const CELL = 40
const FPS = 2

export function gridSize(project) {
  return { cols: Math.round(project.width / CELL), rows: Math.round(project.height / CELL) }
}

/** Cut the people out of the footage once; cached in work/people.json until the footage changes. */
export async function detectPeople(dir) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const file = path.join(paths.root, project.footage.file)
  const info = await stat(file)
  const source = { file: project.footage.file, size: info.size, mtime: Math.round(info.mtimeMs), fps: FPS }
  const out = path.join(paths.work, 'people.json')
  const cached = await readJson(out, null)
  if (cached && JSON.stringify(cached.source) === JSON.stringify(source)) return { file: 'work/people.json', frames: cached.frames.length, cached: true }
  const dirOut = path.join(paths.work, 'people')
  await mkdir(dirOut, { recursive: true })
  const proxy = path.join(dirOut, 'proxy.mp4')
  const matte = path.join(dirOut, 'matte.webm')
  await ffmpeg(['-i', file, '-an', '-vf', `fps=${FPS},scale=360:-2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', proxy])
  const cut = await run(await npx(), hyperframesArgs('remove-background', proxy, '-o', matte, '--quality', 'fast', '--json'), { cwd: paths.root, timeoutMs: 60 * 60_000 })
  if (cut.code !== 0) throw new MotionError('people_failed', `Модель не вырезала людей: ${`${cut.stderr}${cut.stdout}`.trim().split('\n').slice(-3).join(' ')}`)
  const { cols, rows } = gridSize(project)
  // The VP9 decoder from libvpx keeps the alpha channel; the built-in one drops it.
  const alpha = await run(await tool('ffmpeg'), ['-hide_banner', '-nostdin', '-c:v', 'libvpx-vp9', '-i', matte, '-vf', `alphaextract,scale=${cols}:${rows}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { binary: true, timeoutMs: 10 * 60_000 })
  if (alpha.code !== 0) throw new MotionError('people_failed', `Не прочитал маску: ${alpha.stderr.trim().split('\n').slice(-2).join(' ')}`)
  const size = cols * rows
  const frames = []
  for (let i = 0; i + size <= alpha.stdout.length; i += size) {
    let row = ''
    for (let k = 0; k < size; k += 1) row += alpha.stdout[i + k] > 80 ? '1' : '0'
    frames.push(row)
  }
  await writeJson(out, { source, fps: FPS, cols, rows, frames })
  return { file: 'work/people.json', frames: frames.length, cached: false }
}

/** Boxes from the plan rasterised to the same grid as the detector's mask. */
export function zonesToPeople(zones, project, duration) {
  const { cols, rows } = gridSize(project)
  const count = Math.ceil(duration * FPS) + 1
  const frames = Array.from({ length: count }, () => new Uint8Array(cols * rows))
  for (const [k, zone] of zones.entries()) {
    const box = zone?.box
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[0] >= box[2] || box[1] >= box[3]) {
      throw new MotionError('people_invalid', `people[${k}].box: нужно [x0, y0, x1, y1] долями кадра, x0 < x1 и y0 < y1.`)
    }
    const from = Number.isFinite(zone.from) ? zone.from : 0
    const to = Number.isFinite(zone.to) ? zone.to : duration
    for (let f = Math.max(0, Math.floor(from * FPS)); f <= Math.min(count - 1, Math.ceil(to * FPS)); f += 1) {
      for (let r = Math.floor(box[1] * rows); r < Math.ceil(box[3] * rows); r += 1) for (let c = Math.floor(box[0] * cols); c < Math.ceil(box[2] * cols); c += 1) frames[f][r * cols + c] = 1
    }
  }
  return { fps: FPS, cols, rows, frames: frames.map(frame => frame.join('')) }
}

/** Head and shoulders: in each column, the cells just below the topmost person cell. */
function heads(frame, cols, rows) {
  const zone = new Uint8Array(cols * rows)
  const depth = Math.round(rows * 0.12)
  for (let c = 0; c < cols; c += 1) {
    let top = -1
    for (let r = 0; r < rows; r += 1) if (frame[r * cols + c] === '1') { top = r; break }
    if (top < 0) continue
    for (let r = top; r < Math.min(rows, top + depth); r += 1) zone[r * cols + c] = 1
  }
  return zone
}

function covered(cells, cols, rows, rect) {
  const c0 = Math.max(0, Math.floor(rect.x0 / CELL))
  const c1 = Math.min(cols - 1, Math.floor(rect.x1 / CELL))
  const r0 = Math.max(0, Math.floor(rect.y0 / CELL))
  const r1 = Math.min(rows - 1, Math.floor(rect.y1 / CELL))
  let hit = 0
  for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) if (cells(r * cols + c)) hit += 1
  return hit
}

/** Where a point of the shot is at time t, following the camera from t0 (output pixels). */
export function follow(track, x, y, t0, t) {
  if (!track) return [x, y, 1]
  const at = time => {
    const f = Math.max(0, Math.min(track.frames.length - 1, time * track.fps))
    const i = Math.floor(f)
    const m = f - i
    const a = track.frames[i]
    const b = track.frames[Math.min(i + 1, track.frames.length - 1)]
    return a.map((v, k) => v + (b[k] - v) * m)
  }
  const cut = track.cuts.find(c => c > t0 * track.fps)
  const now = Math.min(t, cut ? (cut - 1) / track.fps : Infinity)
  const [a0, b0, tx0, ty0] = at(t0)
  const [a, b, tx, ty] = at(now)
  const cx = track.width / 2
  const cy = track.height / 2
  const d = a0 * a0 + b0 * b0
  const px = x - cx
  const py = y - cy
  const ux = (a0 * (px - tx0) + b0 * (py - ty0)) / d
  const uy = (-b0 * (px - tx0) + a0 * (py - ty0)) / d
  return [cx + a * ux - b * uy + tx, cy + b * ux + a * uy + ty, Math.hypot(a, b) / Math.sqrt(d)]
}

/** What sits over the speaker's picture, each with where it is at a given moment. */
function overlays({ project, inserts, captions, track }) {
  const { width: W, height: H } = project
  const items = []
  for (const insert of inserts.filter(item => item.card)) {
    const { card } = insert
    const start = insert.start + 0.75
    items.push({ what: `карточка ${insert.id}`, start, end: Math.max(start, insert.start + insert.duration - 0.5), allowed: card.overPeople, rectAt: t => {
      const [x, y, zoom] = card.track ? follow(track, card.x * W, card.y * H, insert.start, t) : [card.x * W, card.y * H, 1]
      const w = (card.width * card.scale * zoom) / 2
      const h = (card.height * card.scale * zoom) / 2
      return { x0: x - w, y0: y - h, x1: x + w, y1: y + h }
    } })
  }
  if (!captions) return items
  const u = Math.min(W, H) / 1080
  for (const item of captions.keywords) {
    const size = fit(item.text, 128 * u * item.size, W * 0.8, 1, 0.4, UPPER)
    const flat = item.place === 'floor' || item.place === 'ceiling'
    const w = (item.text.length * size * 0.74 * (flat ? 1 : 0.85)) / 2
    const h = (size * (flat ? 0.55 : 1)) / 2
    items.push({ what: `слово «${item.text}»`, start: item.start + 0.3, end: Math.max(item.start + 0.3, item.end - 0.3), allowed: item.overPeople, rectAt: t => {
      const [x, y] = follow(track, item.x * W, item.y * H, item.start, t)
      return { x0: x - w, y0: y - h, x1: x + w, y1: y + h }
    } })
  }
  const pad = Math.round(W * 0.067)
  const font = { pop: 78, karaoke: 58, stack: 120, minimal: 42 }[captions.base] ?? 60
  const top = captions.position ?? { pop: 0.64, karaoke: 0.66, stack: 0.58, minimal: 0.68 }[captions.base] ?? 0.66
  for (const line of captions.lines) {
    const text = line.words.map(word => word.text).join(' ')
    const size = font * u
    const width = Math.min(W - 2 * pad, text.length * size * 0.62)
    const lines = Math.ceil((text.length * size * 0.62) / (W - 2 * pad))
    const height = captions.base === 'stack' ? line.words.length * size : lines * size * 1.25
    const y0 = captions.base === 'stack' ? top * H - height / 2 : top * H
    items.push({ what: `субтитр «${text}»`, start: line.start, end: line.end, faces: true, caption: true, rectAt: () => ({ x0: W / 2 - width / 2, y0, x1: W / 2 + width / 2, y1: y0 + height }) })
  }
  return items
}

const times = (start, end) => {
  const list = []
  for (let t = start; t <= end + 1e-6; t += 0.5) list.push(round(t, 2))
  return list.length ? list : [round((start + end) / 2, 2)]
}

const meets = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/**
 * Every place where graphics would cover a person — cards and words in the
 * shot must not touch anyone, captions must not touch a face — or each
 * other. Full-frame inserts replace the picture and are not checked.
 */
export function guardGraphics({ project, inserts, captions, track, people }) {
  const items = overlays({ project, inserts, captions, track })
  const problems = []
  if (people) {
    const { cols, rows } = people
    const frameAt = t => people.frames[Math.max(0, Math.min(people.frames.length - 1, Math.round(t * people.fps)))]
    for (const item of items.filter(entry => !entry.allowed)) {
      for (const t of times(item.start, item.end)) {
        const frame = frameAt(t)
        const zone = item.faces ? heads(frame, cols, rows) : null
        const rect = item.rectAt(t)
        const cells = Math.max(1, Math.ceil((rect.x1 - rect.x0) / CELL) * Math.ceil((rect.y1 - rect.y0) / CELL))
        const hit = covered(i => (zone ? zone[i] === 1 : frame[i] === '1'), cols, rows, rect)
        if (hit >= 2 && hit / cells > 0.01) {
          problems.push(`${item.what} на ${t} с закрывает ${item.faces ? 'лицо' : 'человека'}`)
          break
        }
      }
    }
  }
  // One thing at a place: a card, a word in the shot and a caption line never sit on each other.
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]
      const b = items[j]
      if (a.caption && b.caption) continue
      const from = Math.max(a.start, b.start)
      const to = Math.min(a.end, b.end)
      if (from > to) continue
      const t = times(from, to).find(time => meets(a.rectAt(time), b.rectAt(time)))
      if (t !== undefined) problems.push(`${a.what} налезает на ${b.what} на ${t} с`)
    }
  }
  return problems
}

/** Cards and words the camera carries out of the frame: worth a warning, the snapshot shows how bad. */
export function edgeWarnings({ project, inserts, captions, track }) {
  const { width: W, height: H } = project
  const warnings = []
  for (const item of overlays({ project, inserts, captions, track }).filter(entry => !entry.caption)) {
    const t = times(item.start, item.end).find(time => {
      const r = item.rectAt(time)
      const outside = Math.max(0, -r.x0) + Math.max(0, r.x1 - W) + Math.max(0, -r.y0) + Math.max(0, r.y1 - H)
      return outside > 0.25 * Math.min(r.x1 - r.x0, r.y1 - r.y0)
    })
    if (t !== undefined) warnings.push(`${item.what} на ${t} с уезжает за край кадра вслед за камерой: переставьте его или выключите трекинг`)
  }
  return warnings
}

/** The people map for a build: the detector's if it ran, else the plan's boxes, else none. */
export async function peopleFor(paths, project, plan) {
  if (Array.isArray(plan.people) && plan.people.length) return { source: 'plan', ...zonesToPeople(plan.people, project, project.footage.duration) }
  const detected = await readJson(path.join(paths.work, 'people.json'), null)
  if (detected) {
    const footage = await stat(path.join(paths.root, project.footage.file)).catch(() => null)
    if (footage && detected.source?.size === footage.size) return { source: 'detected', ...detected }
  }
  return null
}
