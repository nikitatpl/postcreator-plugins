/**
 * The remix recipe: the structure of a reference montage (edit-dna.json),
 * filled with the user's own material.
 *
 * plan   turns DNA shots into slots. With music in the project, each shot's
 *        length in beats is laid onto the music's detected beats, so cuts
 *        land on beats of the new track; otherwise the reference's seconds
 *        are kept. Every slot gets a clip window whose motion energy is
 *        closest to the reference shot's, without reusing a window; slots in
 *        a row on one clip play it forward.
 * build  writes index.html from remix.json: one video per slot inside an
 *        untimed wrapper, and the reference's transitions (flash, whip,
 *        fade, punch on accents) on the main timeline.
 *
 * remix.json stays editable: change a slot's clip, mediaStart or
 * transition, add texts, and build again.
 */
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { analyzeRhythm } from './audio.mjs'
import { escapeHtml, tornEdge } from './markup.mjs'
import { readJson, readProject, saveProject, writeJson } from './project.mjs'
import { SFX } from './sfx.mjs'
import { frameStats } from './shots.mjs'
import { GSAP_URL, MotionError, round } from './tools.mjs'

const TRANSITIONS = ['open', 'cut', 'flash', 'whip', 'fade']
export const BEAT_MODES = ['auto', 'same', 'double', 'half']
export const TEXT_STYLES = ['clean', 'plate-dark', 'plate-light', 'plate-red', 'hero']
export const TEXT_REVEALS = ['rise', 'type', 'stamp']
// Faces HyperFrames resolves by name; any other family fails its lint.
export const TEXT_FONTS = ['Inter', 'Oswald', 'League Gothic', 'Archivo Black']

/** Mean scene-change score per 0.1 s of a clip, cached next to the analysis. */
async function clipProfile(paths, clip) {
  const cache = path.join(paths.work, 'clips', `${clip.id}.json`)
  const cached = await readJson(cache, null)
  if (cached?.file === clip.file && cached.duration === clip.duration) return cached
  const frames = await frameStats(path.join(paths.root, clip.file))
  const bins = Math.max(1, Math.ceil(clip.duration / 0.1))
  const sums = new Array(bins).fill(0)
  const counts = new Array(bins).fill(0)
  for (const frame of frames) {
    const bin = Math.min(bins - 1, Math.floor(frame.t / 0.1))
    sums[bin] += frame.scene
    counts[bin] += 1
  }
  const profile = { file: clip.file, duration: clip.duration, step: 0.1, energy: sums.map((sum, i) => round(counts[i] ? sum / counts[i] : 0, 4)) }
  await writeJson(cache, profile)
  return profile
}

function windowEnergy(profile, start, duration) {
  const from = Math.floor(start / profile.step)
  const to = Math.max(from + 1, Math.ceil((start + duration) / profile.step))
  const slice = profile.energy.slice(from, to)
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0
}

/**
 * The music's beat grid at the reference's pace. Trackers often lock onto half
 * or double the felt tempo: a 160 BPM reference laid beat for beat onto a
 * 98 BPM track is cut 1.6 times slower. `auto` doubles or halves the grid when
 * that keeps the beat closer to the reference's; `same`, `double` and `half`
 * force it.
 */
export function beatGrid(musicBeats, referenceBpm, mode = 'auto') {
  if (musicBeats.length < 2 || !(referenceBpm > 0)) return { beats: musicBeats, scale: 1 }
  const gaps = musicBeats.slice(1).map((beat, i) => beat - musicBeats[i]).sort((a, b) => a - b)
  const period = gaps[Math.floor(gaps.length / 2)]
  const distance = scale => Math.abs(Math.log(period / scale / (60 / referenceBpm)))
  const scale = mode === 'auto'
    ? [0.5, 2].reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best), 1)
    : { same: 1, double: 2, half: 0.5 }[mode] ?? 1
  if (scale === 2) return { beats: musicBeats.flatMap((beat, i) => (i + 1 < musicBeats.length ? [beat, round((beat + musicBeats[i + 1]) / 2)] : [beat])), scale }
  if (scale === 0.5) return { beats: musicBeats.filter((_, i) => i % 2 === 0), scale }
  return { beats: musicBeats, scale }
}

/** Slot lengths: reference seconds, or reference beats laid onto the music's beats. */
export function slotTimes(shots, { musicBeats: trackBeats = [], referenceBpm = 0, duration, beats: beatMode = 'auto' } = {}) {
  const pattern = shots.map(shot => shot.duration)
  const useBeats = referenceBpm > 0 && trackBeats.length > 4
  const out = []
  if (useBeats) {
    const { beats: musicBeats, scale } = beatGrid(trackBeats, referenceBpm, beatMode)
    const beatOf = time => {
      // Beat index → time on the music, interpolating half beats.
      const i = Math.floor(time)
      const frac = time - i
      const a = musicBeats[Math.min(i, musicBeats.length - 1)]
      const b = musicBeats[Math.min(i + 1, musicBeats.length - 1)] ?? a
      return a + (b - a) * frac
    }
    const origin = musicBeats[0]
    let cursor = 0
    for (let k = 0; ; k += 1) {
      const shot = shots[k % shots.length]
      const beats = Math.max(0.5, Math.round(((shot.duration * referenceBpm) / 60) * 2) / 2)
      if (cursor + beats > musicBeats.length - 1) break
      const start = beatOf(cursor) - origin
      const end = beatOf(cursor + beats) - origin
      if (duration && start >= duration) break
      out.push({ shot: k % shots.length, start: round(start), duration: round(Math.min(end, duration ?? end) - start), beats })
      cursor += beats
      if (!duration && k + 1 >= shots.length) break
    }
    return { slots: out, musicOffset: round(origin), onBeats: true, beatScale: scale }
  }
  let start = 0
  for (let k = 0; ; k += 1) {
    const length = pattern[k % pattern.length]
    if (duration ? start >= duration - 0.05 : k >= pattern.length) break
    out.push({ shot: k % shots.length, start: round(start), duration: round(duration ? Math.min(length, duration - start) : length) })
    start += length
  }
  return { slots: out, musicOffset: 0, onBeats: false, beatScale: 1 }
}

/** Choose a clip and a window for every slot. */
export function assignClips(slots, shots, clips, profiles) {
  const used = new Map(clips.map(clip => [clip.id, []]))
  const uses = new Map(clips.map(clip => [clip.id, 0]))
  const energies = shots.map(shot => shot.energy)
  const maxShot = Math.max(...energies, 1e-6)
  let last = null
  return slots.map(slot => {
    const shot = shots[slot.shot]
    const target = shot.energy / maxShot
    const pinned = shot.clip && clips.find(clip => clip.id === shot.clip)
    // A shot of the scene the slot before belongs to keeps that slot's clip, playing on.
    const scene = !pinned && last && shot.scene !== undefined && last.scene === shot.scene && clips.find(clip => clip.id === last.clip)
    let best = null
    for (const clip of pinned ? [pinned] : scene ? [scene] : clips) {
      const profile = profiles.get(clip.id)
      const maxClip = Math.max(...profile.energy, 1e-6)
      const fits = clip.duration >= slot.duration
      const step = 0.2
      const starts = fits ? Array.from({ length: Math.floor((clip.duration - slot.duration) / step) + 1 }, (_, i) => round(i * step)) : [0]
      for (const start of starts) {
        const overlap = used.get(clip.id).some(([a, b]) => start < b && start + slot.duration > a)
        const energy = windowEnergy(profile, start, Math.min(slot.duration, clip.duration)) / maxClip
        // A run of slots on one clip plays it forward, as one shot cut on the beat.
        const back = last?.clip === clip.id ? (start < last.end - 1e-6 ? 0.5 : Math.min(0.3, (start - last.end) * 0.1)) : 0
        const cost = Math.abs(energy - target) + (overlap ? 1 : 0) + uses.get(clip.id) * 0.15 + back
        if (!best || cost < best.cost) best = { clip, start, cost }
      }
    }
    const rate = best.clip.duration >= slot.duration ? 1 : Math.max(0.5, round(best.clip.duration / slot.duration, 3))
    used.get(best.clip.id).push([best.start, best.start + slot.duration * rate])
    last = { clip: best.clip.id, end: best.start + slot.duration * rate, scene: shot.scene }
    uses.set(best.clip.id, uses.get(best.clip.id) + 1)
    return {
      clip: best.clip.id,
      file: best.clip.file,
      mediaStart: best.start,
      playbackRate: rate,
      short: best.clip.duration < slot.duration * 0.5,
    }
  })
}

/**
 * Words read off the reference (edit-dna.json `words`, reference seconds)
 * laid onto the plan: a word that appears a third into a reference shot
 * appears a third into that shot's slot. Each holds until the next word in
 * the same place, between 0.4 and 2.5 s.
 */
export function wordsToTexts(words, shots, slots, total) {
  const texts = []
  for (const word of [...(words ?? [])].filter(item => typeof item?.text === 'string' && item.text.trim() && Number.isFinite(item.at)).sort((a, b) => a.at - b.at)) {
    const shot = shots.find(item => word.at >= item.start && word.at < item.end) ?? shots.at(-1)
    const slot = slots.find(item => item.shot === shot.index)
    if (!slot) continue
    const into = shot.duration ? Math.min(1, Math.max(0, (word.at - shot.start) / shot.duration)) : 0
    const style = TEXT_STYLES.includes(word.style) ? word.style : 'plate-dark'
    texts.push({
      text: word.text,
      start: round(slot.start + into * slot.duration),
      position: ['upper', 'center', 'lower'].includes(word.position) ? word.position : 'center',
      style,
      reveal: TEXT_REVEALS.includes(word.reveal) ? word.reveal : style === 'hero' ? 'stamp' : 'type',
      ...(Number.isFinite(word.rotate) ? { rotate: word.rotate } : {}),
    })
  }
  texts.forEach((text, i) => {
    const next = texts.slice(i + 1).find(item => item.position === text.position)
    text.duration = round(Math.min(2.5, Math.max(0.4, (next ? next.start : total) - text.start)))
  })
  return texts.filter(text => text.start < total - 0.3)
}

export async function planRemix(dir, { duration, beats = 'auto' } = {}) {
  if (!BEAT_MODES.includes(beats)) throw new MotionError('argument_invalid', `--beats: ${BEAT_MODES.join(', ')}.`)
  const { paths, project } = await readProject(dir)
  const dna = await readJson(paths.dna).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('dna_missing', 'Нет edit-dna.json.', 'Сначала `pc-motion analyze-reference --project .`.')
    throw error
  })
  if (!Array.isArray(dna.shots) || dna.shots.length === 0) throw new MotionError('dna_invalid', 'В edit-dna.json нет кадров.')
  if (project.clips.length === 0) {
    throw new MotionError('clips_missing', 'В проекте нет материала.', 'Добавьте клипы `pc-motion ingest <файл> --project . --as clip` или сгенерируйте недостающие кадры в Postcreator и скачайте их `pc-motion fetch`.')
  }
  const profiles = new Map()
  for (const clip of project.clips) profiles.set(clip.id, await clipProfile(paths, clip))
  let musicBeats = []
  if (project.music) {
    const cache = path.join(paths.work, 'music-rhythm.json')
    const cached = await readJson(cache, null)
    // The track is always assets/music.wav: a new one of the same length must not reuse old beats.
    const musicSize = (await stat(path.join(paths.root, project.music.file))).size
    // The analysis measures the decoded track, the project its container: the two durations differ by a sample or so.
    const rhythm = cached?.file === project.music.file && Math.abs((cached.duration ?? -1) - project.music.duration) < 0.05 && cached.size === musicSize && cached.source === project.music.source
      ? cached
      : { file: project.music.file, source: project.music.source, ...(await analyzeRhythm(path.join(paths.root, project.music.file))) }
    if (rhythm !== cached) await writeJson(cache, { ...rhythm, size: musicSize })
    musicBeats = rhythm.beats
  }
  const limit = duration ?? (project.music ? project.music.duration : undefined)
  const timing = slotTimes(dna.shots, { musicBeats, referenceBpm: dna.music?.bpm ?? 0, duration: duration ?? undefined, beats })
  const slots = timing.slots.filter(slot => !limit || slot.start < limit - 0.05)
  const assigned = assignClips(slots, dna.shots, project.clips, profiles)
  const previous = await readJson(paths.remix, null)
  const total = round(slots.reduce((end, slot) => Math.max(end, slot.start + slot.duration), 0))
  const remix = {
    version: 1,
    width: project.width,
    height: project.height,
    fps: project.fps,
    duration: total,
    onBeats: timing.onBeats,
    beatScale: timing.beatScale,
    music: project.music ? { file: project.music.file, mediaStart: timing.musicOffset, volume: 1 } : null,
    slots: slots.map((slot, i) => {
      const shot = dna.shots[slot.shot]
      return {
        index: i,
        shot: slot.shot,
        start: slot.start,
        duration: slot.duration,
        ...(slot.beats ? { beats: slot.beats } : {}),
        ...assigned[i],
        transition: i === 0 ? 'open' : TRANSITIONS.includes(shot.transitionIn) ? shot.transitionIn : 'cut',
        accent: Boolean(shot.accent),
        describe: shot.describe ?? '',
      }
    }),
    texts: [],
  }
  // Captions written by hand win; otherwise the reference's words, re-timed.
  remix.texts = previous?.texts?.length ? previous.texts : wordsToTexts(dna.words, dna.shots, remix.slots, total)
  await writeJson(paths.remix, remix)
  const short = remix.slots.filter(slot => slot.short).map(slot => slot.index)
  const warnings = [
    ...(short.length ? [`Клипы короче слотов ${short.join(', ')}: они замедлены вдвое. Добавьте материал длиннее.`] : []),
    ...(project.music ? [] : ['Музыки нет: ролик будет без звука. Добавьте `--as music`.']),
    ...(!duration && remix.slots.length < dna.shots.length ? [`Трек кончился раньше референса: в план вошли ${remix.slots.length} из ${dna.shots.length} кадров. Возьмите трек длиннее${timing.beatScale < 2 ? ' или ускорьте монтаж: --beats double' : ''}.`] : []),
    ...(duration && remix.duration < duration - 0.5 ? [`Трек кончился на ${remix.duration} с, раньше --duration ${duration}.`] : []),
    ...(timing.beatScale !== 1 && beats === 'auto' ? [`Темп трека ${timing.beatScale === 2 ? 'вдвое медленнее' : 'вдвое быстрее'} референса: склейки легли на ${timing.beatScale === 2 ? 'половинные доли' : 'каждую вторую долю'}. Иначе: --beats same.`] : []),
  ]
  return {
    file: path.relative(paths.root, paths.remix),
    slots: remix.slots.length,
    duration: remix.duration,
    onBeats: remix.onBeats,
    beatScale: remix.beatScale,
    clipsUsed: [...new Set(remix.slots.map(slot => slot.clip))],
    ...(warnings.length ? { warnings } : {}),
  }
}

export function remixIndex(project, remix) {
  const { width: W, height: H } = project
  const D = remix.duration
  const slots = remix.slots
  const effects = []
  const sfx = []
  const fadeLead = i => round(Math.min(0.35, slots[i].duration / 3, slots[i - 1].duration / 3))
  slots.forEach((slot, i) => {
    const w = `#w${i}`
    const at = slot.start
    if (slot.transition === 'flash') {
      effects.push(`tl.fromTo("#flash", { opacity: 0 }, { opacity: 1, duration: 0.04, ease: "none", immediateRender: false }, ${round(at - 0.04)});`)
      effects.push(`tl.to("#flash", { opacity: 0, duration: 0.22, ease: "power2.out" }, ${at});`)
      sfx.push({ sound: 'swish', at: round(at - 0.12), volume: 0.18 })
    } else if (slot.transition === 'whip' && i > 0) {
      effects.push(`tl.to("#w${i - 1}", { x: ${-Math.round(W * 0.35)}, filter: "blur(18px)", duration: 0.12, ease: "power2.in" }, ${round(at - 0.12)});`)
      effects.push(`tl.fromTo("${w}", { x: ${Math.round(W * 0.35)}, filter: "blur(18px)" }, { x: 0, filter: "blur(0px)", duration: 0.18, ease: "power3.out", immediateRender: false }, ${at});`)
      sfx.push({ sound: 'whoosh', at: round(at - 0.2), volume: 0.22 })
    } else if (slot.transition === 'fade' && i > 0) {
      effects.push(`tl.fromTo("${w}", { opacity: 0 }, { opacity: 1, duration: ${fadeLead(i)}, ease: "none", immediateRender: false }, ${round(at - fadeLead(i))});`)
    }
    if (slot.accent && i > 0) {
      effects.push(`tl.fromTo("${w} .frame", { scale: 1.14 }, { scale: 1, duration: 0.42, ease: "expo.out", immediateRender: false }, ${at});`)
    } else {
      // A slow push-in keeps a held shot alive, as most edits do.
      effects.push(`tl.fromTo("${w} .frame", { scale: 1 }, { scale: 1.045, duration: ${slot.duration}, ease: "none", immediateRender: false }, ${at});`)
    }
  })
  const videos = slots.map((slot, i) => {
    const lead = slot.transition === 'fade' && i > 0 ? fadeLead(i) : 0
    const start = round(slot.start - lead)
    return `      <div id="w${i}" class="slot" style="z-index:${10 + i}"><div class="frame"><video id="v${i}" src="${escapeHtml(slot.file)}" data-start="${start}" data-duration="${round(slot.duration + lead)}" data-media-start="${round(Math.max(0, slot.mediaStart - lead * slot.playbackRate))}"${slot.playbackRate !== 1 ? ` data-playback-rate="${slot.playbackRate}"` : ''} data-track-index="${i % 2}" muted playsinline></video></div></div>`
  })
  const texts = (remix.texts ?? []).map((text, k) => {
    const placed = Number.isFinite(text.x) || Number.isFinite(text.y)
    const position = placed
      ? `left:${Math.round((text.x ?? 0.5) * W)}px; top:${Math.round((text.y ?? 0.5) * H)}px; right:auto; width:max-content; max-width:${Math.round(W * 0.86)}px; transform:translate(-50%,-50%)`
      : text.position === 'upper' ? `top:${Math.round(H * 0.16)}px` : text.position === 'lower' ? `bottom:${Math.round(H * (H > W ? 0.36 : 0.14))}px` : `top:${Math.round(H * 0.42)}px`
    const style = TEXT_STYLES.includes(text.style) ? text.style : 'clean'
    const reveal = TEXT_REVEALS.includes(text.reveal) ? text.reveal : style === 'hero' ? 'stamp' : 'rise'
    const letters = Math.max(3, String(text.text).length)
    if (reveal === 'type') {
      // Letter by letter, the way a word is typed onto a plate.
      effects.push(`tl.fromTo("#t${k} .rise", { clipPath: "inset(-30% 100% -30% 0%)" }, { clipPath: "inset(-30% 0% -30% 0%)", duration: ${round(Math.min(0.5, 0.045 * letters))}, ease: "steps(${letters})", immediateRender: false }, ${text.start});`)
    } else if (reveal === 'stamp') {
      effects.push(`tl.fromTo("#t${k} .rise", { scale: 1.6, opacity: 0, filter: "blur(12px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.22, ease: "expo.out", immediateRender: false }, ${text.start});`)
    } else {
      effects.push(`tl.fromTo("#t${k} .rise", { yPercent: 110 }, { yPercent: 0, duration: 0.5, ease: "expo.out", immediateRender: false }, ${text.start});`)
    }
    effects.push(`tl.to("#t${k} .rise", { opacity: 0, duration: 0.25, ease: "power2.in" }, ${round(text.start + text.duration - 0.27)});`)
    // Plates read best in a condensed face, a hero word in a tall one.
    const font = TEXT_FONTS.includes(text.font) ? text.font : style === 'hero' ? 'League Gothic' : style === 'clean' ? null : 'Oswald'
    const look = `${position};${font ? ` font-family: &quot;${font}&quot;, sans-serif;` : ''}`
    const tilt = text.rotate ? ` style="transform: rotate(${Number(text.rotate)}deg)"` : ''
    // A torn plate: the edge of a strip of paper ripped by hand.
    const edge = text.torn && style.startsWith('plate') ? ` style="clip-path: ${tornEdge(31 + k)}"` : ''
    // The clip fills the frame (the runtime anchors root clips at 0,0); the caption sits inside it.
    return `      <div id="t${k}" class="clip caption" data-start="${text.start}" data-duration="${text.duration}" data-track-index="5"><div class="title ${style}" style="${look}"><span class="mask"${tilt}><span class="rise"><span class="ink"${edge}>${escapeHtml(text.text)}</span></span></span></div></div>`
  })
  const audio = remix.music ? `      <audio id="music" src="${escapeHtml(remix.music.file)}" data-start="0" data-duration="${D}" data-media-start="${remix.music.mediaStart}" data-track-index="9" data-volume="${remix.music.volume ?? 1}"></audio>` : ''
  const fx = sfx.filter(item => item.at >= 0 && item.at < D - 0.1).map((item, i) => `      <audio id="fx${i + 1}" src="assets/sfx/${item.sound}.wav" data-start="${item.at}" data-duration="${round(Math.min(SFX[item.sound].duration, D - item.at))}" data-track-index="${10 + (i % 2)}" data-volume="${item.volume}"></audio>`)
  return `<!doctype html>
<html lang="ru" data-resolution="${H > W ? 'portrait' : W > H ? 'landscape' : 'square'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="${GSAP_URL}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .slot { position: absolute; inset: 0; }
      .frame { position: absolute; inset: 0; }
      .slot video { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover; }
      #flash { position: absolute; inset: 0; background: #fff; opacity: 0; z-index: 900; pointer-events: none; }
      .caption { position: absolute; inset: 0; z-index: 800; }
      .title { position: absolute; left: ${Math.round(W * 0.07)}px; right: ${Math.round(W * 0.07)}px; height: auto; color: #fff; font-family: "Inter", sans-serif; font-weight: 800; font-size: ${Math.round(Math.min(W, H) * 0.085)}px; line-height: 1.02; text-transform: uppercase; text-align: center; text-shadow: 0 4px 24px rgba(0,0,0,.45); }
      .mask { display: block; overflow: hidden; padding: 0.04em 0 0.1em; }
      .title.plate-dark, .title.plate-light, .title.plate-red { text-shadow: none; }
      .title.plate-dark .mask, .title.plate-light .mask, .title.plate-red .mask { padding: 0.2em 0 0.24em; }
      .title.plate-dark .ink { padding: 0.12em 0.3em 0.06em; background: #141414; color: #f1ece2; }
      .title.plate-light .ink { padding: 0.12em 0.3em 0.06em; background: #efe9dc; color: #141414; }
      .title.plate-red .ink { padding: 0.12em 0.3em 0.06em; background: #c8202a; color: #f6f1e7; }
      .ink { display: inline-block; }
      .title.hero { font-size: ${Math.round(Math.min(W, H) * 0.24)}px; font-weight: 400; line-height: 0.9; color: #c8202a; text-shadow: 0.035em 0.045em 0 #141414; }
      .rise { display: inline-block; }
    </style>
  </head>
  <body>
    <!-- Written by pc-motion remix build from remix.json; edit remix.json and rebuild. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
${videos.join('\n')}
      <div id="flash"></div>
${texts.join('\n')}
${audio}
${fx.join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${effects.join('\n      ')}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`
}

const finite = (value, min = 0) => typeof value === 'number' && Number.isFinite(value) && value >= min

/**
 * remix.json is meant to be edited by hand; its numbers go straight into
 * attributes and timeline code, so anything that is not a sane number is
 * refused with the slot or text it belongs to.
 */
export function validateRemix(remix) {
  if (!Array.isArray(remix.slots) || remix.slots.length === 0) throw new MotionError('remix_invalid', 'В remix.json нет слотов.')
  if (!finite(remix.duration, 0.1)) throw new MotionError('remix_invalid', 'remix.json: duration должно быть числом секунд.')
  remix.slots.forEach((slot, i) => {
    const where = `Слот ${slot.index ?? i}`
    if (!finite(slot.start) || !finite(slot.duration, 0.04) || !finite(slot.mediaStart)) throw new MotionError('remix_invalid', `${where}: start, duration и mediaStart должны быть числами секунд.`)
    if (!finite(slot.playbackRate, 0.25) || slot.playbackRate > 4) throw new MotionError('remix_invalid', `${where}: playbackRate — число от 0,25 до 4.`)
    if (typeof slot.file !== 'string' || !slot.file.startsWith('assets/')) throw new MotionError('remix_invalid', `${where}: file — путь внутри assets/.`)
    if (!TRANSITIONS.includes(slot.transition)) throw new MotionError('remix_invalid', `${where}: переход «${slot.transition}» — допустимы ${TRANSITIONS.join(', ')}.`)
  })
  for (const [k, text] of (remix.texts ?? []).entries()) {
    if (typeof text?.text !== 'string' || !text.text.trim() || !finite(text.start) || !finite(text.duration, 0.3)) {
      throw new MotionError('remix_invalid', `Надпись ${k}: нужны text (строка), start и duration (числа секунд, duration ≥ 0,3).`)
    }
    if (text.position !== undefined && !['upper', 'center', 'lower'].includes(text.position)) throw new MotionError('remix_invalid', `Надпись ${k}: position — upper, center или lower.`)
    if (text.style !== undefined && !TEXT_STYLES.includes(text.style)) throw new MotionError('remix_invalid', `Надпись ${k}: style — ${TEXT_STYLES.join(', ')}.`)
    if (text.reveal !== undefined && !TEXT_REVEALS.includes(text.reveal)) throw new MotionError('remix_invalid', `Надпись ${k}: reveal — ${TEXT_REVEALS.join(', ')}.`)
    for (const axis of ['x', 'y']) {
      if (text[axis] !== undefined && !(typeof text[axis] === 'number' && text[axis] >= 0 && text[axis] <= 1)) throw new MotionError('remix_invalid', `Надпись ${k}: ${axis} — доля кадра от 0 до 1.`)
    }
    if (text.font !== undefined && !TEXT_FONTS.includes(text.font)) throw new MotionError('remix_invalid', `Надпись ${k}: font — ${TEXT_FONTS.join(', ')}.`)
    if (text.rotate !== undefined && !(typeof text.rotate === 'number' && Number.isFinite(text.rotate) && Math.abs(text.rotate) <= 20)) throw new MotionError('remix_invalid', `Надпись ${k}: rotate — градусы от −20 до 20.`)
  }
  if (remix.music && (typeof remix.music.file !== 'string' || !finite(remix.music.mediaStart) || (remix.music.volume !== undefined && !finite(remix.music.volume)))) {
    throw new MotionError('remix_invalid', 'remix.json: music.file — строка, mediaStart и volume — числа.')
  }
}

export async function buildRemix(dir) {
  const { paths, project } = await readProject(dir)
  const remix = await readJson(paths.remix).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('remix_missing', 'Нет remix.json.', 'Сначала `pc-motion remix plan --project .`.')
    throw error
  })
  validateRemix(remix)
  for (const slot of remix.slots) {
    if (!(await stat(path.join(paths.root, slot.file)).catch(() => null))) throw new MotionError('clip_missing', `Слот ${slot.index}: нет файла ${slot.file}.`)
  }
  await writeFile(paths.index, remixIndex(project, remix))
  // review compares cuts only for a cut montage, not for the board's camera moves.
  if (project.builder !== 'remix') await saveProject(paths, { ...project, builder: 'remix' })
  return { index: 'index.html', duration: remix.duration, slots: remix.slots.length, texts: (remix.texts ?? []).length }
}

/**
 * What to generate before planning: one entry per scene of the reference that
 * no clip is pinned to yet, with prompts built from its description and the
 * reference style — a still first, then image→video at least as long as the
 * scene, so its slots can play the clip forward.
 */
export async function remixNeeds(dir) {
  const { paths, project } = await readProject(dir)
  const dna = await readJson(paths.dna).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('dna_missing', 'Нет edit-dna.json.', 'Сначала `pc-motion analyze-reference --project .`.')
    throw error
  })
  const owned = new Set(project.clips.map(clip => clip.id))
  const scenes = new Map()
  for (const shot of dna.shots ?? []) {
    const id = Number.isInteger(shot.scene) ? shot.scene : shot.index
    const scene = scenes.get(id) ?? { scene: id, shots: [], seconds: 0, describe: [], clip: null }
    scene.shots.push(shot.index)
    scene.seconds += shot.duration
    if (shot.describe && !scene.describe.includes(shot.describe)) scene.describe.push(shot.describe)
    if (shot.clip && owned.has(shot.clip)) scene.clip = shot.clip
    scenes.set(id, scene)
  }
  const aspect = project.height > project.width ? '9:16' : project.width > project.height ? '16:9' : '1:1'
  const look = [dna.style?.look, dna.style?.grade].filter(Boolean).join('. ')
  const needs = [...scenes.values()].filter(scene => !scene.clip).map(scene => {
    const describe = scene.describe.join('; ') || 'кадр сцены — опиши его в edit-dna.json (describe)'
    return {
      scene: scene.scene,
      name: `scene-${String(scene.scene).padStart(2, '0')}`,
      shots: scene.shots,
      seconds: round(scene.seconds),
      generate: Math.max(4, Math.ceil(scene.seconds + 0.5)),
      still: `${aspect} frame. ${describe}.${look ? ` ${look}.` : ''} No text, no letters, no logos, no watermark.`,
      motion: `Animate this frame: ${describe}. Camera: ${dna.style?.camera || 'slow push in with a slight drift'}. Keep the exact look, colours and texture of the first frame. No new text.`,
    }
  })
  return {
    kind: dna.kind ?? null,
    scenes: scenes.size,
    covered: scenes.size - needs.length,
    needs,
    hint: needs.length
      ? 'Котировка → согласие → кадр по `still`, затем image→video по `motion` не короче `generate` с; `pc-motion fetch <viewUrl> --project . --name <name>` и "clip": "<name>" у кадров `shots` в edit-dna.json.'
      : 'Материал есть для всех сцен: `pc-motion remix plan --project .`.',
  }
}
