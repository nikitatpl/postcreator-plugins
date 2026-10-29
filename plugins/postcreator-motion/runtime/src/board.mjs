/**
 * The board recipe: a motion-design reference — one collage the camera
 * crosses, words typed onto paper plates — rebuilt from the remix plan.
 *
 * plan   remix.json → board.json. Every run of slots on one clip becomes a
 *        sheet on a tilted paper board, laid out in a zigzag; the camera
 *        arrives at each sheet on its first slot's beat with a glide, a dive
 *        (pull back, then in) or a roll, and drifts while it holds. Captions
 *        become plates in the board next to their sheet. Editable.
 * build  board.json → index.html, a crumpled-paper texture and a still of
 *        every sheet (the first frame of its window, shown until the clip
 *        starts playing).
 *
 * The camera is a rig in CSS 3D: #rig (push, tilt, roll around the frame's
 * centre) holding #pan (the board point under the centre). Grain, blinds,
 * tilt-shift and a vignette sit over the lens; HyperFrames smears the moves
 * with render-time motion blur.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { escapeHtml, seeded, tornEdge } from './markup.mjs'
import { readJson, readProject, saveProject, writeJson } from './project.mjs'
import { SFX } from './sfx.mjs'
import { grabFrame } from './shots.mjs'
import { ffmpeg, GSAP_URL, MotionError, round, tool } from './tools.mjs'

export const MOVES = ['open', 'glide', 'dive', 'roll']
export const PLATES = ['plate-dark', 'plate-light', 'plate-red', 'plate-cream-red', 'hero']
const GLIDE = 0.56
const LEAD = 0.7
// A sheet the camera can actually visit: shorter runs (a flash frame, a one-beat insert) join the next one.
const MIN_SHEET = 0.6

/** The board plan from a remix plan: sheets, moves and captions. */
export function boardFromRemix(remix, { width, height, fps = 30, clips = [] } = {}) {
  const W = width
  const H = height
  const sheetWidth = Math.round(W * 0.6)
  const sheetHeight = Math.round((sheetWidth * H) / W)
  const runs = []
  for (const slot of remix.slots) {
    const last = runs.at(-1)
    if (last && last.clip === slot.clip) {
      last.end = round(slot.start + slot.duration)
      continue
    }
    runs.push({ clip: slot.clip, file: slot.file, mediaStart: slot.mediaStart, start: slot.start, end: round(slot.start + slot.duration), transition: slot.transition })
  }
  for (let i = 0; i < runs.length && runs.length > 1;) {
    const run = runs[i]
    const length = run.end - run.start
    if (length >= MIN_SHEET) {
      i += 1
      continue
    }
    const next = runs[i + 1]
    if (next) {
      // The next clip starts earlier by as much, so its planned window still lands on its beat.
      next.mediaStart = round(Math.max(0, next.mediaStart - length))
      next.start = run.start
      if (run.transition === 'flash' || run.transition === 'open') next.transition = run.transition
    } else {
      runs[i - 1].end = run.end
    }
    runs.splice(i, 1)
  }
  const random = seeded(7)
  const sheets = runs.map((run, i) => {
    const length = clips.find(clip => clip.id === run.clip)?.duration ?? null
    const side = i % 2 ? 1 : -1
    return {
      clip: run.clip,
      file: run.file,
      mediaStart: run.mediaStart,
      ...(length ? { clipDuration: length } : {}),
      start: run.start,
      duration: round(run.end - run.start),
      x: side * Math.round(sheetWidth * 0.48),
      y: Math.round(i * sheetHeight * 0.74),
      rotate: round(side * (3 + random() * 3), 1),
      z: Math.round(10 + random() * 30),
      // The reference's own transitions pick the move: a whip rolls, a fade dives.
      move: i === 0 ? 'open' : run.transition === 'whip' ? 'roll' : run.transition === 'fade' ? 'dive' : MOVES[1 + (i % 3)],
      flash: run.transition === 'flash',
    }
  })
  const offset = { upper: -0.34, center: 0, lower: 0.24 }
  const texts = (remix.texts ?? []).map((text, k) => {
    const found = sheets.findIndex(sheet => text.start >= sheet.start - 0.05 && text.start < sheet.start + sheet.duration)
    const sheet = found < 0 ? sheets.length - 1 : found
    const style = PLATES.includes(text.style) ? text.style : text.style === 'hero' ? 'hero' : 'plate-dark'
    return {
      text: text.text,
      start: text.start,
      sheet,
      dx: Math.round(Number.isFinite(text.x) ? (text.x - 0.5) * sheetWidth : (k % 2 ? 0.06 : -0.06) * sheetWidth),
      dy: Math.round(Number.isFinite(text.y) ? (text.y - 0.5) * sheetHeight : (offset[text.position] ?? 0) * sheetHeight),
      style,
      rotate: Number.isFinite(text.rotate) ? text.rotate : k % 2 ? 2.5 : -3,
    }
  })
  return {
    version: 1,
    width: W,
    height: H,
    fps,
    duration: remix.duration,
    music: remix.music ?? null,
    sheet: { width: sheetWidth, height: sheetHeight },
    sheets,
    texts,
    look: { tilt: 14, grain: 0.55, blinds: 0.5, dof: 9, vignette: 0.55, bokeh: true },
  }
}

const finite = value => typeof value === 'number' && Number.isFinite(value)

/** board.json is edited by hand; its numbers go straight into the scene. */
export function validateBoard(board) {
  if (!Array.isArray(board.sheets) || board.sheets.length === 0) throw new MotionError('board_invalid', 'В board.json нет листов.')
  if (!finite(board.duration) || board.duration <= 0.1) throw new MotionError('board_invalid', 'board.json: duration — секунды.')
  board.sheets.forEach((sheet, i) => {
    if (typeof sheet.file !== 'string' || !sheet.file.startsWith('assets/')) throw new MotionError('board_invalid', `Лист ${i}: file — путь внутри assets/.`)
    for (const key of ['start', 'duration', 'mediaStart', 'x', 'y', 'rotate', 'z']) {
      if (!finite(sheet[key])) throw new MotionError('board_invalid', `Лист ${i}: ${key} должно быть числом.`)
    }
    if (!MOVES.includes(sheet.move)) throw new MotionError('board_invalid', `Лист ${i}: move — ${MOVES.join(', ')}.`)
  })
  for (const [k, text] of (board.texts ?? []).entries()) {
    if (typeof text?.text !== 'string' || !text.text.trim() || !finite(text.start)) throw new MotionError('board_invalid', `Надпись ${k}: нужны text и start.`)
    if (!Number.isInteger(text.sheet) || !board.sheets[text.sheet]) throw new MotionError('board_invalid', `Надпись ${k}: sheet — номер листа.`)
    if (!PLATES.includes(text.style)) throw new MotionError('board_invalid', `Надпись ${k}: style — ${PLATES.join(', ')}.`)
  }
}

/** Where the camera looks for each sheet: a little off its centre, rolled against its tilt, pushed in to fill the frame. */
function cameraStops(board, push) {
  const { width: sheetWidth, height: sheetHeight } = board.sheet
  const tilt = board.look?.tilt ?? 14
  return board.sheets.map((sheet, i) => ({
    x: round(sheet.x + (i % 2 ? 0.03 : -0.03) * sheetWidth, 1),
    y: round(sheet.y - 0.035 * sheetHeight, 1),
    rot: round(-sheet.rotate * 0.75 + (i % 2 ? 3 : -3), 2),
    rx: tilt - 4 + ((i * 7) % 18),
    z: push + (i % 2) * 50,
  }))
}

export function boardIndex(board, { stills = [], paper = 'assets/board/paper.png' } = {}) {
  const { width: W, height: H, duration: D } = board
  const { width: SW, height: SH } = board.sheet
  const look = board.look ?? {}
  // Perspective about one frame away, the sheet pushed in until it fills most of the height.
  const P = Math.round(Math.max(W, H) * 0.94)
  const push = Math.round(P * (1 - SH / (0.98 * H)))
  const stops = cameraStops(board, push)
  const sheets = board.sheets
  const js = []
  const sfx = []
  const t = value => round(value, 3)

  const glides = sheets.map((sheet, i) => (sheets[i + 1] ? Math.min(GLIDE, Math.max(0.2, sheet.duration * 0.45)) : 0))
  // Opening: the camera settles onto the first sheet from above and further out, before the first move.
  const first = stops[0]
  const open = round(Math.max(0.2, Math.min(1.2, (sheets[1] ? sheets[1].start - glides[0] : D) - 0.05)))
  js.push(`tl.set("#rig", { z: ${first.z - 160}, rotationX: ${first.rx + 8}, rotation: ${first.rot - 6} }, 0);`)
  js.push(`tl.set("#pan", { x: ${-first.x}, y: ${round(-first.y + 0.22 * SH, 1)} }, 0);`)
  js.push(`tl.to("#rig", { z: ${first.z}, rotationX: ${first.rx}, rotation: ${first.rot}, duration: ${t(open)}, ease: "power3.out" }, 0);`)
  js.push(`tl.to("#pan", { x: ${-first.x}, y: ${-first.y}, duration: ${t(open)}, ease: "power3.out" }, 0);`)
  sheets.forEach((sheet, i) => {
    const stop = stops[i]
    const next = sheets[i + 1]
    const glide = glides[i]
    const from = i === 0 ? open : sheet.start
    const until = next ? next.start - glide : D
    const side = i % 2 ? 1 : -1
    // The hold drifts: a slow push, a little roll, the board sliding under the lens.
    // Rounded down, so the hold never reaches into the move that follows it.
    const hold = Math.floor((t(until) - t(from)) * 1000) / 1000
    if (hold > 0.1) {
      js.push(`tl.to("#rig", { z: ${stop.z + 60}, rotation: ${t(stop.rot + side * 2.5)}, rotationX: ${stop.rx + 2}, duration: ${hold}, ease: "sine.inOut" }, ${t(from)});`)
      js.push(`tl.to("#pan", { x: ${round(-stop.x - side * 0.06 * SW, 1)}, y: ${round(-stop.y - 0.06 * SH, 1)}, duration: ${hold}, ease: "sine.inOut" }, ${t(from)});`)
    }
    if (!next) return
    const to = stops[i + 1]
    // The move starts on the rounded hold end and lands exactly on the next sheet's beat.
    const begin = t(until)
    const move = t(t(next.start) - begin)
    const half = t(move / 2)
    const rest = t(move - half)
    if (next.move === 'dive') {
      js.push(`tl.to("#rig", { z: ${Math.round(to.z - push * 0.65)}, rotationX: ${to.rx + 10}, rotation: ${t((stop.rot + to.rot) / 2)}, duration: ${half}, ease: "power2.in" }, ${begin});`)
      js.push(`tl.to("#rig", { z: ${to.z}, rotationX: ${to.rx}, rotation: ${to.rot}, duration: ${rest}, ease: "power3.out" }, ${t(begin + half)});`)
    } else if (next.move === 'roll') {
      js.push(`tl.to("#rig", { z: ${Math.round(to.z - push * 0.25)}, rotation: ${t(to.rot + (i % 2 ? 14 : -14))}, rotationX: ${to.rx - 6}, duration: ${half}, ease: "power2.in" }, ${begin});`)
      js.push(`tl.to("#rig", { z: ${to.z}, rotation: ${to.rot}, rotationX: ${to.rx}, duration: ${rest}, ease: "power3.out" }, ${t(begin + half)});`)
    } else {
      js.push(`tl.to("#rig", { z: ${to.z}, rotation: ${to.rot}, rotationX: ${to.rx}, duration: ${move}, ease: "power3.inOut" }, ${begin});`)
    }
    js.push(`tl.to("#pan", { x: ${-to.x}, y: ${-to.y}, duration: ${move}, ease: "power3.inOut" }, ${begin});`)
    sfx.push({ sound: 'whoosh', at: t(until - 0.05), volume: 0.22 })
  })

  // Sheets slap down onto the board as the camera comes.
  sheets.forEach((sheet, i) => {
    js.push(`tl.fromTo("#sheet${i}", { scale: 1.12, rotation: ${i % 2 ? 4 : -4}, z: 120 }, { scale: 1, rotation: 0, z: 0, duration: 0.42, ease: "expo.out", immediateRender: true }, ${t(Math.max(0, sheet.start - 0.55))});`)
    if (sheet.flash && i > 0) {
      js.push(`tl.fromTo("#flash", { opacity: 0 }, { opacity: 0.95, duration: 0.05, ease: "none", immediateRender: false }, ${t(sheet.start - 0.05)});`)
      js.push(`tl.to("#flash", { opacity: 0, duration: 0.3, ease: "power2.out" }, ${t(sheet.start)});`)
      sfx.push({ sound: 'swish', at: t(sheet.start - 0.1), volume: 0.28 })
    }
  })

  // Words: typed letter by letter onto a plate, or stamped as a hero word with a jolt of the camera.
  const texts = (board.texts ?? []).map((text, k) => {
    const sheet = sheets[text.sheet]
    const letters = Math.max(3, String(text.text).length)
    if (text.style === 'hero') {
      js.push(`tl.fromTo("#w${k}", { opacity: 0, scale: 1.7, z: 260, filter: "blur(16px)" }, { opacity: 1, scale: 1, z: 0, filter: "blur(0px)", duration: 0.22, ease: "expo.out" }, ${t(text.start)});`)
      js.push(`tl.fromTo("#rig", { x: 0 }, { x: 14, duration: 0.05, yoyo: true, repeat: 3, ease: "none", immediateRender: false }, ${t(text.start + 0.02)});`)
      sfx.push({ sound: 'tick', at: t(text.start), volume: 0.25 })
    } else {
      js.push(`tl.fromTo("#w${k}", { clipPath: "inset(-20% 100% -20% 0%)", x: -36 }, { clipPath: "inset(-20% 0% -20% 0%)", x: 0, duration: ${t(Math.min(0.42, 0.045 * letters))}, ease: "steps(${letters})" }, ${t(text.start)});`)
    }
    const size = text.style === 'hero' ? ` font-size:${Math.round(Math.min(0.46 * SW, (1.6 * SW) / letters))}px;` : ''
    return `          <div class="tp" style="left:${sheet.x + text.dx}px; top:${sheet.y + text.dy}px; transform: translate(-50%,-50%) translateZ(${sheet.z + (text.style === 'hero' ? 140 : 80)}px) rotate(${text.rotate}deg);">
            <div class="plate ${text.style}" id="w${k}" style="--torn:${tornEdge(300 + k, { points: 14, depth: 4.5 })};${size}"><span>${escapeHtml(text.text)}</span></div>
          </div>`
  })

  // Clips play from a little before the camera arrives until it has left.
  const sheetHtml = sheets.map((sheet, i) => {
    const lead = Math.min(LEAD, sheet.start, sheet.mediaStart)
    const begin = sheet.start - lead
    const leave = (sheets[i + 1]?.start ?? D) + 0.9
    const room = sheet.clipDuration ? sheet.clipDuration - (sheet.mediaStart - lead) : Infinity
    const length = Math.max(0.1, Math.min(leave, D) - begin, 0)
    const play = round(Math.min(length, room))
    const still = stills[i] ? `<img src="${escapeHtml(stills[i])}" alt="" />` : ''
    return `          <div class="sp" style="left:${sheet.x}px; top:${sheet.y}px; transform: translate(-50%,-50%) translateZ(${sheet.z}px) rotate(${sheet.rotate}deg);">
            <div class="shadow"></div>
            <div class="sheet" id="sheet${i}" style="clip-path:${tornEdge(100 + i, { points: 26, depth: 1.4 })};">
              ${still}<video id="v${i}" class="clip" src="${escapeHtml(sheet.file)}" data-start="${t(begin)}" data-duration="${play}" data-media-start="${t(sheet.mediaStart - lead)}" data-track-index="${1 + (i % 2)}" muted playsinline></video>
            </div>
          </div>`
  })

  // Paper scraps, tape, stars and grid patches around the sheets; a few blurred scraps close to the lens.
  const random = seeded(11)
  const decor = []
  sheets.forEach((sheet, i) => {
    for (let j = 0; j < 2; j += 1) {
      const colour = ['#c8202a', '#141414', '#d9d2c3'][(i + j) % 3]
      decor.push(`<div class="strip" style="left:${Math.round(sheet.x + (random() - 0.5) * 1.07 * SW)}px; top:${Math.round(sheet.y + (random() - 0.5) * 0.95 * SH)}px; width:${Math.round(SW * (0.8 + random() * 0.65))}px; height:${Math.round(SW * (0.14 + random() * 0.18))}px; background:${colour}; clip-path:${tornEdge(500 + i * 7 + j, { points: 20, depth: 9 })}; transform: translate(-50%,-50%) translateZ(${sheet.z - 8 + j * 2}px) rotate(${round((random() - 0.5) * 50, 1)}deg);"></div>`)
    }
    decor.push(`<div class="tape" style="left:${Math.round(sheet.x + (random() - 0.5) * 0.77 * SW)}px; top:${Math.round(sheet.y - SH / 2 + 10)}px; transform: translate(-50%,-50%) translateZ(${sheet.z + 6}px) rotate(${round((random() - 0.5) * 30, 1)}deg);"></div>`)
    decor.push(`<svg class="star" viewBox="0 0 100 100" style="left:${Math.round(sheet.x + (random() - 0.5) * 1.16 * SW)}px; top:${Math.round(sheet.y + (random() - 0.2) * 0.6 * SH)}px; width:${Math.round(SW * (0.14 + random() * 0.12))}px; transform: translate(-50%,-50%) translateZ(${sheet.z + 12}px) rotate(${Math.round(random() * 60)}deg);"><polygon points="50,2 61,38 98,38 68,60 79,96 50,74 21,96 32,60 2,38 39,38" fill="#141414"/></svg>`)
    if (i % 2 === 0) decor.push(`<div class="grid" style="left:${Math.round(sheet.x + (random() - 0.5) * 1.4 * SW)}px; top:${Math.round(sheet.y + (random() - 0.5) * 0.52 * SH)}px; transform: translate(-50%,-50%) translateZ(${sheet.z - 4}px) rotate(${round((random() - 0.5) * 20, 1)}deg);"></div>`)
    if (i % 3 === 1) {
      const k = decor.length
      decor.push(`<svg class="arc" viewBox="0 0 600 600" style="left:${Math.round(sheet.x + 0.18 * SW)}px; top:${Math.round(sheet.y + 0.16 * SH)}px; transform: translate(-50%,-50%) translateZ(${sheet.z + 30}px) rotate(${-20 + i * 25}deg);"><path id="arc${k}" d="M60,420 C120,120 420,60 540,260" pathLength="1" /></svg>`)
      js.push(`tl.fromTo("#arc${k}", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.5, ease: "power2.out" }, ${t(sheet.start + 0.5)});`)
    }
    if (look.bokeh !== false && i > 0) {
      for (let j = 0; j < 2; j += 1) {
        const colour = ['#141414', '#c8202a', '#e6dfd1'][(i + j) % 3]
        decor.push(`<div class="fg" style="left:${Math.round(sheets[i].x * (j ? 2.6 : -1.6))}px; top:${Math.round((sheets[i].y + sheets[i - 1].y) / 2 + j * 0.23 * SH)}px; width:${Math.round(SW * (0.58 + j * 0.05))}px; height:${Math.round(SW * (0.25 + ((i + j) % 3) * 0.09))}px; background:${colour}; clip-path:${tornEdge(900 + i * 2 + j, { points: 16, depth: 12 })}; transform: translate(-50%,-50%) translateZ(${260 + ((i + j) % 3) * 70}px) rotate(${((i * 37 + j * 53) % 80) - 40}deg);"></div>`)
      }
    }
  })

  js.push(`tl.fromTo("#blinds", { x: -80, y: 0 }, { x: 80, y: 60, duration: ${t(D)}, ease: "none" }, 0);`)
  // Grain is a function of time: the noise seed steps 24 times a second.
  js.push(`tl.fromTo("#grainClock", { x: 0 }, { x: 1, duration: ${t(D)}, ease: "none", onUpdate() { const f = Math.floor(this.time() * 24); document.getElementById("turb").setAttribute("seed", String((f * 7) % 97 + 1)); } }, 0);`)

  const minX = Math.min(...sheets.map(sheet => sheet.x)) - 2 * SW
  const maxX = Math.max(...sheets.map(sheet => sheet.x)) + 2 * SW
  const maxY = Math.max(...sheets.map(sheet => sheet.y)) + 2 * SH
  const tile = H >= W ? '1600px 2800px' : '2800px 1600px'
  const music = board.music ? `      <audio id="music" src="${escapeHtml(board.music.file)}" data-start="0" data-duration="${D}" data-media-start="${board.music.mediaStart}" data-track-index="9" data-volume="${board.music.volume ?? 1}"></audio>` : ''
  const fx = sfx.filter(item => item.at >= 0 && item.at < D - 0.1).map((item, i) => `      <audio id="fx${i + 1}" src="assets/sfx/${item.sound}.wav" data-start="${item.at}" data-duration="${round(Math.min(SFX[item.sound].duration, D - item.at))}" data-track-index="${10 + (i % 3)}" data-volume="${item.volume}"></audio>`)
  const grain = look.grain ?? 0.55
  const dof = look.dof ?? 9
  return `<!doctype html>
<html lang="ru" data-resolution="${H > W ? 'portrait' : W > H ? 'landscape' : 'square'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="${GSAP_URL}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #d9d1c1; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #d9d1c1; }
      #viewport { position: absolute; inset: 0; perspective: ${P}px; perspective-origin: 50% 46%; overflow: hidden; }
      #rig { position: absolute; left: ${W / 2}px; top: ${H / 2}px; width: 0; height: 0; transform-style: preserve-3d; }
      #pan, #board { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-style: preserve-3d; }
      .paper { position: absolute; left: ${Math.round(minX)}px; top: ${Math.round(-2 * SH)}px; width: ${Math.round(maxX - minX)}px; height: ${Math.round(maxY + 2 * SH)}px; background: #e3dccd url(${paper}) 0 0 / ${tile} repeat; }
      .sp, .tp { position: absolute; transform-style: preserve-3d; }
      .shadow { position: absolute; left: ${Math.round(SW * 0.034)}px; top: ${Math.round(SW * 0.052)}px; width: ${SW}px; height: ${SH}px; background: rgba(20,14,10,.42); filter: blur(22px); }
      .sheet { position: relative; width: ${SW}px; height: ${SH}px; overflow: hidden; background: #e8e1d2; }
      .sheet img, .sheet video { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: cover; }
      .strip, .tape, .star, .grid, .arc, .fg { position: absolute; }
      .tape { width: ${Math.round(SW * 0.32)}px; height: ${Math.round(SW * 0.1)}px; background: rgba(226,214,186,.78); }
      .grid { width: ${Math.round(SW * 0.8)}px; height: ${Math.round(SW * 0.64)}px; background-image: linear-gradient(rgba(25,25,25,.55) 2px, transparent 2px), linear-gradient(90deg, rgba(25,25,25,.55) 2px, transparent 2px); background-size: ${Math.round(SW * 0.13)}px ${Math.round(SW * 0.13)}px; opacity: .55; }
      .arc { width: 600px; height: 600px; }
      .arc path { fill: none; stroke: #23a7c9; stroke-width: 16; stroke-linecap: round; stroke-dasharray: 1; opacity: .9; }
      .fg { filter: blur(14px); opacity: .92; }
      .plate { display: inline-block; white-space: nowrap; font-family: "Oswald", sans-serif; font-weight: 700; font-size: ${Math.round(SW * 0.12)}px; line-height: 1; letter-spacing: .01em; text-transform: uppercase; }
      .plate span { display: block; padding: 0.23em 0.38em 0.18em; clip-path: var(--torn); }
      .plate-dark span { background: #141414; color: #f1ece2; }
      .plate-light span { background: #efe9dc; color: #141414; }
      .plate-cream-red span { background: #efe9dc; color: #c8202a; }
      .plate-red span { background: #c8202a; color: #f6f1e7; }
      .hero { font-family: "League Gothic", "Oswald", sans-serif; font-weight: 400; line-height: .86; color: #c8202a; }
      .hero span { padding: 0 10px; clip-path: none; text-shadow: 10px 12px 0 #141414; }
      #lens, #blindsWrap { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      #blinds { position: absolute; left: ${Math.round(-0.37 * W)}px; top: ${Math.round(-0.21 * H)}px; width: ${Math.round(1.74 * W)}px; height: ${Math.round(1.42 * H)}px; transform: rotate(-32deg); background: repeating-linear-gradient(90deg, rgba(60,45,30,0) 0px, rgba(60,45,30,0) 120px, rgba(60,45,30,.55) 150px, rgba(60,45,30,.55) 205px, rgba(60,45,30,0) 235px); filter: blur(26px); mix-blend-mode: multiply; opacity: ${look.blinds ?? 0.5}; }
      .dof { position: absolute; left: 0; width: 100%; backdrop-filter: blur(${dof}px); -webkit-backdrop-filter: blur(${dof}px); }
      #dofTop { top: 0; height: ${Math.round(H * 0.27)}px; mask-image: linear-gradient(to bottom, #000 0%, #000 25%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 25%, transparent 100%); }
      #dofBot { bottom: 0; height: ${Math.round(H * 0.32)}px; mask-image: linear-gradient(to top, #000 0%, #000 25%, transparent 100%); -webkit-mask-image: linear-gradient(to top, #000 0%, #000 25%, transparent 100%); }
      #vignette { position: absolute; inset: 0; background: radial-gradient(ellipse 75% 62% at 50% 48%, rgba(0,0,0,0) 55%, rgba(18,10,6,${look.vignette ?? 0.55}) 100%); }
      #grain { position: absolute; inset: 0; width: 100%; height: 100%; mix-blend-mode: overlay; opacity: ${grain}; }
      #flash { position: absolute; inset: 0; background: #fffaf0; opacity: 0; }
      #grainClock { position: absolute; width: 1px; height: 1px; opacity: 0; }
    </style>
  </head>
  <body>
    <!-- Written by pc-motion board build from board.json; edit board.json and rebuild. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}" data-motion-blur="on" data-layout-allow-overflow data-layout-allow-overlap>
      <div id="viewport" data-layout-ignore>
        <div id="rig">
          <div id="pan">
            <div id="board">
              <div class="paper"></div>
              ${decor.filter(item => !item.startsWith('<div class="fg"')).join('\n              ')}
${sheetHtml.join('\n')}
${texts.join('\n')}
              ${decor.filter(item => item.startsWith('<div class="fg"')).join('\n              ')}
            </div>
          </div>
        </div>
      </div>
      <div id="lens" data-layout-ignore>
        <div id="blindsWrap"><div id="blinds"></div></div>
        <div id="dofTop" class="dof"></div>
        <div id="dofBot" class="dof"></div>
        <div id="vignette"></div>
        <svg id="grain" viewBox="0 0 ${Math.round(W / 2)} ${Math.round(H / 2)}" preserveAspectRatio="none">
          <filter id="grainF"><feTurbulence id="turb" type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="1" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>
          <rect width="${Math.round(W / 2)}" height="${Math.round(H / 2)}" filter="url(#grainF)"/>
        </svg>
        <div id="flash"></div>
        <div id="grainClock"></div>
      </div>
${music}
${fx.join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${js.join('\n      ')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`
}

/**
 * Crumpled paper from straight folds: each fold is a line across the sheet,
 * a little lighter on one side and darker on the other, with a bright crease.
 * Seeded, so every build draws the same paper.
 */
export async function writePaper(file, { width = 800, height = 1400 } = {}) {
  const random = seeded(42)
  const terms = []
  for (let i = 0; i < 26; i += 1) {
    const angle = random() * Math.PI
    const nx = Math.cos(angle)
    const ny = Math.sin(angle)
    const c = -(nx * random() * width + ny * random() * height)
    const k = 0.8 + random() * 1.8
    const line = `(${nx.toFixed(4)}*X+${ny.toFixed(4)}*Y+${c.toFixed(1)})`
    terms.push(`${k.toFixed(2)}*(gt(${line},0)*2-1)`, `${(k * 1.4).toFixed(2)}*exp(-abs(${line})/1.3)`)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await ffmpeg([
    '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height},format=gray`,
    '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height},geq=lum='128+random(5)*14-7':cb=128:cr=128,format=gray`,
    '-filter_complex', `[0]geq=lum='206+${terms.join('+')}':cb=128:cr=128,format=gray[f];[f][1]blend=all_mode=overlay:all_opacity=0.3,scale=${width * 3}:${height * 3}:flags=bicubic,format=rgb24,colorchannelmixer=rr=1.0:gg=0.965:bb=0.905[c]`,
    '-map', '[c]', '-frames:v', '1', file,
  ])
  return file
}

export async function planBoard(dir) {
  const { paths, project } = await readProject(dir)
  const remix = await readJson(paths.remix).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('remix_missing', 'Нет remix.json.', 'Сначала `pc-motion remix plan --project .`: доски строятся из слотов ремикса.')
    throw error
  })
  const file = path.join(paths.root, 'board.json')
  const previous = await readJson(file, null)
  const board = boardFromRemix(remix, { width: project.width, height: project.height, fps: project.fps, clips: project.clips })
  // The look the user tuned survives a new plan.
  if (previous?.look) board.look = { ...board.look, ...previous.look }
  await writeJson(file, board)
  return {
    file: 'board.json',
    sheets: board.sheets.length,
    texts: board.texts.length,
    duration: board.duration,
    moves: Object.fromEntries(MOVES.map(move => [move, board.sheets.filter(sheet => sheet.move === move).length]).filter(([, n]) => n)),
    hint: 'Проверь board.json (move: glide|dive|roll, flash, x/y/rotate листов, надписи), затем `pc-motion board build --project .`.',
  }
}

export async function buildBoard(dir) {
  const { paths, project } = await readProject(dir)
  const file = path.join(paths.root, 'board.json')
  const board = await readJson(file).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('board_missing', 'Нет board.json.', 'Сначала `pc-motion board plan --project .`.')
    throw error
  })
  validateBoard(board)
  const folder = path.join(paths.assets, 'board')
  await mkdir(folder, { recursive: true })
  const paper = path.join(folder, 'paper.png')
  if (!(await stat(paper).catch(() => null))) await writePaper(paper, board.height >= board.width ? {} : { width: 1400, height: 800 })
  const ffmpegBin = await tool('ffmpeg')
  const stills = []
  for (const [i, sheet] of board.sheets.entries()) {
    const source = path.join(paths.root, sheet.file)
    if (!(await stat(source).catch(() => null))) throw new MotionError('clip_missing', `Лист ${i}: нет файла ${sheet.file}.`)
    // The still is the first frame of the sheet's window, shown until its clip starts.
    const out = path.join(folder, `sheet-${i}.jpg`)
    await grabFrame(ffmpegBin, source, [sheet.mediaStart, sheet.mediaStart + 0.1, 0], out, Math.min(1080, board.width))
    stills.push(path.relative(paths.root, out))
  }
  await writeFile(paths.index, boardIndex(board, { stills, paper: path.relative(paths.root, paper) }))
  if (project.builder !== 'board') await saveProject(paths, { ...project, builder: 'board' })
  return { index: 'index.html', duration: board.duration, sheets: board.sheets.length, texts: (board.texts ?? []).length }
}
