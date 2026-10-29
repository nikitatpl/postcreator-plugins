/**
 * What a colleague's computer needs, and how to get it.
 *
 * HyperFrames and its headless Chrome download themselves into caches on
 * first use. Node, FFmpeg and whisper.cpp are system software: doctor only
 * names the exact commands, and runs them when called with --fix --yes,
 * which the agent does after the user agreed. Nothing is installed silently.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { firstJson, hyperframesArgs, npx, run, which } from './tools.mjs'

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
const MODEL_MIN_BYTES = 400 * 1024 * 1024
/** Best first: turbo is fast and good at Russian; smaller models are a fallback. */
const MODEL_PREFERENCE = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'large-v3', 'medium', 'small', 'base']

export function modelDirs() {
  const home = os.homedir()
  return [
    path.join(home, '.cache', 'whisper-cpp'),
    path.join(home, '.cache', 'whisper'),
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
    path.join(home, 'whisper.cpp', 'models'),
  ]
}

/** The whisper.cpp model to use: PC_MOTION_WHISPER_MODEL, else the best one found. */
export async function findWhisperModel() {
  if (process.env.PC_MOTION_WHISPER_MODEL) return process.env.PC_MOTION_WHISPER_MODEL
  const found = []
  for (const dir of modelDirs()) {
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = /^ggml-(.+)\.bin$/.exec(name)
      if (match) found.push({ file: path.join(dir, name), rank: MODEL_PREFERENCE.indexOf(match[1]) })
    }
  }
  const ranked = found.filter(model => model.rank >= 0).sort((a, b) => a.rank - b.rank)
  return (ranked[0] ?? found[0])?.file ?? null
}

export async function findWhisperCli() {
  return process.env.PC_MOTION_WHISPER ?? (await which('whisper-cli')) ?? (await which('whisper-cpp'))
}

async function version(file, args = ['-version']) {
  const result = await run(file, args, { timeoutMs: 20_000 }).catch(() => null)
  return result ? `${result.stdout}${result.stderr}`.split('\n').find(Boolean)?.trim() ?? '' : ''
}

/** Install steps per platform. auto=true steps doctor may run itself after consent. */
export function installPlan(platform, missing, hasBrew) {
  const plan = []
  const need = name => missing.has(name)
  if (platform === 'darwin') {
    if (!hasBrew && (need('node') || need('ffmpeg') || need('whisper-cli'))) {
      plan.push({ name: 'homebrew', auto: false, command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', why: 'Менеджер пакетов для остальных шагов; ставится вручную, он спросит пароль.' })
    }
    if (need('node')) plan.push({ name: 'node', auto: hasBrew, command: 'brew install node@22', why: 'HyperFrames и pc-motion работают на Node 22+.' })
    if (need('ffmpeg')) plan.push({ name: 'ffmpeg', auto: hasBrew, command: 'brew install ffmpeg', why: 'Нарезка, звук, прокси и проверка рендера.' })
    if (need('whisper-cli')) plan.push({ name: 'whisper-cli', auto: hasBrew, command: 'brew install whisper-cpp', why: 'Расшифровка речи с таймкодами слов.' })
  } else if (platform === 'win32') {
    if (need('node')) plan.push({ name: 'node', auto: false, command: 'winget install OpenJS.NodeJS.LTS', why: 'HyperFrames и pc-motion работают на Node 22+.' })
    if (need('ffmpeg')) plan.push({ name: 'ffmpeg', auto: false, command: 'winget install Gyan.FFmpeg', why: 'Нарезка, звук, прокси и проверка рендера.' })
    if (need('whisper-cli')) plan.push({ name: 'whisper-cli', auto: false, command: 'Скачайте whisper-bin-x64.zip со страницы https://github.com/ggml-org/whisper.cpp/releases и добавьте папку в PATH', why: 'Расшифровка речи с таймкодами слов.' })
  } else {
    if (need('node')) plan.push({ name: 'node', auto: false, command: 'Установите Node 22+ с https://nodejs.org или через nvm', why: 'HyperFrames и pc-motion работают на Node 22+.' })
    if (need('ffmpeg')) plan.push({ name: 'ffmpeg', auto: false, command: 'sudo apt-get install -y ffmpeg', why: 'Нарезка, звук, прокси и проверка рендера.' })
    if (need('whisper-cli')) plan.push({ name: 'whisper-cli', auto: false, command: 'Соберите whisper.cpp: https://github.com/ggml-org/whisper.cpp#quick-start', why: 'Расшифровка речи с таймкодами слов.' })
  }
  if (need('whisper-model')) {
    const target = path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-large-v3-turbo-q5_0.bin')
    plan.push({ name: 'whisper-model', auto: true, download: { url: MODEL_URL, file: target }, command: `curl -L --fail -o "${target}" ${MODEL_URL}`, why: 'Модель large-v3-turbo (около 0,6 ГБ), один раз.' })
  }
  if (need('chrome')) plan.push({ name: 'chrome', auto: true, command: `npx ${hyperframesArgs('browser', 'ensure').join(' ')}`, why: 'Headless Chrome для рендера HyperFrames, в кэш пользователя.' })
  return plan
}

/**
 * Check everything. With hyperframes=false the slow HyperFrames probe
 * (it may download the CLI) is skipped and reported as unchecked.
 */
export async function doctor({ hyperframes = true } = {}) {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node', ok: nodeMajor >= 22, required: true, detail: `Node ${process.versions.node}` })

  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = process.env[`PC_MOTION_${name.toUpperCase()}`] ?? (await which(name))
    checks.push({ name, ok: Boolean(file), required: true, detail: file ? `${await version(file)} (${file})` : 'не найден' })
  }

  const whisper = await findWhisperCli()
  checks.push({ name: 'whisper-cli', ok: Boolean(whisper), required: false, detail: whisper ?? 'не найден — нужен для расшифровки речи', recipes: ['inserts'] })
  const model = await findWhisperModel()
  let modelOk = false
  if (model) modelOk = (await stat(model).catch(() => null))?.isFile() === true
  checks.push({ name: 'whisper-model', ok: modelOk, required: false, detail: modelOk ? model : 'модель не найдена', recipes: ['inserts'] })

  if (hyperframes) {
    const result = await run(await npx(), hyperframesArgs('doctor', '--json'), { timeoutMs: 240_000 }).catch(error => ({ code: 1, stdout: '', stderr: String(error.message) }))
    const report = firstJson(result.stdout)
    const chrome = report?.checks?.find(check => check.name === 'Chrome')
    checks.push({ name: 'hyperframes', ok: Boolean(report), required: true, detail: report ? `HyperFrames ${report._meta?.version ?? ''}` : `не запустился: ${result.stderr.trim().split('\n').pop() ?? ''}` })
    checks.push({ name: 'chrome', ok: chrome?.ok === true, required: true, detail: chrome?.detail ?? 'не проверен' })
  } else {
    checks.push({ name: 'hyperframes', ok: true, required: true, detail: 'не проверялся (--skip-hyperframes); скачается при первом запуске', unchecked: true })
  }

  const missing = new Set(checks.filter(check => !check.ok).map(check => check.name))
  const hasBrew = process.platform === 'darwin' && Boolean(await which('brew'))
  const plan = installPlan(process.platform, missing, hasBrew)
  return {
    ok: checks.every(check => check.ok || !check.required),
    complete: checks.every(check => check.ok),
    platform: process.platform,
    checks,
    plan,
  }
}

/** Run the steps of a plan that can run unattended; the rest stay for the user. */
export async function applyPlan(plan, { log = text => process.stderr.write(text) } = {}) {
  const results = []
  for (const step of plan) {
    if (!step.auto) {
      results.push({ name: step.name, ran: false, reason: 'manual', command: step.command })
      continue
    }
    log(`→ ${step.command}\n`)
    let result
    if (step.download) {
      await mkdir(path.dirname(step.download.file), { recursive: true })
      result = await run((await which('curl')) ?? 'curl', ['-L', '--fail', '-o', step.download.file, step.download.url], { timeoutMs: 60 * 60_000, onStderr: log })
      const size = (await stat(step.download.file).catch(() => null))?.size ?? 0
      if (result.code === 0 && size < MODEL_MIN_BYTES) result = { ...result, code: 1, stderr: `файл модели слишком мал (${size} байт)` }
    } else if (step.name === 'chrome') {
      result = await run(await npx(), hyperframesArgs('browser', 'ensure'), { timeoutMs: 30 * 60_000, onStderr: log })
    } else {
      const [command, ...args] = step.command.split(' ')
      result = await run((await which(command)) ?? command, args, { timeoutMs: 60 * 60_000, onStderr: log })
    }
    results.push({ name: step.name, ran: true, ok: result.code === 0, ...(result.code === 0 ? {} : { error: result.stderr.trim().split('\n').slice(-3).join('\n') }) })
  }
  return results
}
