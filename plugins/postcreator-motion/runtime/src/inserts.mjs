/**
 * The inserts recipe: a talking head stays as it is, full-frame infographic
 * cut-ins land on the words they explain.
 *
 * inserts.json names its times by words of the speech, so nobody types a
 * timecode:
 *
 *   { "inserts": [{
 *       "template": "stat",
 *       "at": { "word": "выросли" },          // the insert starts just before this word
 *       "until": { "word": "раза" },          // … and ends just after this one (or "duration": 3.5)
 *       "land": { "word": "четыре" },         // the number lands on this word
 *       "topic": "рост",
 *       "data": { "value": 4, "suffix": "×", "label": "рост за три года" }
 *   }] }
 *
 * Anchors are `{ "word": "…", "occurrence": 2 }` or plain seconds. The build
 * resolves them against work/transcript.json and refuses a plan it cannot
 * place: an unknown word, an overlap, an insert past the end of the video.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CAPTION_PRESETS, captionsScene, PLACES, resolveCaptions, trackSlice } from './captions.mjs'
import { readJson, readProject, writeJson } from './project.mjs'
import { renderScene, TEMPLATES } from './scenes.mjs'
import { ffmpeg, GSAP_URL, MotionError, probe, round } from './tools.mjs'
import { detectPeople, edgeWarnings, guardGraphics, peopleFor } from './people.mjs'
import { prepareSwap, swapMarkup } from './swap.mjs'
import { footageCuts, trackFootage } from './track.mjs'
import { cleanWord, findWord } from './transcribe.mjs'

const LEAD = 0.35
const TAIL = 0.4
// The speaker stays on screen at least 3 s between inserts: a one-second glimpse reads as a glitch.
const LIMITS = { minDuration: 1.5, maxDuration: 12, gap: 3, cardGap: 0.5 }

/**
 * A word anchor in seconds. Without an explicit `occurrence`, a word that
 * belongs to an insert (its end, landing, steps) is the first one spoken at
 * or after the insert's start: an earlier use of the same word elsewhere in
 * the video must not pull the end of the insert before its beginning.
 */
function anchor(spec, words, what, after = -Infinity) {
  if (typeof spec === 'number' && Number.isFinite(spec)) return { start: spec, end: spec }
  if (spec && typeof spec === 'object' && typeof spec.word === 'string') {
    const found = spec.occurrence ? findWord(words, spec.word, spec.occurrence) : findWord(words.filter(word => word.start >= after), spec.word, 1)
    if (!found) {
      const first = cleanWord(spec.word.split(/\s+/)[0] ?? '')
      const near = words.filter(word => cleanWord(word.text).startsWith(first.slice(0, 3))).slice(0, 5).map(word => `${word.text} (${word.start}s)`)
      throw new MotionError('word_not_found', `${what}: слово «${spec.word}»${spec.occurrence > 1 ? ` (${spec.occurrence}-е)` : ''} не найдено в расшифровке${after > -Infinity && !spec.occurrence ? ` после ${round(after, 2)} с` : ''}.`, near.length ? `Похожие: ${near.join(', ')}.` : 'Проверьте `pc-motion words --project . --find …`.')
    }
    return found
  }
  if (spec && typeof spec === 'object' && Number.isFinite(spec.t)) return { start: spec.t, end: spec.t }
  throw new MotionError('anchor_invalid', `${what}: ожидается число секунд или {"word": "…"}.`)
}

const CARD_SIZES = { square: [1080, 1080], tall: [1080, 1350], wide: [1350, 1080] }

// A full-frame insert replaces the picture; a card and a swapped piece of footage keep the speaker in view.
const isFull = insert => !insert.card && insert.template !== 'swap'

/** Regions of a swapped piece taken from the original footage instead — burned-in captions, a logo. */
function keepOf(value, id) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 3) throw new MotionError('insert_invalid', `${id}.keep: до трёх областей [x0, y0, x1, y1] долями кадра.`)
  return value.map((box, k) => {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || box[0] >= box[2] || box[1] >= box[3]) throw new MotionError('insert_invalid', `${id}.keep[${k}]: нужно [x0, y0, x1, y1] долями кадра, x0 < x1 и y0 < y1.`)
    return box
  })
}
const SOUNDS = ['boom', 'chime', 'tick', 'whoosh', 'swish']

/** An insert's own sounds instead of its template's: { "land": "boom" | null, "ticks": true }. */
function soundOf(spec, id) {
  if (!spec || typeof spec !== 'object') throw new MotionError('insert_invalid', `${id}.sound: ожидается { "land": "${SOUNDS.join('|')}" или null, "ticks": true/false }.`)
  if (spec.land !== undefined && spec.land !== null && !SOUNDS.includes(spec.land)) throw new MotionError('insert_invalid', `${id}.sound.land: «${spec.land}» — есть ${SOUNDS.join(', ')} или null.`)
  return { ...(spec.land !== undefined ? { land: spec.land } : {}), ...(spec.ticks !== undefined ? { ticks: spec.ticks === true } : {}) }
}

/**
 * An insert shown as a 3D card inside the shot instead of over the whole
 * frame: where it stands, how it is turned, and whether it rides the camera.
 */
function cardOf(spec, id) {
  if (spec === undefined || spec === false || spec === null) return null
  const card = spec === true ? {} : spec
  const size = card.size ?? 'square'
  if (!CARD_SIZES[size]) throw new MotionError('insert_invalid', `${id}.card.size: «${size}» — есть ${Object.keys(CARD_SIZES).join(', ')}.`)
  const number = (key, fallback, min, max) => {
    const value = card[key] ?? fallback
    if (!Number.isFinite(value) || value < min || value > max) throw new MotionError('insert_invalid', `${id}.card.${key}: нужно число от ${min} до ${max}.`)
    return value
  }
  const [width, height] = CARD_SIZES[size]
  return { size, width, height, x: number('x', 0.5, 0, 1), y: number('y', 0.3, 0, 1), scale: number('scale', 0.56, 0.2, 1), tilt: number('tilt', -14, -60, 60), pitch: number('pitch', 6, -45, 45), track: card.track !== false, ...(card.overPeople === true ? { overPeople: true } : {}) }
}

/** Place every insert on the footage timeline; throws on anything that cannot render well. */
export function resolveInserts(plan, words, footageDuration, warnings = []) {
  const list = Array.isArray(plan?.inserts) ? plan.inserts : []
  const captionsOnly = plan?.captions?.preset && plan.captions.preset !== 'none'
  if (list.length === 0 && !captionsOnly) throw new MotionError('inserts_empty', 'В inserts.json нет перебивок (ключ "inserts") и нет субтитров (ключ "captions").')
  const resolved = list.map((spec, k) => {
    const id = spec.id ?? `s${k + 1}`
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw new MotionError('insert_invalid', `Неверный id «${id}»: латиница, цифры, дефис.`)
    if (id === 'captions' || id === 'main') throw new MotionError('insert_invalid', `id «${id}» занят сборкой — выберите другой.`)
    if (spec.template === 'custom') {
      if (typeof spec.file !== 'string' || !/^custom\/[\w.-]+\.html$/.test(spec.file)) throw new MotionError('insert_invalid', `${id}: своей сцене нужен "file": "custom/<имя>.html".`)
    } else if (spec.template === 'swap') {
      if (typeof spec.file !== 'string' || !/^assets\/[\w./-]+\.(mp4|mov|webm)$/i.test(spec.file) || spec.file.includes('..')) throw new MotionError('insert_invalid', `${id}: замене нужен "file": "assets/clips/<имя>.mp4" — сгенерированный кусок, принесённый \`pc-motion fetch\`.`)
    } else if (!TEMPLATES[spec.template]) throw new MotionError('template_unknown', `${id}: шаблона «${spec.template}» нет. Есть: ${[...Object.keys(TEMPLATES), 'custom', 'swap'].join(', ')}.`)
    const at = spec.at !== undefined ? anchor(spec.at, words, `${id}.at`) : null
    // The start word is looked up from the beginning of the video: say so when it is spoken more than once.
    if (at && spec.at?.word && !spec.at.occurrence && findWord(words, spec.at.word, 2)) {
      const others = [2, 3, 4].map(n => findWord(words, spec.at.word, n)).filter(Boolean).map(found => `${round(found.start, 2)} с`)
      warnings.push(`${id}.at: «${spec.at.word}» взято на ${round(at.start, 2)} с, но звучит и на ${others.join(', ')} — проверьте; "occurrence": 1 подтвердит первое, 2 возьмёт второе`)
    }
    if (!at && !Number.isFinite(spec.start)) throw new MotionError('insert_invalid', `${id}: нужен "at" (слово или секунды) или "start".`)
    let start = Number.isFinite(spec.start) ? spec.start : at.start - (spec.lead ?? LEAD)
    start = Math.max(0, start)
    let duration
    if (Number.isFinite(spec.duration)) duration = spec.duration
    else if (spec.until !== undefined) duration = anchor(spec.until, words, `${id}.until`, start).end + (spec.tail ?? TAIL) - start
    else duration = 3.5
    if (start + duration > footageDuration - 0.05) duration = footageDuration - 0.05 - start
    if (duration < LIMITS.minDuration || duration > LIMITS.maxDuration) {
      throw new MotionError('insert_duration', `${id}: длительность ${round(duration, 2)} с — нужно от ${LIMITS.minDuration} до ${LIMITS.maxDuration} с.`, 'Сдвиньте "until" или задайте "duration".')
    }
    const local = (spec2, what) => round(anchor(spec2, words, `${id}.${what}`, start).start - start, 3)
    let land = spec.land === undefined ? Math.min(1, duration * 0.35) : typeof spec.land === 'number' ? spec.land : local(spec.land, 'land')
    land = Math.min(Math.max(land, 0.35), duration - 0.6)
    const marks = Array.isArray(spec.marks)
      ? spec.marks.map((mark, i) => Math.min(Math.max(typeof mark === 'number' ? mark : local(mark, `marks[${i}]`), 0.3), duration - 0.5))
      : []
    return {
      id,
      index: k + 1,
      template: spec.template,
      topic: spec.topic ?? '',
      start: round(start),
      duration: round(duration),
      land: round(land),
      marks: marks.map(mark => round(mark)),
      data: spec.data ?? {},
      sfx: spec.sfx !== false,
      ...(spec.sound !== undefined ? { sound: soundOf(spec.sound, id) } : {}),
      card: cardOf(spec.card, id),
      ...(spec.template === 'custom' ? { file: spec.file } : {}),
      ...(spec.template === 'swap' ? {
        file: spec.file,
        keep: keepOf(spec.keep, id),
        ...(spec.captions !== undefined ? { captions: keepOf([spec.captions], `${id}.captions`)[0] } : {}),
        // As it is by default; fitting back a reframed piece and laying the original people on top are opt-in.
        align: spec.align === true,
        people: spec.people === true,
        fade: Number.isFinite(spec.fade) ? Math.max(0, Math.min(1, spec.fade)) : 0.2,
      } : {}),
    }
  }).sort((a, b) => a.start - b.start)
  let lastFull = null
  for (let i = 0; i < resolved.length; i += 1) {
    // The speaker's 3 s between full-frame inserts count even with a card in between.
    if (isFull(resolved[i])) {
      if (lastFull && resolved[i].start < lastFull.start + lastFull.duration + LIMITS.gap) {
        throw new MotionError('inserts_overlap', `${resolved[i].id} начинается через ${round(resolved[i].start - lastFull.start - lastFull.duration, 2)} с после ${lastFull.id}: говорящий должен быть на экране не меньше ${LIMITS.gap} с между перебивками на весь кадр.`, 'Уберите одну из двух перебивок, объедините их в одну или сделайте одну из них карточкой ("card").')
      }
      lastFull = resolved[i]
    }
    // A card leaves the speaker in view, so next to it a short breath is enough.
    const previous = resolved[i - 1]
    if (previous && (!isFull(previous) || !isFull(resolved[i])) && resolved[i].start < previous.start + previous.duration + LIMITS.cardGap) {
      throw new MotionError('inserts_overlap', `${resolved[i].id} начинается через ${round(resolved[i].start - previous.start - previous.duration, 2)} с после ${previous.id}: между карточкой и соседней перебивкой нужно не меньше ${LIMITS.cardGap} с.`, 'Сдвиньте "at"/"until" или объедините перебивки.')
    }
  }
  const ids = resolved.map(insert => insert.id)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate) throw new MotionError('insert_invalid', `id «${duplicate}» встречается дважды: у каждой перебивки свой id.`)
  return resolved.map((insert, i) => ({ ...insert, index: i + 1 }))
}

/** Sound on what the viewer sees: in, landing, out. */
export function insertSfx(insert) {
  if (!insert.sfx) return []
  const at = t => round(insert.start + t)
  // A swapped piece of footage is the footage: silent unless the plan asks for a sound.
  if (insert.template === 'swap' && !insert.sound) return []
  // A drawn scene ticks on its steps unless the plan gives it its own sounds.
  const sound = { ...(TEMPLATES[insert.template]?.sound ?? (insert.template === 'custom' ? { ticks: true } : {})), ...(insert.sound ?? {}) }
  const sounds = insert.template === 'swap' ? [] : [{ sound: 'whoosh', at: at(-0.07), volume: 0.32 }]
  if (sound.land) sounds.push({ sound: sound.land, at: at(insert.land), volume: LAND_VOLUME[sound.land] })
  const ticks = insert.marks.length ? insert.marks : sound.ticks ? [insert.land] : []
  for (const mark of ticks) sounds.push({ sound: 'tick', at: at(mark), volume: 0.32 })
  sounds.push({ sound: 'swish', at: at(insert.duration - 0.5), volume: 0.22 })
  return sounds.filter(sound => sound.at >= 0)
}

const LAND_VOLUME = { boom: 0.5, chime: 0.22, tick: 0.32, whoosh: 0.3, swish: 0.22 }
const SFX_LENGTH = { whoosh: 0.7, swish: 0.45, boom: 0.9, tick: 0.08, chime: 1.4, riser: 1.2 }

/** Sounds that overlap go on different tracks: each takes the first track free by then. */
export function sfxTracks(sfx, D) {
  const busyUntil = []
  return sfx.filter(item => item.at < D - 0.1).sort((a, b) => a.at - b.at).map(item => {
    const length = round(Math.min(SFX_LENGTH[item.sound], D - item.at))
    let track = busyUntil.findIndex(end => end <= item.at)
    if (track < 0) track = busyUntil.push(0) - 1
    busyUntil[track] = item.at + length
    return { ...item, length, track: 10 + track }
  })
}

export function insertsIndex(project, inserts, { captions = false, track = null, swapParts = {} } = {}) {
  const { width: W, height: H } = project
  const D = project.footage.duration
  const sfx = inserts.flatMap(insertSfx)
  // The frame lands back on the speaker only after a full-frame insert.
  const ends = inserts.filter(isFull).map(insert => round(insert.start + insert.duration))
  const full = inserts.filter(isFull)
  const swaps = inserts.filter(insert => insert.template === 'swap')
  const cards = inserts.filter(insert => insert.card)
  const host = (insert, i, style) => `<div id="${insert.id}" class="scene" data-composition-id="${insert.id}" data-composition-src="compositions/${insert.id}.html" data-start="${insert.start}" data-duration="${insert.duration}" data-track-index="${1 + (i % 3)}" data-width="${insert.card ? insert.card.width : W}" data-height="${insert.card ? insert.card.height : H}" style="${style}"></div>`
  const cardData = cards.map(insert => ({ id: insert.id, start: insert.start, end: round(insert.start + insert.duration), w: insert.card.width, h: insert.card.height, x: insert.card.x * W - W / 2, y: insert.card.y * H - H / 2, scale: insert.card.scale, tilt: insert.card.tilt, pitch: insert.card.pitch, track: insert.card.track ? trackSlice(track, insert.start, insert.start + insert.duration) : null }))
  return `<!doctype html>
<html lang="ru" data-resolution="${H > W ? 'portrait' : W > H ? 'landscape' : 'square'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="${GSAP_URL}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${project.style.ground}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      #footwrap { position: absolute; inset: 0; transform-origin: 50% 45%; }
      #footage { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
      .scene { position: absolute; inset: 0; }
      .swap { position: absolute; inset: 0; opacity: 0; }
      .swap video { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
      .card { position: absolute; left: 0; top: 0; transform-origin: 50% 50%; opacity: 0; }
      .card-face { position: absolute; inset: 0; border-radius: ${Math.round(44 * Math.min(W, H) / 1080)}px; overflow: hidden; background: ${project.style.ground}; box-shadow: 0 40px 120px rgba(0, 0, 0, 0.55), 0 0 0 2px color-mix(in srgb, ${project.style.accent} 45%, transparent); }
      .card-face::after { content: ""; position: absolute; inset: 0; background: linear-gradient(135deg, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0) 38%); pointer-events: none; }
    </style>
  </head>
  <body>
    <!-- Written by pc-motion inserts build from inserts.json; edit the plan and rebuild. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
      <div id="footwrap">
        <video id="footage" src="${project.footage.file}" data-start="0" data-duration="${D}" data-track-index="0" muted playsinline></video>
${swaps.map((insert, i) => {
  let next = 20 + i * 8
  return `        <div class="swap" id="swap-${insert.id}">${swapMarkup(project, insert, swapParts[insert.id] ?? {}, () => next++)}</div>\n`
}).join('')}${cards.map(insert => `        <div class="card" id="card-${insert.id}" style="width:${insert.card.width}px;height:${insert.card.height}px"><div class="card-face">${host(insert, inserts.indexOf(insert), 'position:absolute;inset:0')}</div></div>\n`).join('')}${captions ? `        <div id="captions-host" class="scene" data-track-kind="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${D}" data-track-index="5" data-width="${W}" data-height="${H}"></div>\n` : ''}      </div>
${project.footage.voice ? `      <audio id="voice" src="${project.footage.voice}" data-start="0" data-duration="${D}" data-track-index="9" data-volume="1"></audio>\n` : ''}${full.map(insert => `      ${host(insert, inserts.indexOf(insert), `z-index:${10 + inserts.indexOf(insert)}`)}`).join('\n')}
${sfxTracks(sfx, D).map((item, i) => `      <audio id="fx${i + 1}" src="assets/sfx/${item.sound}.wav" data-start="${item.at}" data-duration="${item.length}" data-track-index="${item.track}" data-volume="${item.volume}"></audio>`).join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      // Back to the speaker after every insert: the frame lands from a slight zoom.
      gsap.set("#footwrap", { scale: 1 });
      ${JSON.stringify(ends)}.forEach((t) => {
        tl.fromTo("#footwrap", { scale: 1.09 }, { scale: 1, duration: 0.9, ease: "expo.out", immediateRender: false }, t);
      });
${cards.length ? `      // Cards stand in the shot: they fly in turned, ride the camera, and fly out.
      const CARDS = ${JSON.stringify(cardData).replace(/</g, '\\u003c')}, FPS = ${track?.fps ?? 0}, CX = ${W / 2}, CY = ${H / 2};
      const clamp = v => Math.max(0, Math.min(1, v)), easeOut = gsap.parseEase("expo.out"), easeIn = gsap.parseEase("power3.in");
      const frameAt = (slice, t) => { const f = Math.max(0, Math.min(slice.frames.length - 1, t * FPS - slice.from)), i = Math.floor(f), m = f - i, a = slice.frames[i], b = slice.frames[Math.min(i + 1, slice.frames.length - 1)]; return a.map((v, k) => v + (b[k] - v) * m); };
      const cardEls = CARDS.map(card => document.getElementById("card-" + card.id));
      const place = t => CARDS.forEach((card, k) => {
        const el = cardEls[k];
        if (t < card.start || t > card.end) { el.style.opacity = 0; return; }
        let x = card.x, y = card.y, roll = 0, zoom = 1;
        if (card.track && FPS) {
          // Past a cut the card holds where the shot left it.
          const cut = card.track.cuts.find(c => c > card.start * FPS), now = Math.min(t, cut ? (cut - 1) / FPS : Infinity);
          const [a0, b0, tx0, ty0] = frameAt(card.track, card.start), [a, b, tx, ty] = frameAt(card.track, now), d = a0 * a0 + b0 * b0, ia = a0 / d, ib = -b0 / d;
          const ux = ia * (x - tx0) - ib * (y - ty0), uy = ib * (x - tx0) + ia * (y - ty0);
          x = a * ux - b * uy + tx; y = b * ux + a * uy + ty;
          const ra = a * ia - b * ib, rb = a * ib + b * ia; roll = Math.atan2(rb, ra) * 180 / Math.PI; zoom = Math.hypot(ra, rb);
        }
        const come = easeOut(clamp((t - card.start) / 0.75)), go = easeIn(clamp((t - card.end + 0.5) / 0.45)), float = Math.sin(t * 1.3 + k) * 6;
        const turn = card.tilt + (1 - come) * -62 + go * 58, lift = card.pitch + (1 - come) * 10, size = card.scale * zoom * (0.55 + 0.45 * come) * (1 - 0.2 * go);
        el.style.opacity = (come * (1 - go)).toFixed(3);
        el.style.transform = "translate(" + (CX + x - card.w / 2).toFixed(1) + "px," + (CY + y - card.h / 2 + float).toFixed(1) + "px) perspective(1600px) rotateZ(" + roll.toFixed(2) + "deg) rotateY(" + turn.toFixed(2) + "deg) rotateX(" + lift.toFixed(2) + "deg) scale(" + size.toFixed(4) + ")";
      });
      const cardClock = { t: 0 };
      place(0);
      tl.fromTo(cardClock, { t: 0 }, { t: ${D}, duration: ${D}, ease: "none", onUpdate: () => place(cardClock.t) }, 0);
` : ''}${swaps.map(insert => `      // ${insert.id}: the generated piece crossfades over the footage and back, the voice runs on.
      tl.fromTo("#swap-${insert.id}", { opacity: 0 }, { opacity: 1, duration: ${insert.fade || 0.01}, ease: "none" }, ${insert.start});
      tl.to("#swap-${insert.id}", { opacity: 0, duration: ${insert.fade || 0.01}, ease: "none" }, ${round(insert.start + insert.duration - (insert.fade || 0.01))});
`).join('')}      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`
}

/**
 * A scene the agent wrote by hand (custom/<name>.html, a HyperFrames
 * sub-composition): used as it is, once it names the insert's id the way
 * the host and the timeline registry expect.
 */
/**
 * The agent's own scene. A fragment (style, markup, script) gets the shared
 * shell, timings and helpers from renderScene; a whole <template> is taken
 * as it is, for the rare scene that needs its own frame.
 */
async function customScene(paths, project, insert) {
  const html = await readFile(path.join(paths.root, insert.file), 'utf8').catch(() => {
    throw new MotionError('file_missing', `${insert.id}: нет файла ${insert.file}.`, 'Создайте заготовки: `pc-motion inserts scaffold --project .`.')
  })
  if (!html.trimStart().startsWith('<template>')) return renderScene(project, insert, html)
  if (!html.includes(`data-composition-id="${insert.id}"`) || !html.includes(`window.__timelines["${insert.id}"]`)) {
    throw new MotionError('insert_invalid', `${insert.file}: корень сцены должен иметь data-composition-id="${insert.id}", а таймлайн — window.__timelines["${insert.id}"].`)
  }
  return html
}

export async function buildInserts(dir) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const plan = await readJson(paths.inserts).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('plan_missing', 'Нет inserts.json.', 'Напишите план: `pc-motion inserts templates` покажет шаблоны и поля.')
    throw error
  })
  if (plan.style) project.style = { ...project.style, ...plan.style }
  const transcript = await readJson(paths.transcript, { words: [] })
  const warnings = []
  const inserts = resolveInserts(plan, transcript.words, project.footage.duration, warnings)
  // Render every scene first: a template error leaves the previous build untouched.
  const scenes = []
  for (const insert of inserts.filter(item => item.template !== 'swap')) scenes.push([insert.id, insert.template === 'custom' ? await customScene(paths, project, insert) : renderScene(project, insert)])
  const swapParts = {}
  for (const insert of inserts.filter(item => item.template === 'swap')) {
    const info = await probe(path.join(paths.root, insert.file)).catch(() => null)
    if (!info) throw new MotionError('file_missing', `${insert.id}: нет файла ${insert.file}.`, 'Принесите результат генерации: `pc-motion fetch <viewUrl> --project . --name <id>`.')
    // Generation returns whole seconds give or take a few frames: the piece ends where its video does.
    if (info.duration < insert.duration - 0.05) {
      warnings.push(`${insert.id}: сгенерированный кусок ${round(info.duration, 2)} с короче окна ${insert.duration} с — замена кончится вместе с ним`)
      insert.duration = round(Math.floor(info.duration * 25) / 25, 3)
    }
    swapParts[insert.id] = await prepareSwap(paths, project, insert)
    if (swapParts[insert.id].align && swapParts[insert.id].align.error > 30) warnings.push(`${insert.id}: сгенерированный кусок плохо совпал с оригиналом (ошибка ${swapParts[insert.id].align.error}) — проверьте кадры: \`pc-motion snapshot --only ${insert.id}\``)
  }
  // Captions give way to full-frame inserts only: a card leaves the speaker and the words in view.
  const captions = resolveCaptions(plan.captions, transcript.words, inserts.filter(isFull))
  // Keywords and cards placed in the shot follow the camera: track the footage once (cached).
  const tracked = captions?.keywords.length || inserts.some(insert => insert.card?.track)
  const track = tracked ? (await trackFootage(dir), await readJson(path.join(paths.work, 'track.json'))) : null
  const cutTimes = inserts.length || captions?.keywords.length ? await footageCuts(dir) : []
  // A word that sits in the shot leaves with the shot.
  if (captions) {
    captions.keywords = captions.keywords.map(item => {
      const cut = cutTimes.find(t => t > item.start + 0.05 && t < item.end)
      return cut === undefined ? item : { ...item, end: round(cut - 0.05) }
    }).filter(item => {
      if (item.end - item.start >= 0.6) return true
      warnings.push(`слово «${item.text}» убрано: склейка через ${round(item.end - item.start + 0.05, 2)} с после его появления`)
      return false
    })
  }
  for (const insert of inserts) {
    const end = insert.start + insert.duration
    const cut = cutTimes.find(t => t > insert.start + 0.1 && t < end - 0.1)
    if (insert.card && cut !== undefined) warnings.push(`карточка ${insert.id} переживает склейку на ${cut} с и останется в чужом кадре: закончите её раньше («until», "duration")`)
    // Ending a beat before a cut shows the old shot for a couple of frames.
    const next = cutTimes.find(t => t >= end - 0.1 && t < end + 0.3)
    if (!insert.card && next !== undefined && next > end) warnings.push(`перебивка ${insert.id} кончается за ${round(next - end, 2)} с до склейки на ${next} с: старый план мелькнёт на пару кадров — продлите её за склейку ("tail") или закончите раньше`)
  }
  // No graphic covers a person: cards and words in the shot keep off everyone, captions off faces.
  // Finding the people runs once per footage (the first time it fetches HyperFrames' matting model).
  const overlays = Boolean(captions) || inserts.some(insert => insert.card)
  if (overlays && !(Array.isArray(plan.people) && plan.people.length)) {
    await detectPeople(dir).catch(error => warnings.push(`людей в кадре найти не удалось (${error.message}): укажите их зоны в "people"`))
  }
  const people = overlays ? await peopleFor(paths, project, plan) : null
  if (overlays && !people) warnings.push('не проверено, закрывает ли графика людей: нет маски людей и зон "people"')
  const problems = overlays ? guardGraphics({ project, inserts, captions, track, people }) : []
  if (overlays) warnings.push(...edgeWarnings({ project, inserts, captions, track }))
  if (problems.length) {
    throw new MotionError('covers_people', `Графика закрывает людей или друг друга: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; и ещё ${problems.length - 5}` : ''}.`, 'Переставьте карточку или слово в свободное место по кадрам `look` ("x", "y", "scale"), закончите их раньше или сдвиньте субтитры ("captions.position").')
  }
  if (captions) scenes.push(['captions', captionsScene(project, captions, track)])
  await rm(paths.compositions, { recursive: true, force: true })
  await mkdir(paths.compositions, { recursive: true })
  for (const [id, html] of scenes) await writeFile(path.join(paths.compositions, `${id}.html`), html)
  await writeJson(path.join(paths.work, 'inserts.resolved.json'), inserts)
  await writeJson(path.join(paths.work, 'captions.resolved.json'), captions ?? { preset: 'none', lines: [], keywords: [] })
  await writeFile(paths.index, insertsIndex(project, inserts, { captions: Boolean(captions), track, swapParts }))
  return {
    index: 'index.html',
    inserts: inserts.map(insert => ({ id: insert.id, template: insert.template, start: insert.start, end: round(insert.start + insert.duration), land: round(insert.start + insert.land) })),
    resolved: 'work/inserts.resolved.json',
    captions: captions ? { preset: captions.preset, lines: captions.lines.length, keywords: captions.keywords.map(item => ({ text: item.text, start: item.start, end: item.end, place: item.place })) } : null,
    warnings,
  }
}

/**
 * A piece of the footage for a generative edit (Seedance edit with a
 * reference): silent, full quality, ready to upload. The edit is costly, so
 * the agent only offers it — with the price — and cuts the piece on consent.
 */
export async function cutSegment(dir, { from, to, id = 'segment', blank } = {}) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const start = Number(from)
  const end = Number(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > project.footage.duration) throw new MotionError('argument_invalid', `--from и --to: секунды исходника, от 0 до ${project.footage.duration}, from < to.`)
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw new MotionError('argument_invalid', '--id: латиница, цифры, дефис.')
  const length = round(end - start, 3)
  if (length < 4 || length > 30) throw new MotionError('segment_length', `Кусок ${length} с: Seedance правит от 4 до 30 с.`)
  const warnings = []
  if (Math.abs(length - Math.round(length)) > 0.01) warnings.push('длина не целая: генерация вернёт целые секунды — возьмите кусок целой длины, чтобы вставка совпала с речью')
  const cut = (await footageCuts(dir)).find(t => t > start + 0.05 && t < end - 0.05)
  if (cut !== undefined) warnings.push(`внутри куска склейка на ${cut} с: правка двух планов сразу выходит хуже — возьмите кусок внутри одного плана`)
  // --blank x0,y0,x1,y1 wipes burned-in captions before the edit: the model would redraw them garbled.
  let wipe = []
  if (blank !== undefined) {
    const box = String(blank).split(',').map(Number)
    if (box.length !== 4 || !box.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || box[0] >= box[2] || box[1] >= box[3]) throw new MotionError('argument_invalid', '--blank: x0,y0,x1,y1 долями кадра.')
    const px = (v, size) => Math.min(size - 2, Math.max(1, Math.round(v * size)))
    const x = px(box[0], project.width)
    const y = px(box[1], project.height)
    wipe = ['-vf', `delogo=x=${x}:y=${y}:w=${px(box[2], project.width) - x}:h=${px(box[3], project.height) - y}`]
  }
  const out = path.join(paths.work, 'segments', `${id}.mp4`)
  await mkdir(path.dirname(out), { recursive: true })
  await ffmpeg(['-ss', String(start), '-i', path.join(paths.root, project.footage.file), '-t', String(length), '-an', ...wipe, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out])
  const transcript = await readJson(paths.transcript, { words: [] })
  return {
    file: path.relative(paths.root, out),
    from: start,
    to: end,
    duration: length,
    bytes: (await stat(out)).size,
    spoken: transcript.words.filter(word => word.start >= start && word.start < end).map(word => word.text).join(' '),
    warnings,
    next: `Загрузите кусок в Postcreator (create_file_upload), посчитайте цену правки, покажите её пользователю; после генерации — \`pc-motion fetch <viewUrl> --project . --name ${id}\` и перебивка { "template": "swap", "file": "assets/clips/${id}.mp4", "start": ${start}, "duration": ${length}${blank !== undefined ? `, "captions": [${blank}]` : ''} }.`,
  }
}

/** What is said over an insert, for the scene's author. */
function spokenDuring(words, insert) {
  return words.filter(word => word.start >= insert.start && word.start < insert.start + insert.duration).map(word => word.text).join(' ')
}

/** Starter files for every custom insert of the plan that has none yet. */
export async function scaffoldScenes(dir) {
  const { paths, project } = await readProject(dir)
  if (!project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const plan = await readJson(paths.inserts)
  const transcript = await readJson(paths.transcript, { words: [] })
  const inserts = resolveInserts(plan, transcript.words, project.footage.duration)
  const written = []
  const kept = []
  for (const insert of inserts.filter(item => item.template === 'custom')) {
    const file = path.join(paths.root, insert.file)
    if (await stat(file).catch(() => null)) {
      kept.push(insert.file)
      continue
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, sceneStarter(insert, spokenDuring(transcript.words, insert)))
    written.push(insert.file)
  }
  return { written, kept, scenes: inserts.filter(item => item.template === 'custom').map(insert => ({ id: insert.id, file: insert.file, duration: insert.duration, land: insert.land, marks: insert.marks, spoken: spokenDuring(transcript.words, insert) })) }
}

function sceneStarter(insert, spoken) {
  return `<!--
  ${insert.id}${insert.topic ? ` («${insert.topic}»)` : ''}: ${spoken.replace(/--/g, '—')}
  Длина ${insert.duration} с. LAND = ${insert.land} с. MARKS = [${insert.marks.join(', ')}].
  Нарисуй то, о чём здесь говорят, — именно для этого ролика. Помощники описаны в скилле postcreator-motion-inserts.
-->
<style>
  .note { position: absolute; left: 0; right: 0; text-align: center; font-family: "JetBrains Mono", monospace; font-size: 24px; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0; }
</style>
<div class="note">${String(insert.topic || insert.id).replace(/[<>&]/g, '')}</div>
<script>
  // Заготовка: кольцо раскрывается к LAND, подпись встаёт под ним. Замени её своей сценой.
  const ring = mk("circle", { cx: B.cx, cy: B.cy, r: 0, stroke: AC, "stroke-width": 4 * U }, svg);
  $(".note").style.top = (B.cy + B.S * 0.42) + "px";
  clock(t => {
    put(ring, { r: B.S * 0.35 * out(ramp(t, LAND - 0.5, 0.6)) });
  });
  tl.to($(".note"), { opacity: 1, duration: 0.4 }, LAND);
</script>
`
}

export function describeCaptions() {
  return {
    presets: [...Object.entries(CAPTION_PRESETS).map(([name, { summary }]) => ({ name, summary })), { name: 'none', summary: 'без субтитров — когда они уже вшиты в исходник (по умолчанию)' }],
    places: Object.keys(PLACES),
    fields: { preset: 'имя пресета', keywords: 'слова-акценты: строки; для spatial — {word, occurrence, place, x, y, size, text, accent}', base: 'spatial: субтитры остальной речи — minimal или none', position: 'вертикаль строки, доля высоты кадра', maxWords: 'слов в фразе' },
  }
}

export function describeTemplates() {
  return [
    ...Object.entries(TEMPLATES).map(([name, { summary, data }]) => ({ name, summary, data })),
    { name: 'swap', summary: 'Замена куска самого видео сгенерированным (Seedance edit с референсом — дорого, только по согласию): кусок встаёт на своё место с мягким переходом, звук остаётся исходным; keep — области из оригинала (вшитые субтитры).', data: { file: 'assets/clips/<id>.mp4 (в самой перебивке)', keep: '[[x0, y0, x1, y1]] долями кадра', fade: 'секунды перехода, по умолчанию 0.2' } },
    { name: 'custom', summary: 'Сцена, нарисованная под этот ролик: файл custom/<id>.html со своими <style>, разметкой и <script>. Сборка добавляет ирис, HUD, подпись из data.title/kicker, время слов (DUR, LAND, MARKS) и помощники. Заготовки — `pc-motion inserts scaffold`.', data: { file: 'custom/<id>.html (в самой перебивке, не в data)', title: 'заголовок сверху, до 4 слов', kicker: 'строка над заголовком', '…': 'любые свои поля — в скрипте это DATA' } },
  ]
}
