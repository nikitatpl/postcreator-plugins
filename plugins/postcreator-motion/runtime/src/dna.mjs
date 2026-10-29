/**
 * Edit DNA: the structure of a reference montage, separated from its
 * footage and music. Machines measure what they can (cuts, transitions,
 * beats, energy); the agent looks at the contact sheet and writes what a
 * frame shows and how the piece looks into `describe` and `style`.
 */
import path from 'node:path'

import { analyzeRhythm, nearestBeat } from './audio.mjs'
import { readJson, readProject, writeJson } from './project.mjs'
import { analyzeShots, contactSheet, frameSignature, groupScenes, signatureDistance } from './shots.mjs'
import { MotionError, round } from './tools.mjs'

const ON_BEAT = 0.07

function pacing(shots, beats) {
  const lengths = shots.map(shot => shot.duration).sort((a, b) => a - b)
  const cuts = shots.slice(1).map(shot => shot.start)
  const onBeat = beats.length ? cuts.filter(cut => Math.abs(nearestBeat(beats, cut).offset) <= ON_BEAT).length : 0
  return {
    shots: shots.length,
    meanShot: round(lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)),
    medianShot: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
    shortestShot: lengths[0] ?? 0,
    longestShot: lengths.at(-1) ?? 0,
    cutsOnBeat: cuts.length ? round(onBeat / cuts.length, 2) : 0,
  }
}

/**
 * A montage cuts between pictures; a motion-design piece cuts inside one
 * picture (a board the camera crosses, words appearing). Two or more shots per
 * scene on average means the second kind: the remix recipe repeats only its
 * rhythm, the board recipe its look.
 */
export function referenceKind(scenes) {
  const count = new Set(scenes).size
  return { kind: scenes.length / Math.max(1, count) >= 1.8 ? 'motion-design' : 'montage', scenes: count }
}

/** Distance across every cut: the last strip frame of a shot against the first of the next. */
async function cutDistances(frames, shots) {
  const distances = []
  for (let i = 1; i < shots.length; i += 1) {
    const before = await frameSignature(path.join(frames, `shot-${String(shots[i - 1].index).padStart(2, '0')}-2.jpg`))
    const after = await frameSignature(path.join(frames, `shot-${String(shots[i].index).padStart(2, '0')}-0.jpg`))
    distances.push(signatureDistance(before, after))
  }
  return distances
}

/** Analyze work/reference/reference.mp4 into edit-dna.json, keeping descriptions already written. */
export async function analyzeReference(dir, { threshold } = {}) {
  const { paths, project } = await readProject(dir)
  if (!project.reference) throw new MotionError('reference_missing', 'В проекте нет референса.', 'Сначала `pc-motion ingest <ролик> --project . --as reference`.')
  const video = path.join(paths.root, project.reference.file)
  const { shots, flashes } = await analyzeShots(video, project.reference.duration, threshold ? { threshold } : {})
  const rhythm = project.reference.audio
    ? await analyzeRhythm(path.join(paths.root, project.reference.audio))
    : { bpm: 0, beats: [], downbeats: [], onsets: [], confidence: 0 }
  const beatLength = rhythm.bpm ? 60 / rhythm.bpm : 0
  const { sheet, pages } = await contactSheet(video, shots, path.join(paths.reference, 'frames'))

  const previous = await readJson(paths.dna, null)
  const kept = previous?.shots?.length === shots.length ? previous.shots : []
  const distances = await cutDistances(path.join(paths.reference, 'frames'), shots)
  // Scene ids written by hand survive re-analysis like descriptions do.
  const scenes = kept.length && kept.every(shot => Number.isInteger(shot.scene)) ? kept.map(shot => shot.scene) : groupScenes(distances)
  const { kind, scenes: sceneCount } = referenceKind(scenes)
  const dna = {
    version: 1,
    source: { file: project.reference.source, duration: project.reference.duration, width: project.reference.width, height: project.reference.height, fps: project.reference.fps },
    music: { bpm: rhythm.bpm, confidence: rhythm.confidence, beats: rhythm.beats, downbeats: rhythm.downbeats },
    kind,
    pacing: { ...pacing(shots, rhythm.beats), scenes: sceneCount },
    flashes,
    shots: shots.map((shot, i) => {
      const near = rhythm.beats.length && i > 0 ? nearestBeat(rhythm.beats, shot.start) : null
      return {
        ...shot,
        beats: beatLength ? round(shot.duration / beatLength, 2) : null,
        cutOnBeat: near ? Math.abs(near.offset) <= ON_BEAT : null,
        scene: scenes[i],
        ...(i > 0 ? { cutDistance: round(distances[i - 1], 3) } : {}),
        accent: rhythm.downbeats.some(beat => Math.abs(beat - shot.start) <= ON_BEAT),
        frame: path.relative(paths.root, path.join(paths.reference, 'frames', `shot-${String(shot.index).padStart(2, '0')}.jpg`)),
        // Written by the agent from the contact sheet; kept across re-analysis.
        describe: kept[i]?.describe ?? '',
        source: kept[i]?.source ?? 'material',
        ...(kept[i]?.clip ? { clip: kept[i].clip } : {}),
      }
    }),
    style: previous?.style ?? { look: '', camera: '', text: [], grade: '', notes: '' },
    // Words on screen, read by the agent off `look --reference`: { at, text, style, position } in reference seconds.
    words: previous?.words ?? [],
    contactSheet: path.relative(paths.root, sheet),
    contactSheets: pages.map(page => path.relative(paths.root, page)),
  }
  await writeJson(paths.dna, dna)
  return {
    file: path.relative(paths.root, paths.dna),
    contactSheet: dna.contactSheet,
    contactSheets: dna.contactSheets,
    shots: dna.shots.length,
    bpm: dna.music.bpm,
    kind: dna.kind,
    pacing: dna.pacing,
    transitions: Object.fromEntries([...new Set(dna.shots.map(shot => shot.transitionIn))].map(kind => [kind, dna.shots.filter(shot => shot.transitionIn === kind).length])),
    ...(kind === 'motion-design' ? { hint: `Моушн-дизайн: ${dna.shots.length} кадров на ${sceneCount} сцен — склейки внутри сцены. Ремикс повторит ритм; движение камеры по полотну даст \`pc-motion board\`. Слова референса: \`pc-motion look --project . --reference\`.` } : {}),
  }
}
