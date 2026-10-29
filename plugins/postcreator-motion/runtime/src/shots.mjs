/**
 * Picture analysis of a montage: where it cuts, how it gets from one shot to
 * the next, and how busy each shot is. One ffmpeg pass prints per-frame scene
 * change scores and average luma; the rest is arithmetic.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { ffmpeg, MotionError, round, run, tool } from './tools.mjs'

/** Per-frame `{t, scene, yavg}` for a video, on a 160-px proxy. */
export async function frameStats(file) {
  const { stdout } = await run(await tool('ffmpeg'), [
    '-hide_banner', '-nostdin', '-i', file, '-an',
    '-vf', "scale=160:-2,signalstats,select='gte(scene\\,0)',metadata=print:file=-",
    '-f', 'null', '-',
  ], { timeoutMs: 30 * 60_000 })
  return parseFrameStats(stdout)
}

export function parseFrameStats(text) {
  const frames = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('frame:')) {
      const time = /pts_time:([\d.e+-]+)/.exec(line)
      current = { t: time ? Number(time[1]) : frames.length, scene: 0, yavg: 0 }
      frames.push(current)
    } else if (current && line.startsWith('lavfi.scene_score=')) {
      current.scene = Number(line.slice('lavfi.scene_score='.length)) || 0
    } else if (current && line.startsWith('lavfi.signalstats.YAVG=')) {
      current.yavg = Number(line.slice('lavfi.signalstats.YAVG='.length)) || 0
    }
  }
  return frames
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

/** Frames brighter than their neighbourhood by `jump`, that come back down within ~0.3 s. */
export function detectFlashes(frames, { jump = 45, back = 0.3 } = {}) {
  const flashes = []
  for (let i = 1; i < frames.length - 1; i += 1) {
    const before = frames.slice(Math.max(0, i - 6), i).map(frame => frame.yavg)
    const level = median(before)
    if (frames[i].yavg - level < jump || frames[i].yavg < frames[i - 1].yavg) continue
    const until = frames.findIndex((frame, j) => j > i && frame.t - frames[i].t <= back && frames[i].yavg - frame.yavg > jump * 0.6)
    if (until > 0 && (flashes.length === 0 || frames[i].t - flashes.at(-1) > 0.25)) flashes.push(round(frames[i].t))
  }
  return flashes
}

/**
 * Cut times: frames whose scene score passes the threshold, at least
 * `minShot` apart. A flash makes two spikes (into the white and out of it)
 * or one, when the brightest frame sits on the cut itself; every spike in
 * a flash's window collapses into one cut, the last one, where the new shot
 * appears.
 */
export function detectCuts(frames, { threshold = 0.3, minShot = 0.2, flashes = [] } = {}) {
  const spikes = []
  for (let i = 1; i < frames.length; i += 1) if (frames[i].scene >= threshold) spikes.push({ t: frames[i].t, scene: frames[i].scene })
  const grouped = []
  for (const spike of spikes) {
    const flash = flashes.find(f => spike.t >= f - 0.07 && spike.t <= f + 0.2)
    const last = grouped.at(-1)
    if (flash !== undefined && last?.flash === flash) last.t = spike.t
    else grouped.push({ ...spike, flash })
  }
  const cuts = []
  for (const cut of grouped) {
    if (cuts.length && cut.t - cuts.at(-1).t < minShot) {
      // Keep the stronger of two near-duplicate cuts.
      if (cut.scene > cuts.at(-1).scene) cuts[cuts.length - 1] = cut
      continue
    }
    cuts.push(cut)
  }
  return cuts.map(cut => round(cut.t))
}

/** How a shot is entered: flash, fade through black, a fast move into the cut, or a cut. */
export function classifyTransition(frames, cut, flashes) {
  if (flashes.some(flash => Math.abs(flash - cut) <= 0.2)) return 'flash'
  const before = frames.filter(frame => frame.t < cut && frame.t >= cut - 0.25)
  // A fade goes dark towards the cut; a shot that was dark all along is just a cut.
  const darkest = before.length ? Math.min(...before.map(frame => frame.yavg)) : 255
  if (darkest < 22 && before[0].yavg - darkest > 25) return 'fade'
  const moving = before.filter(frame => frame.scene > 0.08).length
  if (before.length >= 3 && moving / before.length >= 0.6) return 'whip'
  return 'cut'
}

export function buildShots(frames, cuts, duration, flashes = []) {
  const bounds = [0, ...cuts, duration]
  const shots = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end - start < 0.04) continue
    const inside = frames.filter(frame => frame.t > start + 0.001 && frame.t < end - 0.001)
    const mean = key => (inside.length ? inside.reduce((sum, frame) => sum + frame[key], 0) / inside.length : 0)
    shots.push({
      index: shots.length,
      start: round(start),
      end: round(end),
      duration: round(end - start),
      transitionIn: i === 0 ? 'open' : classifyTransition(frames, start, flashes),
      energy: round(mean('scene'), 4),
      brightness: round(mean('yavg') / 255, 3),
    })
  }
  return shots
}

/**
 * One frame as a JPEG. A time near the end can fall past the last decodable
 * frame (container and stream durations differ by a frame or two), so earlier
 * candidates are tried in turn.
 */
export async function grabFrame(ffmpegBin, file, times, out, width) {
  for (const time of times) {
    await rm(out, { force: true })
    await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-ss', String(Math.max(0, round(time))), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out])
    if ((await stat(out).catch(() => null))?.size) return out
  }
  throw new MotionError('frame_missing', `Не удалось взять кадр ${path.basename(file)} около ${round(times[0])} с.`)
}

/**
 * Pages of strips, three across and four down: a single sheet of thirty-odd
 * strips is too tall to read in one look. Short rows are padded with black.
 */
async function contactPages(strips, dir, { columns = 3, rows = 4 } = {}) {
  const pages = []
  for (let first = 0, page = 1; first < strips.length; first += columns * rows, page += 1) {
    const chunk = strips.slice(first, first + columns * rows)
    const lines = []
    for (let r = 0; r * columns < chunk.length; r += 1) {
      const row = chunk.slice(r * columns, (r + 1) * columns)
      const line = path.join(dir, `page-${page}-row-${r}.jpg`)
      const stack = row.length > 1 ? `hstack=inputs=${row.length}` : 'null'
      const pad = row.length < columns ? `,pad=iw*${columns}/${row.length}:ih:0:0:color=0x111214` : ''
      await ffmpeg([...row.flatMap(strip => ['-i', strip]), '-filter_complex', `${stack}${pad}`, '-frames:v', '1', '-q:v', '4', line])
      lines.push(line)
    }
    const out = path.join(dir, '..', `contact-${page}.jpg`)
    await ffmpeg([...lines.flatMap(line => ['-i', line]), '-filter_complex', lines.length > 1 ? `vstack=inputs=${lines.length}` : 'null', '-frames:v', '1', '-q:v', '4', out])
    pages.push(out)
  }
  return pages
}

/** One strip per shot (start, middle, end frames), stacked into a contact sheet and paged for reading. */
export async function contactSheet(file, shots, dir, { width = 240 } = {}) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  // Pages of an earlier analysis with more shots must not outlive it.
  for (const name of await readdir(path.join(dir, '..')).catch(() => [])) {
    if (/^contact-\d+\.jpg$/.test(name)) await rm(path.join(dir, '..', name), { force: true })
  }
  const ffmpegBin = await tool('ffmpeg')
  const strips = []
  for (const shot of shots) {
    // Two frames clear of each cut, so a short shot does not show its neighbours.
    const times = [0.12, 0.5, 0.88].map(f => round(Math.min(Math.max(shot.start + shot.duration * f, shot.start + 0.07), shot.end - 0.07)))
    const frames = []
    for (const [k, time] of times.entries()) {
      const out = path.join(dir, `shot-${String(shot.index).padStart(2, '0')}-${k}.jpg`)
      frames.push(await grabFrame(ffmpegBin, file, [time, time - 0.1, time - 0.25, shot.start + 0.02], out, width))
    }
    const strip = path.join(dir, `shot-${String(shot.index).padStart(2, '0')}.jpg`)
    const label = `#${shot.index}  ${shot.start.toFixed(2)}–${shot.end.toFixed(2)}s  ${shot.transitionIn}`
    await ffmpeg([...frames.flatMap(frame => ['-i', frame]), '-filter_complex',
      `[0][1][2]hstack=inputs=3,pad=iw:ih+36:0:36:color=0x111214,drawtext=text='${label.replaceAll(':', '\\:').replaceAll("'", '')}':x=10:y=9:fontsize=20:fontcolor=white`,
      '-frames:v', '1', '-q:v', '4', strip]).catch(() => ffmpeg([...frames.flatMap(frame => ['-i', frame]), '-filter_complex', '[0][1][2]hstack=inputs=3', '-frames:v', '1', strip]))
    strips.push(strip)
  }
  const sheet = path.join(dir, '..', 'contact.jpg')
  if (strips.length === 1) await ffmpeg(['-i', strips[0], '-frames:v', '1', sheet])
  else if (strips.length > 1) await ffmpeg([...strips.flatMap(strip => ['-i', strip]), '-filter_complex', `vstack=inputs=${strips.length}`, '-frames:v', '1', '-q:v', '4', sheet])
  return { sheet, strips, pages: await contactPages(strips, dir) }
}

/** A 16×28 colour thumbnail of a frame, for telling one set-up from another. */
export async function frameSignature(file) {
  const { stdout } = await ffmpeg(['-i', file, '-vf', 'scale=16:28:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { binary: true })
  return stdout
}

/** Mean colour distance of two signatures, 0 (same picture) to 1. */
export function signatureDistance(a, b) {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < length; i += 1) sum += Math.abs(a[i] - b[i])
  return length ? sum / length / 255 : 1
}

/**
 * Scenes: runs of shots on one set-up. A cut whose two sides still look alike
 * (the same paper, the same room) is a jump inside a scene — a camera snap or
 * a new word — not a new picture.
 */
export function groupScenes(distances, { threshold = 0.24 } = {}) {
  const scenes = [0]
  for (const distance of distances) scenes.push(scenes.at(-1) + (distance >= threshold ? 1 : 0))
  return scenes
}

/** Shots of a video with transitions, energy and brightness. */
export async function analyzeShots(file, duration, options = {}) {
  const frames = await frameStats(file)
  const flashes = detectFlashes(frames)
  const cuts = detectCuts(frames, { ...options, flashes })
  return { frames, flashes, cuts, shots: buildShots(frames, cuts, duration, flashes) }
}
