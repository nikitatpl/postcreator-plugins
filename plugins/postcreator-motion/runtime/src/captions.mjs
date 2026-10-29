/**
 * Captions for footage that has none burned in, from the whisper words. One
 * sub-composition over the whole video, hidden while an insert is on screen.
 *
 *   "captions": { "preset": "pop", "keywords": ["купол", "мокап"] }
 *   "captions": { "preset": "spatial", "base": "minimal",
 *                 "keywords": [{ "word": "купол", "place": "floor", "x": 0.5, "y": 0.62 }] }
 *
 * `spatial` puts the keywords into the shot itself — on the floor, a wall or
 * in the air, in that plane's perspective — and moves them with the camera
 * (work/track.json), so they read as part of the space.
 */
import { escapeHtml, fit, js, UPPER } from './markup.mjs'
import { MotionError, round } from './tools.mjs'
import { cleanWord, findWord } from './transcribe.mjs'

export const CAPTION_PRESETS = {
  pop: { summary: 'Поп: 1–3 слова в нижней трети, каждое выпрыгивает на своём слове, ключевые — акцентом.', maxWords: 3 },
  karaoke: { summary: 'Караоке: фраза до двух строк, текущее слово загорается плашкой акцента.', maxWords: 6 },
  stack: { summary: 'Стек: крупный кинетический блок — слова друг под другом, влетают с размытием, ключевое в плашке.', maxWords: 3 },
  minimal: { summary: 'Минимал: тихие субтитры строчными внизу кадра, фраза проявляется и тает.', maxWords: 7 },
  spatial: { summary: 'В пространстве: ключевые слова встают в перспективу кадра (пол, стена, воздух) и едут вместе с камерой; остальная речь — base (minimal или none).', maxWords: 7 },
}

export const PLACES = {
  floor: { x: 0.5, y: 0.62, transform: 'rotateX(58deg)' },
  'wall-left': { x: 0.3, y: 0.4, transform: 'rotateY(38deg)' },
  'wall-right': { x: 0.7, y: 0.4, transform: 'rotateY(-38deg)' },
  air: { x: 0.5, y: 0.3, transform: 'rotateY(-14deg) rotateX(8deg)' },
  ceiling: { x: 0.5, y: 0.2, transform: 'rotateX(-52deg)' },
}
const PLACE_ORDER = ['air', 'floor', 'wall-right', 'wall-left']
const ENDS_PHRASE = /[.!?…:;—–]$|,$/

/** Words grouped into what is read at a glance: a pause, punctuation or the word limit ends a phrase. */
export function phrases(words, { maxWords = 3, maxGap = 0.25, maxDuration = 2.4 } = {}) {
  const list = []
  let current = []
  const close = () => {
    if (current.length) list.push({ words: current, start: current[0].start, end: current.at(-1).end })
    current = []
  }
  for (const word of words) {
    const last = current.at(-1)
    if (last && (word.start - last.end > maxGap || current.length >= maxWords || word.end - current[0].start > maxDuration)) close()
    current.push(word)
    if (ENDS_PHRASE.test(word.text.trim())) close()
  }
  close()
  // A phrase stays up until the next one starts, but not long after its last word.
  // A caption at 0 s reads as part of the footage: the first one waits a beat.
  return list.map((phrase, i) => ({ ...phrase, start: round(Math.max(0.1, phrase.start)), end: round(Math.min(phrase.end + 0.3, list[i + 1]?.start ?? Infinity)) }))
}

/** Nothing over an insert: a phrase is cut back to the speaker's time and dropped if too little is left. */
function clear(item, inserts, minimum) {
  let { start, end } = item
  for (const insert of inserts) {
    const a = insert.start - 0.05
    const b = insert.start + insert.duration + 0.15
    if (start >= a && start < b) start = b
    if (end > a && end <= b) end = a
    if (start < a && end > b) end = a
  }
  return end - start >= minimum ? { ...item, start: round(start), end: round(end) } : null
}

function keywordStems(list) {
  return (list ?? []).map(item => cleanWord(typeof item === 'string' ? item : item?.word ?? '')).filter(Boolean)
}

/** Resolve the plan's captions against the words and the inserts; null when there are none to draw. */
export function resolveCaptions(spec, words, inserts) {
  if (!spec || spec.preset === undefined || spec.preset === 'none') return null
  const preset = CAPTION_PRESETS[spec.preset]
  if (!preset) throw new MotionError('captions_invalid', `Пресета субтитров «${spec.preset}» нет. Есть: ${Object.keys(CAPTION_PRESETS).join(', ')}, none.`)
  const base = spec.preset === 'spatial' ? spec.base ?? 'minimal' : spec.preset
  if (base !== 'none' && !CAPTION_PRESETS[base]) throw new MotionError('captions_invalid', `captions.base: «${base}» — нужен один из пресетов или none.`)
  const maxWords = Number.isInteger(spec.maxWords) && spec.maxWords > 0 ? spec.maxWords : CAPTION_PRESETS[base === 'none' ? 'minimal' : base].maxWords
  const lines = base === 'none' ? [] : phrases(words, { maxWords }).map(phrase => clear(phrase, inserts, 0.35)).filter(Boolean)
  const stems = keywordStems(spec.keywords)
  const marked = new Set()
  for (const line of lines) for (const word of line.words) if (stems.some(stem => cleanWord(word.text).startsWith(stem))) marked.add(word.i)
  let keywords = []
  if (spec.preset === 'spatial') {
    if (!Array.isArray(spec.keywords) || spec.keywords.length === 0) throw new MotionError('captions_invalid', 'Для spatial нужны captions.keywords: какие слова встают в пространство кадра.')
    let after = -Infinity
    keywords = spec.keywords.map((item, k) => {
      const entry = typeof item === 'string' ? { word: item } : item ?? {}
      const query = String(entry.word ?? '').trim()
      const found = entry.occurrence ? findWord(words, query, entry.occurrence) : findWord(words.filter(word => word.start > after), query, 1)
      if (!found) throw new MotionError('word_not_found', `captions.keywords[${k}]: слово «${query}» не найдено${after > -Infinity ? ` после ${round(after, 2)} с` : ''}.`, 'Проверьте `pc-motion words --project . --find …`.')
      after = found.start
      const placeName = entry.place ?? PLACE_ORDER[k % PLACE_ORDER.length]
      const place = PLACES[placeName]
      if (!place) throw new MotionError('captions_invalid', `captions.keywords[${k}].place: «${placeName}» — есть ${Object.keys(PLACES).join(', ')}.`)
      const x = Number.isFinite(entry.x) ? entry.x : place.x
      const y = Number.isFinite(entry.y) ? entry.y : place.y
      return { k, text: String(entry.text ?? found.text).replace(/[.,!?…:;«»"]/g, ''), start: round(found.start - 0.12), end: round(Math.max(found.end + 1.1, found.start + 1.5)), place: placeName, transform: place.transform, x, y, size: Number.isFinite(entry.size) ? entry.size : 1, accent: entry.accent ?? k % 2 === 1, ...(entry.overPeople === true ? { overPeople: true } : {}) }
    })
    keywords = keywords.map((item, i) => ({ ...item, end: round(Math.min(item.end, (keywords[i + 1]?.start ?? Infinity) - 0.1)) })).map(item => clear(item, inserts, 0.6)).filter(Boolean)
  }
  return { preset: spec.preset, base, position: Number.isFinite(spec.position) ? spec.position : null, lines, marked: [...marked], keywords }
}

/** Track frames a keyword needs, so the scene carries only what it uses. */
export function trackSlice(track, start, end) {
  if (!track) return null
  const from = Math.max(0, Math.floor(start * track.fps) - 1)
  const to = Math.min(track.frames.length - 1, Math.ceil(end * track.fps) + 1)
  return { from, frames: track.frames.slice(from, to + 1), cuts: track.cuts.filter(cut => cut > from && cut <= to) }
}

/** The captions sub-composition for compositions/captions.html. */
export function captionsScene(project, captions, track) {
  const { width: W, height: H } = project
  const u = Math.min(W, H) / 1080
  const px = value => Math.round(value * u)
  const pad = Math.round(W * 0.067)
  const { accent, ink, ground } = project.style
  const marked = new Set(captions.marked)
  const preset = captions.base
  const css = []
  const body = []
  const script = []
  const at = t => round(t)
  const top = captions.position ?? { pop: 0.64, karaoke: 0.66, stack: 0.58, minimal: 0.68 }[preset] ?? 0.66
  css.push(`#captions .cp-line { position: absolute; left: ${pad}px; right: ${pad}px; text-align: center; opacity: 0; text-shadow: 0 ${px(3)}px ${px(22)}px rgba(0,0,0,0.6), 0 0 ${px(2)}px rgba(0,0,0,0.5); }`)
  css.push('#captions .cp-w { display: inline-block; }')
  // Shouted styles drop the trailing comma or full stop; reading styles keep them.
  const bare = text => (preset === 'pop' || preset === 'stack' ? text.replace(/[.,;:]+$/, '') : text)
  const word = (w, extra = '') => `<span class="cp-w${marked.has(w.i) ? ' cp-key' : ''}"${extra}>${escapeHtml(bare(w.text))}</span>`
  captions.lines.forEach((line, i) => {
    const sel = `#cap-l${i}`
    const words = line.words
    if (preset === 'pop') {
      body.push(`<div class="cp-line cp-pop" id="cap-l${i}" style="top:${Math.round(top * H)}px">${words.map(w => word(w)).join(' ')}</div>`)
      script.push(`tl.set("${sel}", { opacity: 1 }, ${at(line.start)});`)
      words.forEach((w, k) => script.push(`tl.fromTo("${sel} .cp-w:nth-child(${k + 1})", { opacity: 0, scale: 0.4, y: ${px(34)} }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "back.out(2.6)" }, ${at(Math.max(line.start, w.start - 0.04))});`))
      script.push(`tl.to("${sel}", { opacity: 0, scale: 0.92, duration: 0.14 }, ${at(line.end - 0.14)});`)
      script.push(`tl.set("${sel}", { opacity: 0, visibility: "hidden" }, ${at(line.end)});`)
    } else if (preset === 'karaoke') {
      body.push(`<div class="cp-line cp-kar" id="cap-l${i}" style="top:${Math.round(top * H)}px">${words.map(w => word(w)).join(' ')}</div>`)
      script.push(`tl.fromTo("${sel}", { opacity: 0, y: ${px(16)} }, { opacity: 1, y: 0, duration: 0.18 }, ${at(line.start)});`)
      words.forEach((w, k) => {
        const next = words[k + 1]?.start ?? line.end
        script.push(`tl.to("${sel} .cp-w:nth-child(${k + 1})", { backgroundColor: ${js(accent)}, color: ${js(ground)}, duration: 0.08 }, ${at(w.start)});`)
        script.push(`tl.to("${sel} .cp-w:nth-child(${k + 1})", { backgroundColor: "rgba(0,0,0,0)", color: ${js(ink)}, duration: 0.12 }, ${at(Math.max(w.start + 0.1, next - 0.02))});`)
      })
      script.push(`tl.to("${sel}", { opacity: 0, duration: 0.14 }, ${at(line.end - 0.14)});`)
      script.push(`tl.set("${sel}", { opacity: 0, visibility: "hidden" }, ${at(line.end)});`)
    } else if (preset === 'stack') {
      const sizes = words.map(w => fit(bare(w.text), 132 * u, W - 2 * pad, 1, 0.35, UPPER))
      const height = sizes.reduce((sum, size) => sum + size * 1.02, 0)
      body.push(`<div class="cp-line cp-stack" id="cap-l${i}" style="top:${Math.round(top * H - height / 2)}px">${words.map((w, k) => `<div class="cp-row"><span class="cp-w${marked.has(w.i) ? ' cp-key' : ''}" style="font-size:${sizes[k]}px">${escapeHtml(bare(w.text))}</span></div>`).join('')}</div>`)
      script.push(`tl.set("${sel}", { opacity: 1 }, ${at(line.start)});`)
      words.forEach((w, k) => script.push(`tl.fromTo("${sel} .cp-row:nth-child(${k + 1}) .cp-w", { yPercent: 110, opacity: 0, filter: "blur(12px)" }, { yPercent: 0, opacity: 1, filter: "blur(0px)", duration: 0.36, ease: "expo.out" }, ${at(Math.max(line.start, w.start - 0.05))});`))
      script.push(`tl.to("${sel} .cp-w", { yPercent: -60, opacity: 0, duration: 0.18, ease: "power2.in", stagger: 0.03 }, ${at(line.end - 0.2)});`)
      script.push(`tl.set("${sel}", { opacity: 0, visibility: "hidden" }, ${at(line.end + 0.05)});`)
    } else {
      body.push(`<div class="cp-line cp-min" id="cap-l${i}" style="top:${Math.round(top * H)}px">${words.map(w => word(w)).join(' ')}</div>`)
      script.push(`tl.fromTo("${sel}", { opacity: 0, y: ${px(10)} }, { opacity: 1, y: 0, duration: 0.2 }, ${at(line.start)});`)
      script.push(`tl.to("${sel}", { opacity: 0, duration: 0.2 }, ${at(line.end - 0.2)});`)
      script.push(`tl.set("${sel}", { opacity: 0, visibility: "hidden" }, ${at(line.end)});`)
    }
  })
  css.push(`#captions .cp-pop { font-size: ${px(78)}px; font-weight: 800; text-transform: uppercase; line-height: 1.04; color: ${ink}; }`)
  css.push(`#captions .cp-kar { font-size: ${px(58)}px; font-weight: 800; line-height: 1.3; color: ${ink}; }`)
  css.push(`#captions .cp-kar .cp-w { padding: 0 ${px(10)}px; border-radius: ${px(12)}px; }`)
  css.push(`#captions .cp-stack .cp-w { font-weight: 900; text-transform: uppercase; line-height: 1.02; color: ${ink}; }`)
  css.push('#captions .cp-row { overflow: hidden; }')
  css.push(`#captions .cp-stack .cp-key { background: ${accent}; color: ${ground}; padding: 0 ${px(14)}px; text-shadow: none; }`)
  css.push(`#captions .cp-min { font-size: ${px(42)}px; font-weight: 600; line-height: 1.25; color: ${ink}; }`)
  css.push(`#captions .cp-pop .cp-key, #captions .cp-kar .cp-key, #captions .cp-min .cp-key { color: ${accent}; }`)

  // Keywords in the space of the shot.
  const tracks = captions.keywords.map(item => trackSlice(track, item.start, item.end))
  captions.keywords.forEach((item, k) => {
    const size = fit(item.text, 128 * u * item.size, W * 0.8, 1, 0.4, UPPER)
    body.push(`<div class="sp" id="cap-k${k}"><div class="sp-plane" style="transform:perspective(${px(900)}px) ${item.transform}"><div class="sp-text${item.accent ? ' sp-accent' : ''}" style="font-size:${size}px">${[...item.text].map(char => `<span class="sp-l">${char === ' ' ? '&nbsp;' : escapeHtml(char)}</span>`).join('')}</div></div></div>`)
    script.push(`tl.fromTo("#cap-k${k} .sp-l", { yPercent: 115, opacity: 0, filter: "blur(10px)" }, { yPercent: 0, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out", stagger: 0.03 }, ${at(item.start)});`)
    script.push(`tl.fromTo("#cap-k${k} .sp-plane", { scale: 1.18 }, { scale: 1, duration: 0.9, ease: "expo.out" }, ${at(item.start)});`)
    script.push(`tl.to("#cap-k${k} .sp-l", { yPercent: -35, opacity: 0, filter: "blur(12px)", duration: 0.38, ease: "power2.in", stagger: 0.02 }, ${at(item.end - 0.4)});`)
    script.push(`tl.set("#cap-k${k}", { visibility: "hidden" }, ${at(item.end + 0.05)});`)
  })
  css.push('#captions .sp { position: absolute; left: 0; top: 0; }')
  css.push('#captions .sp-plane { transform-origin: 50% 50%; }')
  css.push(`#captions .sp-text { font-weight: 900; text-transform: uppercase; white-space: nowrap; line-height: 1; color: ${ink}; text-shadow: 0 ${px(6)}px ${px(30)}px rgba(0,0,0,0.55); transform: translate(-50%, -50%); }`)
  css.push(`#captions .sp-accent { color: ${accent}; }`)
  css.push('#captions .sp-l { display: inline-block; }')
  const keywordData = captions.keywords.map((item, k) => ({ x: item.x * W - W / 2, y: item.y * H - H / 2, start: item.start, end: item.end, track: tracks[k] }))
  return `<template>
  <style>
    #captions-root { position: absolute; inset: 0; overflow: hidden; font-family: "Inter", sans-serif; pointer-events: none; }
    ${css.join('\n    ')}
  </style>
  <div id="captions-root" data-composition-id="captions" data-width="${W}" data-height="${H}">
    <div id="captions" style="position:absolute;inset:0">
      ${body.join('\n      ')}
    </div>
  </div>
  <script>
    (function () {
      const tl = gsap.timeline({ paused: true });
      ${script.join('\n      ')}
      // Keywords ride the camera: where the anchor of the keyword's first frame is now.
      const KEYS = ${js(keywordData)}, FPS = ${track?.fps ?? 0}, CX = ${W / 2}, CY = ${H / 2};
      const frameAt = (slice, t) => {
        const f = Math.max(0, Math.min(slice.frames.length - 1, t * FPS - slice.from)), i = Math.floor(f), m = f - i, a = slice.frames[i], b = slice.frames[Math.min(i + 1, slice.frames.length - 1)];
        return a.map((v, k) => v + (b[k] - v) * m);
      };
      const place = t => KEYS.forEach((key, k) => {
        let x = key.x, y = key.y, angle = 0, scale = 1;
        // Past a cut the word holds where the shot left it.
        const cut = key.track && key.track.cuts.find(c => c > key.start * FPS), now = Math.max(key.start, Math.min(t, key.end, cut ? (cut - 1) / FPS : Infinity));
        if (key.track && FPS) {
          const [a0, b0, tx0, ty0] = frameAt(key.track, key.start), [a, b, tx, ty] = frameAt(key.track, now);
          const d = a0 * a0 + b0 * b0, ia = a0 / d, ib = -b0 / d;
          // Back to the first frame of the shot, then forward to now.
          const ux = ia * (x - tx0) - ib * (y - ty0), uy = ib * (x - tx0) + ia * (y - ty0);
          x = a * ux - b * uy + tx; y = b * ux + a * uy + ty;
          const ra = a * ia - b * ib, rb = a * ib + b * ia;
          angle = Math.atan2(rb, ra) * 180 / Math.PI; scale = Math.hypot(ra, rb);
        }
        document.getElementById("cap-k" + k).style.transform = "translate(" + (CX + x).toFixed(1) + "px," + (CY + y).toFixed(1) + "px) rotate(" + angle.toFixed(2) + "deg) scale(" + scale.toFixed(4) + ")";
      });
      const clock = { t: 0 };
      place(0);
      if (KEYS.length) tl.fromTo(clock, { t: 0 }, { t: ${project.footage.duration}, duration: ${project.footage.duration}, ease: "none", onUpdate: () => place(clock.t) }, 0);
      window.__timelines["captions"] = tl;
    })();
  </script>
</template>
`
}
