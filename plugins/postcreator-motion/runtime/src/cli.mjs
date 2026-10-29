#!/usr/bin/env node
/**
 * pc-motion — the local montage kit. Every command prints one JSON document
 * on stdout (agents parse it); progress goes to stderr. A failure prints
 * {"ok": false, "error": {code, message, hint}} and exits with 1.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeRhythm } from './audio.mjs'
import { analyzeReference } from './dna.mjs'
import { applyPlan, doctor } from './doctor.mjs'
import { fetchArtifact } from './fetch.mjs'
import { ingest } from './ingest.mjs'
import { buildInserts, cutSegment, describeCaptions, describeTemplates, scaffoldScenes } from './inserts.mjs'
import { ledgerCommand } from './ledger.mjs'
import { initProject, readJson, readProject, writeJson } from './project.mjs'
import { buildBoard, planBoard } from './board.mjs'
import { buildRemix, planRemix, remixNeeds } from './remix.mjs'
import { renderProject } from './render.mjs'
import { lookFootage, reviewProject, snapshotProject } from './review.mjs'
import { detectPeople } from './people.mjs'
import { trackFootage } from './track.mjs'
import { analyzeShots, contactSheet } from './shots.mjs'
import { writeSfxPack } from './sfx.mjs'
import { MotionError, probe } from './tools.mjs'
import { findWord, transcribe } from './transcribe.mjs'

const USAGE = `pc-motion — локальный монтаж: перебивки к говорящей голове и монтаж по референсу.

  doctor [--fix --yes] [--skip-hyperframes]     что есть на компьютере и как поставить недостающее
  init <папка> --recipe inserts|remix [--format portrait|landscape|square] [--fps 30]
  ingest <файл> --project <папка> --as footage|clip|reference|music [--name имя]
  transcribe --project <папка> [--lang ru]      слова с таймкодами (whisper.cpp)
  words --project <папка> [--find "слово"]      расшифровка и поиск слова
  inserts templates                             шаблоны перебивок и их поля
  inserts build --project <папка>               inserts.json → compositions/ и index.html
  inserts scaffold --project <папка>            заготовки custom/<id>.html для сцен плана
  analyze-reference --project <папка>           референс → edit-dna.json и contact.jpg
  remix plan --project <папка> [--duration с] [--beats auto|same|double|half]  DNA + клипы + музыка → remix.json
  remix build --project <папка>                 remix.json → index.html
  remix needs --project <папка>                 сцены референса без материала и промпты для генерации
  board plan --project <папка>                  remix.json → board.json: камера по коллажу из листов
  board build --project <папка>                 board.json → index.html (3D-камера, плашки, зерно, расфокус)
  shots <видео> [--out папка]                   склейки и переходы любого видео
  beats <аудио|видео>                           темп, доли и такты
  look --project <папка> [--every 4] [--from с] [--to с] [--width px] [--reference]
                                                кадры исходника: вшитые субтитры, плашки, люди (красным), склейки;
                                                --reference — кадры референса часто, чтобы прочитать его слова
  track --project <папка>                       движение камеры для слов в пространстве (work/track.json)
  segment --project <папка> --from с --to с --id <id> [--blank x0,y0,x1,y1]
                                                кусок видео для генеративной правки (Seedance edit)
  people --project <папка>                      где люди в кадре (локальная модель HyperFrames, ~168 МБ при первом запуске)
  snapshot --project <папка> [--only <id>] [--at 12.5,14]
                                                кадры без рендера; --only — одна сцена подробно, --at — свои секунды
  render --project <папка> [--quality draft|looks|delivery] [--output файл]
  review --project <папка> [--video файл] [--against reference]
  ledger <list|cap|check|find|add|done|failed> --project <папка> ...
  fetch <https-ссылка> --project <папка> [--name имя] [--as clip|image|music]
  sfx --project <папка>                         пересоздать набор звуков`

/** Flags that never take a value, so `--yes file` keeps `file` as an argument. */
const BOOLEAN_FLAGS = new Set(['yes', 'fix', 'skip-hyperframes', 'reference'])

export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2)
      if (inline !== undefined) flags[key] = inline
      else if (!BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[(i += 1)]
      else flags[key] = true
    } else positional.push(arg)
  }
  return { positional, flags }
}

function need(flags, key) {
  if (flags[key] === undefined || flags[key] === true) throw new MotionError('argument_missing', `Нужен --${key}.`)
  return flags[key]
}

function numberFlag(flags, key) {
  if (flags[key] === undefined) return undefined
  const value = Number(flags[key])
  if (!Number.isFinite(value)) throw new MotionError('argument_invalid', `--${key} должно быть числом.`)
  return value
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const { positional, flags } = parseArgs(rest)
  const project = () => need(flags, 'project')
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      return { usage: USAGE }
    case 'doctor': {
      const report = await doctor({ hyperframes: !flags['skip-hyperframes'] })
      if (!flags.fix) return report
      if (!flags.yes) return { ...report, applied: [], note: 'План установки показан, но не выполнен: повторите с --fix --yes после согласия пользователя.' }
      const applied = await applyPlan(report.plan)
      return { ...(await doctor({ hyperframes: !flags['skip-hyperframes'] })), applied }
    }
    case 'init':
      if (!positional[0]) throw new MotionError('argument_missing', 'Укажите папку проекта.')
      return (({ paths, project: created, sfx }) => ({ project: paths.root, recipe: created.recipe, format: created.format, size: `${created.width}x${created.height}`, sfx }))(
        await initProject(positional[0], { recipe: need(flags, 'recipe'), format: flags.format ?? 'portrait', fps: numberFlag(flags, 'fps') ?? 30, title: flags.title }))
    case 'ingest':
      if (!positional[0]) throw new MotionError('argument_missing', 'Укажите файл.')
      return ingest(project(), positional[0], { as: need(flags, 'as'), name: flags.name })
    case 'transcribe':
      return transcribe(project(), { lang: flags.lang ?? 'ru', model: flags.model })
    case 'words': {
      const { paths } = await readProject(project())
      const transcript = await readJson(paths.transcript)
      if (flags.find) {
        const matches = []
        for (let n = 1; n <= 20; n += 1) {
          const match = findWord(transcript.words, flags.find, n)
          if (!match) break
          matches.push({ occurrence: n, ...match })
        }
        return { query: flags.find, matches }
      }
      return { text: transcript.text, words: transcript.words.map(word => `${word.start.toFixed(2)} ${word.text}`) }
    }
    case 'inserts':
      if (positional[0] === 'templates') return { templates: describeTemplates(), captions: describeCaptions() }
      if (positional[0] === 'scaffold') return scaffoldScenes(project())
      if (positional[0] === 'build') return buildInserts(project())
      throw new MotionError('argument_invalid', 'inserts templates | inserts build --project <папка> | inserts scaffold --project <папка>')
    case 'analyze-reference':
      return analyzeReference(project(), { threshold: numberFlag(flags, 'threshold') })
    case 'remix':
      if (positional[0] === 'plan') return planRemix(project(), { duration: numberFlag(flags, 'duration'), beats: flags.beats ?? 'auto' })
      if (positional[0] === 'build') return buildRemix(project())
      if (positional[0] === 'needs') return remixNeeds(project())
      throw new MotionError('argument_invalid', 'remix plan | remix build | remix needs --project <папка>')
    case 'board':
      if (positional[0] === 'plan') return planBoard(project())
      if (positional[0] === 'build') return buildBoard(project())
      throw new MotionError('argument_invalid', 'board plan | board build --project <папка>')
    case 'shots': {
      if (!positional[0]) throw new MotionError('argument_missing', 'Укажите видео.')
      const file = path.resolve(positional[0])
      const info = await probe(file)
      const { shots, flashes } = await analyzeShots(file, info.duration, { threshold: numberFlag(flags, 'threshold') })
      const out = { file, duration: info.duration, shots, flashes }
      if (flags.out) {
        out.contactSheet = (await contactSheet(file, shots, path.join(path.resolve(flags.out), 'frames'))).sheet
        await writeJson(path.join(path.resolve(flags.out), 'shots.json'), { shots, flashes })
      }
      return out
    }
    case 'beats':
      if (!positional[0]) throw new MotionError('argument_missing', 'Укажите аудио или видео.')
      return analyzeRhythm(path.resolve(positional[0]))
    case 'segment':
      return cutSegment(project(), { from: flags.from, to: flags.to, id: flags.id, blank: flags.blank })
    case 'look':
      return lookFootage(project(), { every: flags.every, from: flags.from, to: flags.to, width: flags.width, reference: Boolean(flags.reference) })
    case 'track':
      return trackFootage(project())
    case 'people':
      return detectPeople(project())
    case 'snapshot':
      return snapshotProject(project(), { only: flags.only, at: flags.at })
    case 'render':
      return renderProject(project(), { quality: flags.quality ?? 'draft', output: flags.output })
    case 'review':
      return reviewProject(project(), { video: flags.video, against: flags.against })
    case 'ledger':
      return ledgerCommand(project(), positional[0], { rub: flags.rub, cost: flags.cost, key: flags.key, task: flags.task, tool: flags.tool, model: flags.model, slot: flags.slot, note: flags.note, file: flags.file })
    case 'fetch':
      if (!positional[0]) throw new MotionError('argument_missing', 'Укажите ссылку.')
      return fetchArtifact(project(), positional[0], { name: flags.name, as: flags.as })
    case 'sfx': {
      const { paths } = await readProject(project())
      return { sfx: await writeSfxPack(paths.sfx) }
    }
    default:
      throw new MotionError('command_unknown', `Нет команды «${command}».`, 'pc-motion help')
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    emit({ ok: false, error: { code: 'node_too_old', message: `Нужен Node 22+, сейчас ${process.versions.node}.`, hint: 'Установите Node 22 или новее.' } })
    process.exitCode = 1
  } else {
    main().then(result => {
      if (result?.usage) process.stdout.write(`${result.usage}\n`)
      else emit({ ok: true, ...result })
    }, error => {
      emit({ ok: false, error: { code: error.code ?? 'internal', message: error.message, ...(error.hint ? { hint: error.hint } : {}) } })
      process.exitCode = 1
    })
  }
}
