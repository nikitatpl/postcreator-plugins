/**
 * Bring media into a project in the shapes the render and the analyses need.
 *
 *   footage    the talking head: H.264 picture cropped to the project frame,
 *              the voice as a separate track (48 kHz) and a 16 kHz copy for
 *              whisper. The picture is muted in the composition and the voice
 *              plays from its own track, so inserts never cut the speech.
 *   clip       material for a remix, cropped to the frame, without its sound.
 *   reference  a montage to learn from. Only a small analysis copy is kept in
 *              work/, never in assets/: its footage and music are not reused.
 *   music      the soundtrack of a remix.
 */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { projectPaths, readProject, saveProject } from './project.mjs'
import { ffmpeg, MotionError, probe, round } from './tools.mjs'

export const KINDS = ['footage', 'clip', 'reference', 'music']

function frameFilter(project) {
  const { width, height, fps } = project
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`
}

const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-movflags', '+faststart']

function safeName(file) {
  return path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'clip'
}

export async function ingest(dir, input, { as, name } = {}) {
  if (!KINDS.includes(as)) throw new MotionError('kind_invalid', `--as должен быть одним из: ${KINDS.join(', ')}.`)
  const source = path.resolve(input)
  if (!(await stat(source).catch(() => null))?.isFile()) throw new MotionError('file_missing', `Нет файла ${source}.`)
  const { paths, project } = await readProject(dir)
  const info = await probe(source)
  if (as !== 'music' && !info.hasVideo) throw new MotionError('media_invalid', `${path.basename(source)}: нет видеодорожки.`)
  if (as === 'music' && !info.hasAudio) throw new MotionError('media_invalid', `${path.basename(source)}: нет звука.`)

  if (as === 'footage') {
    const footage = path.join(paths.assets, 'footage.mp4')
    await ffmpeg(['-i', source, '-map', '0:v:0', '-vf', frameFilter(project), ...H264, '-an', footage])
    let voice = null
    if (info.hasAudio) {
      voice = 'assets/voice.wav'
      await ffmpeg(['-i', source, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(paths.root, voice)])
      await mkdir(paths.work, { recursive: true })
      await ffmpeg(['-i', source, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path.join(paths.work, 'voice16k.wav')])
    }
    const rendered = await probe(footage)
    project.footage = { file: 'assets/footage.mp4', voice, duration: round(rendered.duration), source: path.basename(source), sourceSize: `${info.width}x${info.height}` }
  } else if (as === 'clip') {
    await mkdir(paths.clips, { recursive: true })
    let id = name ? safeName(name) : safeName(source)
    const taken = new Set(project.clips.map(clip => clip.id))
    for (let n = 2; taken.has(id); n += 1) id = `${safeName(name ?? source)}-${n}`
    const file = `assets/clips/${id}.mp4`
    await ffmpeg(['-i', source, '-map', '0:v:0', '-vf', frameFilter(project), ...H264, '-an', path.join(paths.root, file)])
    const rendered = await probe(path.join(paths.root, file))
    project.clips.push({ id, file, duration: round(rendered.duration), source: path.basename(source) })
  } else if (as === 'reference') {
    await mkdir(paths.reference, { recursive: true })
    await ffmpeg(['-i', source, '-map', '0:v:0', '-vf', 'scale=540:-2:flags=bicubic,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', path.join(paths.reference, 'reference.mp4')])
    if (info.hasAudio) await ffmpeg(['-i', source, '-map', '0:a:0', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', path.join(paths.reference, 'audio.wav')])
    project.reference = { file: 'work/reference/reference.mp4', audio: info.hasAudio ? 'work/reference/audio.wav' : null, duration: round(info.duration), width: info.width, height: info.height, fps: info.fps, source: path.basename(source) }
  } else {
    const file = 'assets/music.wav'
    await ffmpeg(['-i', source, '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(paths.root, file)])
    project.music = { file, duration: round(info.duration), source: path.basename(source) }
  }
  await saveProject(paths, project)
  return { as, project: projectPaths(dir).root, source: path.basename(source), probe: info, ...(as === 'clip' ? { clip: project.clips.at(-1) } : {}), ...(as === 'footage' ? { footage: project.footage } : {}) }
}
