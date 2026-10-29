/**
 * Bring a Postcreator result (its signed https viewUrl) into the project.
 * Video becomes a remix clip through ingest; an image is kept as an asset.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ingest } from './ingest.mjs'
import { readProject, saveProject } from './project.mjs'
import { MotionError, probe } from './tools.mjs'

const MAX_BYTES = 500 * 1024 * 1024

export async function fetchArtifact(dir, url, { name, as } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new MotionError('url_invalid', 'Нужна ссылка https.')
  }
  if (parsed.protocol !== 'https:') throw new MotionError('url_invalid', 'Скачиваются только ссылки https (viewUrl результата Postcreator).')
  const { paths } = await readProject(dir)
  const downloads = path.join(paths.work, 'downloads')
  await mkdir(downloads, { recursive: true })
  const response = await fetch(parsed, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new MotionError('download_failed', `Скачивание не удалось: HTTP ${response.status}.`, 'Ссылка Postcreator живёт час: запросите результат заново.')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new MotionError('download_too_large', 'Файл больше 500 МБ.')
  const type = response.headers.get('content-type') ?? ''
  const extension = type.includes('video') ? '.mp4' : type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('jpeg') || type.includes('jpg') ? '.jpg' : type.includes('audio') ? '.wav' : path.extname(parsed.pathname) || '.bin'
  const base = (name ?? path.basename(parsed.pathname, path.extname(parsed.pathname))).replace(/[^a-z0-9а-яё_-]+/gi, '-').slice(0, 48) || 'download'
  const file = path.join(downloads, `${base}${extension}`)
  let received = 0
  const limited = Readable.fromWeb(response.body).on('data', chunk => {
    received += chunk.length
    if (received > MAX_BYTES) limited.destroy(new MotionError('download_too_large', 'Файл больше 500 МБ.'))
  })
  try {
    await pipeline(limited, createWriteStream(file))
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
  const info = await probe(file)
  const kind = as ?? (info.hasVideo && info.duration > 0.5 ? 'clip' : info.hasAudio && !info.hasVideo ? 'music' : 'image')
  if (kind === 'clip' || kind === 'music') return { downloaded: path.relative(paths.root, file), ...(await ingest(dir, file, { as: kind, name: base })) }
  const { project } = await readProject(dir)
  const target = path.join(paths.assets, 'images', path.basename(file))
  await mkdir(path.dirname(target), { recursive: true })
  await rename(file, target)
  project.images = [...(project.images ?? []), { file: path.relative(paths.root, target), width: info.width, height: info.height }]
  await saveProject(paths, project)
  return { as: 'image', file: path.relative(paths.root, target) }
}
