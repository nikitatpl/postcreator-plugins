/**
 * Render through the pinned HyperFrames CLI and prove the file is whole:
 * lint first (errors stop the render), then render, then ffprobe the result
 * against the composition's own duration.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { readProject } from './project.mjs'
import { firstJson, hyperframesArgs, MotionError, npx, probe, round, run } from './tools.mjs'

export const QUALITIES = ['draft', 'looks', 'delivery']

/** The root data-duration of index.html: what the render must last. */
export async function compositionDuration(indexFile) {
  const html = await readFile(indexFile, 'utf8')
  const root = /<div[^>]*data-composition-id="main"[^>]*>/.exec(html)?.[0] ?? ''
  const duration = Number(/data-duration="([\d.]+)"/.exec(root)?.[1])
  return Number.isFinite(duration) ? duration : null
}

export async function lintProject(dir) {
  const { paths } = await readProject(dir)
  const result = await run(await npx(), hyperframesArgs('lint', '--json', paths.root), { cwd: paths.root, timeoutMs: 10 * 60_000 })
  const report = firstJson(result.stdout)
  const findings = report?.findings ?? report?.issues ?? []
  const errors = findings.filter(finding => (finding.severity ?? finding.level) === 'error')
  return { ok: result.code === 0 && errors.length === 0, errors, warnings: findings.filter(finding => (finding.severity ?? finding.level) === 'warning'), raw: report ? undefined : result.stdout.slice(-2000) }
}

export async function renderProject(dir, { quality = 'draft', output, log = text => process.stderr.write(text) } = {}) {
  if (!QUALITIES.includes(quality)) throw new MotionError('quality_invalid', `--quality: ${QUALITIES.join(', ')}.`)
  const { paths, project } = await readProject(dir)
  const expected = await compositionDuration(paths.index)
  if (!expected || expected <= 1.01) throw new MotionError('composition_empty', 'index.html ещё пустой.', 'Сначала соберите проект: `pc-motion inserts build` или `pc-motion remix build`.')
  const lint = await lintProject(dir)
  if (!lint.ok) {
    throw new MotionError('lint_failed', `HyperFrames lint: ${lint.errors.length || 'есть'} ошибок. ${lint.errors.slice(0, 3).map(error => `${error.code ?? error.rule ?? ''} ${error.message ?? ''}`.trim()).join('; ')}`, 'Исправьте план и пересоберите; подробности — `npx hyperframes lint`.')
  }
  const file = path.resolve(output ?? path.join(paths.root, 'renders', `${project.title}-${quality}.mp4`))
  await mkdir(path.dirname(file), { recursive: true })
  const started = Date.now()
  const result = await run(await npx(), hyperframesArgs('render', paths.root, '--output', file, '--quality', quality, '--fps', String(project.fps), '--skill', 'hyperframes', '--quiet'), {
    cwd: paths.root,
    timeoutMs: 3 * 60 * 60_000,
    onStderr: log,
  })
  if (result.code !== 0) throw new MotionError('render_failed', `Рендер не удался: ${`${result.stderr}${result.stdout}`.trim().split('\n').slice(-5).join(' ')}`)
  const size = (await stat(file).catch(() => null))?.size ?? 0
  if (size === 0) throw new MotionError('render_empty', `Рендер не создал файл ${file}.`)
  const info = await probe(file)
  const drift = round(Math.abs(info.duration - expected), 3)
  return {
    output: path.relative(paths.root, file),
    duration: round(info.duration),
    expected,
    durationOk: drift <= Math.max(0.15, 2 / project.fps),
    size,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    seconds: round((Date.now() - started) / 1000, 1),
    warnings: lint.warnings.length,
  }
}
