/**
 * External tools the kit drives: ffmpeg/ffprobe, whisper.cpp and the pinned
 * HyperFrames CLI. Every call goes through run(), which never uses a shell,
 * so file names with spaces or quotes are passed as they are.
 */
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** HyperFrames version every project is pinned to, so colleagues render the same frames. */
export const HYPERFRAMES_VERSION = '0.8.208'
export const GSAP_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js'

export class MotionError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'MotionError'
    this.code = code
    this.hint = hint
  }
}

/** Where tools usually live when an app was not started from a login shell. */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]

export async function which(name) {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_DIRS].filter(Boolean)
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of dirs) {
    for (const candidate of names) {
      const file = path.join(dir, candidate)
      try {
        await access(file, constants.X_OK)
        return file
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null
}

const OVERRIDES = { ffmpeg: 'PC_MOTION_FFMPEG', ffprobe: 'PC_MOTION_FFPROBE', 'whisper-cli': 'PC_MOTION_WHISPER' }

/** The executable for a tool: an explicit PC_MOTION_* override, else the first on PATH. */
export async function tool(name) {
  const override = OVERRIDES[name] && process.env[OVERRIDES[name]]
  if (override) return override
  const found = await which(name)
  if (!found) {
    throw new MotionError('tool_missing', `Не найден ${name}.`, 'Запустите `pc-motion doctor`: он покажет, как установить недостающее.')
  }
  return found
}

/**
 * Run a program and collect its output. Resolves with the exit code; a
 * program that cannot start rejects with tool_missing.
 */
export function run(command, args, { cwd, input, timeoutMs = 30 * 60_000, env, onStderr, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new MotionError('tool_missing', `Не удалось запустить ${command}: ${error.message}`))
      return
    }
    const out = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      err = (err + text).slice(-64_000)
      onStderr?.(text)
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT'
        ? new MotionError('tool_missing', `Не найден ${command}.`, 'Запустите `pc-motion doctor`.')
        : error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      resolve({ code: signal ? 124 : code, stdout: binary ? stdout : stdout.toString(), stderr: err })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** run() that throws tool_failed with the end of stderr when the exit code is not 0. */
export async function runOk(command, args, options) {
  const result = await run(command, args, options)
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-6).join('\n')
    throw new MotionError('tool_failed', `${path.basename(command)} завершился с кодом ${result.code}: ${tail}`)
  }
  return result
}

export async function ffmpeg(args, options) {
  return runOk(await tool('ffmpeg'), ['-hide_banner', '-nostdin', '-y', ...args], options)
}

function rate(value) {
  const [num, den] = String(value ?? '').split('/').map(Number)
  return den ? num / den : Number.isFinite(num) ? num : 0
}

/** Duration, frame size, frame rate and streams of a media file. */
export async function probe(file) {
  const { stdout } = await runOk(await tool('ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration',
    '-of', 'json', file,
  ])
  const data = JSON.parse(stdout)
  const video = data.streams?.find(stream => stream.codec_type === 'video')
  const audio = data.streams?.find(stream => stream.codec_type === 'audio')
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: Math.round((rate(video?.avg_frame_rate) || rate(video?.r_frame_rate)) * 1000) / 1000,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  }
}

/** The pinned HyperFrames CLI through npx; the first call downloads it into the npm cache. */
export function hyperframesArgs(...args) {
  return ['--yes', `hyperframes@${HYPERFRAMES_VERSION}`, ...args]
}

export async function npx() {
  return (await which('npx')) ?? 'npx'
}

/** The first JSON object in a tool's output, ignoring banners printed around it. */
export function firstJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
