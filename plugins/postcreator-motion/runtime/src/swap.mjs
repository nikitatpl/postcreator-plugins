/**
 * A swapped piece of footage — a generative edit (Seedance with a reference)
 * put back over the seconds it came from. By default it goes in as it is;
 * on request it is made to sit invisibly:
 *
 *   - align: generation models reframe, so the piece is fitted back onto the
 *     original by scale and shift; its edges fade into the original;
 *   - people: the people of the original are cut out and laid on top, so the
 *     speakers' faces and lips stay the real ones and anything new passes
 *     behind them;
 *   - captions: burned-in captions are keyed out of the original letter by
 *     letter (bright and green text with its outline) and laid on top.
 *
 * Every product is cached by what it was made from.
 */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { readJson, writeJson } from './project.mjs'
import { ffmpeg, hyperframesArgs, MotionError, npx, round, run } from './tools.mjs'
import { alignClip } from './track.mjs'

const fingerprint = async file => {
  const info = await stat(file)
  return `${info.size}:${Math.round(info.mtimeMs)}`
}

async function cached(paths, name, key, make) {
  const file = path.join(paths.work, 'segments', `${name}.json`)
  const previous = await readJson(file, null)
  if (previous && previous.key === key) return previous.value
  const value = await make()
  await mkdir(path.dirname(file), { recursive: true })
  await writeJson(file, { key, value })
  return value
}

// White text, or the accent green of a caption; the outline comes from growing the letters.
const LETTERS = 'if(gt(min(min(r(X\\,Y)\\,g(X\\,Y))\\,b(X\\,Y))\\,226)+gt(g(X\\,Y)-r(X\\,Y)\\,45)*gt(g(X\\,Y)\\,165)\\,255\\,0)'

/** Everything a swap needs besides its own file; returns what the index places. */
export async function prepareSwap(paths, project, insert) {
  const footage = path.join(paths.root, project.footage.file)
  const clip = path.join(paths.root, insert.file)
  const source = await fingerprint(footage)
  const window = `${insert.start}+${insert.duration}`
  const result = { align: null, people: null, captions: null }
  if (insert.align !== false) {
    result.align = await cached(paths, `${insert.id}-align`, `${source}|${await fingerprint(clip)}|${insert.start}`, () => alignClip(footage, insert.start, clip, project))
  }
  if (insert.people !== false) {
    const out = path.join(paths.root, 'assets', 'clips', `${insert.id}-people.webm`)
    result.people = await cached(paths, `${insert.id}-people`, `${source}|${window}`, async () => {
      const piece = path.join(paths.work, 'segments', `${insert.id}-window.mp4`)
      await mkdir(path.dirname(piece), { recursive: true })
      await mkdir(path.dirname(out), { recursive: true })
      await ffmpeg(['-ss', String(insert.start), '-i', footage, '-t', String(insert.duration), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', piece])
      const cut = await run(await npx(), hyperframesArgs('remove-background', piece, '-o', out, '--quality', 'balanced', '--json'), { cwd: paths.root, timeoutMs: 60 * 60_000 })
      if (cut.code !== 0) throw new MotionError('people_failed', `${insert.id}: не удалось вырезать людей: ${`${cut.stderr}${cut.stdout}`.trim().split('\n').slice(-2).join(' ')}`)
      return path.relative(paths.root, out)
    })
  }
  if (insert.captions) {
    const [x0, y0, x1, y1] = insert.captions
    const even = value => Math.max(2, Math.round(value / 2) * 2)
    const box = { x: even(x0 * project.width), y: even(y0 * project.height), w: even((x1 - x0) * project.width), h: even((y1 - y0) * project.height) }
    const out = path.join(paths.root, 'assets', 'clips', `${insert.id}-captions.webm`)
    const file = await cached(paths, `${insert.id}-captions`, `${source}|${window}|${JSON.stringify(box)}`, async () => {
      await mkdir(path.dirname(out), { recursive: true })
      await ffmpeg(['-ss', String(insert.start), '-t', String(insert.duration), '-i', footage, '-filter_complex', `[0]crop=${box.w}:${box.h}:${box.x}:${box.y},split[c][m];[m]format=rgb24,geq=r='${LETTERS}':g='${LETTERS}':b='${LETTERS}',format=gray,dilation,dilation,dilation,dilation,dilation[a];[c][a]alphamerge,format=yuva420p`, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '2M', '-auto-alt-ref', '0', out])
      return path.relative(paths.root, out)
    })
    result.captions = { file, ...box }
  }
  return result
}

/** The HTML of one swap inside #footwrap: the piece, then the people, then kept regions and captions. */
export function swapMarkup(project, insert, parts, track) {
  const clip = (id, src, style = '', extra = '') => `<video id="${id}" src="${src}" data-start="${insert.start}" data-duration="${insert.duration}"${extra} data-track-index="${track()}" muted playsinline${style ? ` style="${style}"` : ''}></video>`
  const align = parts.align
  // The piece's own edges fade into the original underneath.
  const feather = 'linear-gradient(to right, transparent 0, #000 5%, #000 95%, transparent 100%), linear-gradient(to bottom, transparent 0, #000 4%, #000 96%, transparent 100%)'
  const pieceStyle = align ? `transform-origin: 0 0; transform: translate(${align.x}px, ${align.y}px) scale(${align.scale}); -webkit-mask-image: ${feather}; mask-image: ${feather}; -webkit-mask-composite: source-in; mask-composite: intersect` : ''
  return [
    clip(insert.id, insert.file, pieceStyle),
    ...(parts.people ? [clip(`${insert.id}-people`, parts.people, '', ' data-layout-allow-occlusion')] : []),
    ...insert.keep.map((box, k) => clip(`${insert.id}-keep${k}`, project.footage.file, `clip-path: inset(${round(box[1] * 100, 2)}% ${round((1 - box[2]) * 100, 2)}% ${round((1 - box[3]) * 100, 2)}% ${round(box[0] * 100, 2)}%)`, ` data-media-start="${insert.start}"`)),
    ...(parts.captions ? [clip(`${insert.id}-captions`, parts.captions.file, `left: ${parts.captions.x}px; top: ${parts.captions.y}px; width: ${parts.captions.w}px; height: ${parts.captions.h}px`)] : []),
  ].join('')
}
