/**
 * Word timings from whisper.cpp — the only clock the inserts recipe uses.
 * `-ml 1 -sow` makes every segment one word, so a segment's offsets are the
 * word's start and end.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { findWhisperCli, findWhisperModel } from './doctor.mjs'
import { readProject, writeJson } from './project.mjs'
import { MotionError, round, runOk } from './tools.mjs'

/** Lowercase letters and digits only, ё as е: how words are matched. */
export function cleanWord(text) {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}-]+/gu, '').replace(/^-+|-+$/g, '')
}

/** Normalize whisper.cpp JSON (`-oj -ml 1 -sow`) into words with seconds. */
export function wordsFromWhisper(json) {
  const segments = Array.isArray(json?.transcription) ? json.transcription : []
  const words = []
  for (const segment of segments) {
    const text = String(segment.text ?? '').trim()
    if (!text || !cleanWord(text)) continue
    const start = Number(segment.offsets?.from) / 1000
    const end = Number(segment.offsets?.to) / 1000
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    words.push({ i: words.length, text, start: round(start), end: round(Math.max(end, start)) })
  }
  return words
}

export function transcriptText(words) {
  return words.map(word => word.text).join(' ')
}

/**
 * Find a word or phrase. `query` may be several words ("четыре раза");
 * `occurrence` is 1-based. Exact words win; only when the phrase is not
 * spoken as written does the last word match by its beginning, so "97"
 * finds "97-летию" but "сто" never lands on an earlier "стоимость".
 */
export function findWord(words, query, occurrence = 1) {
  const wanted = String(query).split(/\s+/).map(cleanWord).filter(Boolean)
  if (wanted.length === 0) return null
  return matchWords(words, wanted, occurrence, false) ?? matchWords(words, wanted, occurrence, true)
}

function matchWords(words, wanted, occurrence, prefix) {
  let seen = 0
  for (let i = 0; i + wanted.length <= words.length; i += 1) {
    const ok = wanted.every((token, k) => {
      const word = cleanWord(words[i + k].text)
      return prefix && k === wanted.length - 1 ? word.startsWith(token) : word === token
    })
    if (ok && (seen += 1) === occurrence) {
      const last = words[i + wanted.length - 1]
      return { index: i, text: words.slice(i, i + wanted.length).map(word => word.text).join(' '), start: words[i].start, end: last.end }
    }
  }
  return null
}

export async function transcribe(dir, { lang = 'ru', model } = {}) {
  const { paths, project } = await readProject(dir)
  const audio = path.join(paths.work, 'voice16k.wav')
  if (!(await stat(audio).catch(() => null))) {
    throw new MotionError('voice_missing', 'Нет звука для расшифровки.', 'Сначала `pc-motion ingest <видео> --project . --as footage` (у видео должна быть речь).')
  }
  const cli = await findWhisperCli()
  if (!cli) throw new MotionError('tool_missing', 'Не найден whisper-cli.', 'Запустите `pc-motion doctor --fix`.')
  const modelFile = model ?? await findWhisperModel()
  if (!modelFile) throw new MotionError('model_missing', 'Не найдена модель whisper.cpp.', 'Запустите `pc-motion doctor --fix`: он скачает large-v3-turbo.')
  const base = path.join(paths.work, 'whisper')
  await runOk(cli, ['-m', modelFile, '-l', lang, '-oj', '-ml', '1', '-sow', '-f', audio, '-of', base], { timeoutMs: 60 * 60_000 })
  const words = wordsFromWhisper(JSON.parse(await readFile(`${base}.json`, 'utf8')))
  const transcript = { lang, model: path.basename(modelFile), duration: project.footage?.duration ?? null, words, text: transcriptText(words) }
  await writeJson(paths.transcript, transcript)
  return { words: words.length, file: path.relative(paths.root, paths.transcript), text: transcript.text }
}
