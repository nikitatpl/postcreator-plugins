/**
 * Look at the result before calling it done. A review is a contact sheet of
 * the moments that matter (every insert landing, every slot), and for a
 * remix a side-by-side with the reference plus a measurement: the render's
 * cuts are detected again and compared with the plan.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { detectPeople } from './people.mjs'
import { readJson, readProject } from './project.mjs'
import { analyzeShots, grabFrame } from './shots.mjs'
import { compositionDuration } from './render.mjs'
import { footageCuts } from './track.mjs'
import { ffmpeg, firstJson, hyperframesArgs, MotionError, npx, probe, round, run, tool } from './tools.mjs'

async function latestRender(root) {
  const dir = path.join(root, 'renders')
  const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.mp4'))
  const dated = await Promise.all(names.map(async name => ({ name, time: (await stat(path.join(dir, name))).mtimeMs })))
  dated.sort((a, b) => b.time - a.time)
  return dated[0] ? path.join(dir, dated[0].name) : null
}

async function grab(video, time, out, width) {
  return grabFrame(await tool('ffmpeg'), video, [time, time - 0.1, time - 0.3], out, width)
}

async function sheet(images, out, columns) {
  const rows = []
  for (let i = 0; i < images.length; i += columns) rows.push(images.slice(i, i + columns))
  const dir = path.dirname(out)
  const rowFiles = []
  for (const [r, row] of rows.entries()) {
    const padded = [...row]
    if (padded.length < columns) {
      // A short last row is filled with black frames of the same size.
      const blank = path.join(dir, 'blank.jpg')
      await ffmpeg(['-i', row[0], '-vf', 'drawbox=c=black:t=fill', '-frames:v', '1', blank])
      while (padded.length < columns) padded.push(blank)
    }
    const file = path.join(dir, `row-${r}.jpg`)
    await ffmpeg([...padded.flatMap(image => ['-i', image]), '-filter_complex', `hstack=inputs=${padded.length}`, '-frames:v', '1', '-q:v', '4', file])
    rowFiles.push(file)
  }
  if (rowFiles.length === 1) await ffmpeg(['-i', rowFiles[0], '-frames:v', '1', out])
  else await ffmpeg([...rowFiles.flatMap(file => ['-i', file]), '-filter_complex', `vstack=inputs=${rowFiles.length}`, '-frames:v', '1', '-q:v', '4', out])
  return out
}

/**
 * Planned cuts a scene-change detector can see. A cut between two windows of
 * one clip barely changes the picture, and a cut sooner than the detector's
 * shortest shot after the previous one merges with it; both are left to the
 * eye (the review sheet) instead of being counted as missed.
 */
export function visibleCuts(slots, { minShot = 0.2 } = {}) {
  const visible = []
  const untestable = []
  slots.forEach((slot, i) => {
    if (i === 0 || slot.transition === 'fade') return
    const previous = slots[i - 1]
    const hidden = slot.file === previous.file || slot.start - previous.start < minShot
    ;(hidden ? untestable : visible).push(slot.start)
  })
  return { visible, untestable }
}

/**
 * How the render moves against the reference, slot by slot: the Pearson
 * correlation of mean motion energy inside each slot with the energy of the
 * reference shot it stands for. Near 1 the busy and calm moments land where
 * the reference has them.
 */
export function motionMatch(frames, slots, shots) {
  const pairs = []
  for (const slot of slots) {
    const shot = shots[slot.shot]
    const inside = frames.filter(frame => frame.t > slot.start + 0.07 && frame.t < slot.start + slot.duration - 0.07)
    if (!shot || inside.length === 0) continue
    pairs.push([shot.energy ?? 0, inside.reduce((sum, frame) => sum + frame.scene, 0) / inside.length])
  }
  if (pairs.length < 3) return { correlation: null, slots: pairs.length }
  const mean = k => pairs.reduce((sum, pair) => sum + pair[k], 0) / pairs.length
  const [ma, mb] = [mean(0), mean(1)]
  let cov = 0
  let va = 0
  let vb = 0
  for (const [a, b] of pairs) {
    cov += (a - ma) * (b - mb)
    va += (a - ma) ** 2
    vb += (b - mb) ** 2
  }
  return { correlation: va && vb ? round(cov / Math.sqrt(va * vb), 2) : null, slots: pairs.length }
}

/** Planned cut times against cuts found in the render. */
export function compareCuts(planned, detected, tolerance = 0.12) {
  const matched = planned.map(cut => {
    const nearest = detected.reduce((best, t) => (best === null || Math.abs(t - cut) < Math.abs(best - cut) ? t : best), null)
    return { cut, found: nearest, error: nearest === null ? null : round(nearest - cut) }
  })
  const hits = matched.filter(item => item.error !== null && Math.abs(item.error) <= tolerance)
  return {
    planned: planned.length,
    found: hits.length,
    meanError: hits.length ? round(hits.reduce((sum, item) => sum + Math.abs(item.error), 0) / hits.length) : null,
    missed: matched.filter(item => item.error === null || Math.abs(item.error) > tolerance).map(item => item.cut),
  }
}

/** The moments worth looking at: every insert in, landed, out and the speaker after it; every remix slot. */
export async function reviewMoments(paths, project, duration, { only } = {}) {
  const moments = []
  if (project.recipe === 'inserts' && only) {
    // One scene in detail while it is being drawn: in, every step, landing, middle and out.
    const insert = (await readJson(path.join(paths.work, 'inserts.resolved.json'), [])).find(item => item.id === only)
    if (!insert) throw new MotionError('insert_unknown', `Перебивки «${only}» нет в последней сборке.`, 'Соберите проект: `pc-motion inserts build --project .`.')
    const at = new Set([0.35, ...insert.marks.map(mark => mark + 0.3), insert.land + 0.35, insert.duration / 2, insert.duration - 0.6].map(t => round(Math.min(Math.max(t, 0.1), insert.duration - 0.1))))
    for (const t of [...at].sort((a, b) => a - b)) moments.push({ label: `${insert.id} +${t}`, t: insert.start + t })
  } else if (project.recipe === 'inserts') {
    const inserts = await readJson(path.join(paths.work, 'inserts.resolved.json'), [])
    if (inserts[0]?.start > 0.6) moments.push({ label: 'спикер', t: inserts[0].start / 2 })
    const captions = await readJson(path.join(paths.work, 'captions.resolved.json'), { keywords: [] })
    for (const keyword of captions.keywords.slice(0, 12)) moments.push({ label: `слово ${keyword.text}`, t: keyword.start + 0.6 })
    for (const [i, insert] of inserts.entries()) {
      const end = insert.start + insert.duration
      moments.push({ label: `${insert.id} вход`, t: insert.start + 0.35 })
      moments.push({ label: `${insert.id} land`, t: insert.start + insert.land + 0.35 })
      moments.push({ label: `${insert.id} конец`, t: end - 0.6 })
      // Back on the speaker: the middle of the gap before the next insert.
      const next = inserts[i + 1]?.start ?? Math.min(duration, end + 1)
      if (next - end > 0.2) moments.push({ label: `после ${insert.id}`, t: (end + next) / 2 })
    }
  } else {
    const remix = await readJson(paths.remix, { slots: [] })
    for (const slot of remix.slots) moments.push({ label: `слот ${slot.index}`, t: slot.start + slot.duration / 2, shot: slot.shot })
  }
  if (moments.length === 0) for (let k = 1; k <= 8; k += 1) moments.push({ label: `${k}/8`, t: (duration * k) / 9 })
  return moments.filter(moment => moment.t < duration - 0.05).map(moment => ({ ...moment, t: round(moment.t) }))
}

/**
 * Stills of the composition at the review moments, straight from HyperFrames
 * without a render: seconds instead of minutes, so the plan can be checked
 * and fixed before the first render.
 */
export async function snapshotProject(dir, { only, at } = {}) {
  const { paths, project } = await readProject(dir)
  const duration = await compositionDuration(paths.index)
  if (!duration || duration <= 1.01) throw new MotionError('composition_empty', 'index.html ещё пустой.', 'Сначала соберите проект.')
  // --at: exactly these seconds of the video; --only: one scene in detail; each keeps its own folder.
  const times = at === undefined ? null : String(at).split(',').map(Number).filter(t => Number.isFinite(t) && t >= 0 && t < duration)
  if (times && times.length === 0) throw new MotionError('argument_invalid', `--at: секунды через запятую, от 0 до ${round(duration, 2)}.`)
  const moments = times ? times.map(t => ({ label: `${t} с`, t: round(t) })) : await reviewMoments(paths, project, duration, { only })
  const output = path.join(paths.work, 'snapshots', ...(times ? ['at'] : only ? [only] : []))
  await rm(output, { recursive: true, force: true })
  const result = await run(await npx(), hyperframesArgs('snapshot', '--at', moments.map(moment => moment.t).join(','), '--no-end', '--json', '--output', output), { cwd: paths.root, timeoutMs: 15 * 60_000 })
  const report = firstJson(result.stdout)
  if (result.code !== 0 || !report) throw new MotionError('snapshot_failed', `Снимки не получились: ${`${result.stderr}${result.stdout}`.trim().split('\n').slice(-3).join(' ')}`)
  return {
    // Many moments are split over several sheets; every one of them has to be looked at.
    sheets: (report.contactSheets ?? []).map(sheet => path.relative(paths.root, sheet)),
    sheet: report.contactSheets?.[0] ? path.relative(paths.root, report.contactSheets[0]) : null,
    moments,
    frames: (report.frames ?? report.snapshots ?? []).length || moments.length,
  }
}

/**
 * The footage every few seconds, before any plan: burned-in captions, name
 * tags, free space for words. With `reference`, the reference instead, densely:
 * the words on screen and when each appears, to write into edit-dna.json.
 */
export async function lookFootage(dir, { every, from, to, width: wanted, reference = false } = {}) {
  const { paths, project } = await readProject(dir)
  if (reference && !project.reference) throw new MotionError('reference_missing', 'В проекте нет референса.', 'Сначала `pc-motion ingest <ролик> --project . --as reference`.')
  if (!reference && !project.footage) throw new MotionError('footage_missing', 'В проекте нет исходника.', 'Сначала `pc-motion ingest <видео> --project . --as footage`.')
  const media = reference ? project.reference : project.footage
  const step = Math.max(0.1, Number(every) || (reference ? 0.5 : 4))
  const output = path.join(paths.work, reference ? 'look-reference' : 'look')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const video = path.join(paths.root, media.file)
  // People are tinted red on the sheet: whatever is placed in the shot keeps off them.
  const people = reference ? null : await detectPeople(dir).then(() => readJson(path.join(paths.work, 'people.json'), null)).catch(() => null)
  const width = Math.max(160, Math.min(540, Math.round((Number(wanted) || 240) / 2) * 2))
  const height = Math.round((width * project.height) / project.width / 2) * 2
  const first = Number.isFinite(Number(from)) && from !== undefined ? Math.max(0, Number(from)) : reference ? 0 : Math.min(1, media.duration / 2)
  const last = Number.isFinite(Number(to)) && to !== undefined ? Math.min(media.duration - 0.05, Number(to)) : media.duration - (reference ? 0.05 : 0.2)
  const times = []
  for (let t = first; t < last; t += step) times.push(round(t, 2))
  const images = []
  for (const [i, t] of times.entries()) {
    const raw = path.join(output, `raw-${i}.jpg`)
    await grab(video, t, raw, width)
    const labelled = path.join(output, `f-${String(i).padStart(3, '0')}.jpg`)
    // A tenth-of-the-frame grid: positions for cards, words and people boxes read straight off the sheet.
    const marks = `drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.3,drawtext=text='${t}s':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6`
    const frame = people?.frames[Math.max(0, Math.min(people.frames.length - 1, Math.round(t * people.fps)))]
    if (frame) {
      const mask = path.join(output, `mask-${i}.pgm`)
      await writeFile(mask, Buffer.concat([Buffer.from(`P5 ${people.cols} ${people.rows} 255\n`), Buffer.from([...frame].map(cell => (cell === '1' ? 255 : 0)))]))
      await ffmpeg(['-i', raw, '-i', mask, '-filter_complex', `[0]scale=${width}:${height}[v];[1]scale=${width}:${height}:flags=neighbor,format=gray[m];color=c=red:s=${width}x${height}[c];[c][m]alphamerge,colorchannelmixer=aa=0.38[p];[v][p]overlay,${marks}`, '-frames:v', '1', labelled]).catch(() => ffmpeg(['-i', raw, '-vf', marks, '-frames:v', '1', labelled]))
      await rm(mask, { force: true })
    } else {
      await ffmpeg(['-i', raw, '-vf', marks, '-frames:v', '1', labelled]).catch(() => ffmpeg(['-i', raw, '-vf', 'drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.3', '-frames:v', '1', labelled]))
    }
    await rm(raw, { force: true })
    images.push(labelled)
  }
  const sheets = []
  for (let i = 0; i < images.length; i += 24) sheets.push(path.relative(paths.root, await sheet(images.slice(i, i + 24), path.join(output, `sheet-${sheets.length + 1}.jpg`), 6)))
  // Cuts are where a card or a word in the shot has to be gone.
  if (reference) return { every: step, frames: images.length, sheets, hint: 'Впиши слова референса в edit-dna.json → words: [{ "at": секунды референса, "text": свои слова, "style", "position" }]; remix plan разложит их по новому треку.' }
  return { every: step, frames: images.length, sheets, people: Boolean(people), cuts: await footageCuts(dir).catch(() => []) }
}

export async function reviewProject(dir, { video, against } = {}) {
  const { paths, project } = await readProject(dir)
  const file = video ? path.resolve(video) : await latestRender(paths.root)
  if (!file) throw new MotionError('render_missing', 'Нет готового рендера.', 'Сначала `pc-motion render --project .`.')
  const info = await probe(file)
  await rm(paths.review, { recursive: true, force: true })
  await mkdir(paths.review, { recursive: true })
  const width = project.height > project.width ? 300 : 400
  const valid = await reviewMoments(paths, project, info.duration)
  const images = []
  for (const [i, moment] of valid.entries()) images.push(await grab(file, moment.t, path.join(paths.review, `m-${String(i).padStart(3, '0')}.jpg`), width))
  const result = { video: path.relative(paths.root, file), duration: round(info.duration), moments: valid.map(moment => ({ label: moment.label, t: round(moment.t) })) }
  if (images.length) result.sheet = path.relative(paths.root, await sheet(images, path.join(paths.review, 'review.jpg'), project.height > project.width ? 6 : 4))

  if (project.recipe === 'remix') {
    const remix = await readJson(paths.remix, { slots: [] })
    const { visible, untestable } = visibleCuts(remix.slots)
    const { cuts, frames } = await analyzeShots(file, info.duration)
    // The board crosses one collage with camera moves instead of cuts: there is nothing to count.
    if (project.builder !== 'board') result.cuts = { ...compareCuts(visible, cuts), untestable }
    const dna = await readJson(paths.dna, null)
    if (dna?.shots) result.motion = motionMatch(frames, remix.slots, dna.shots)
    if (against === 'reference' && project.reference) {
      const dna = await readJson(paths.dna)
      const pairs = []
      for (const [i, moment] of valid.entries()) {
        const shot = dna.shots[moment.shot]
        if (!shot) continue
        const ref = await grab(path.join(paths.root, project.reference.file), shot.start + shot.duration / 2, path.join(paths.review, `r-${String(i).padStart(3, '0')}.jpg`), width)
        const out = path.join(paths.review, `p-${String(i).padStart(3, '0')}.jpg`)
        // Both frames at one height: the reference may have another aspect than the render.
        const height = Math.round((width * project.height) / project.width / 2) * 2
        await ffmpeg(['-i', ref, '-i', images[i], '-filter_complex', `[0]scale=-2:${height}[a];[1]scale=-2:${height}[b];[a][b]hstack=inputs=2`, '-frames:v', '1', '-q:v', '4', out])
        pairs.push(out)
      }
      if (pairs.length) result.compare = path.relative(paths.root, await sheet(pairs, path.join(paths.review, 'compare.jpg'), 3))
    }
  }
  return result
}
