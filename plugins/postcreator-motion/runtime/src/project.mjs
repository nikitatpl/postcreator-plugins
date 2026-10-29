/**
 * A motion project is a plain folder, and the folder is the contract: any
 * colleague, agent or later run picks up from what is on disk.
 *
 *   project.json        format, recipe, ingested media
 *   index.html          the HyperFrames composition (written by build)
 *   compositions/       one file per insert scene
 *   assets/             footage, voice, clips, music, sfx — what the render uses
 *   work/               transcripts, analyses, contact sheets — never rendered
 *   inserts.json        the insert plan (inserts recipe)
 *   edit-dna.json       the reference breakdown (remix recipe)
 *   remix.json          slots filled with clips (remix recipe)
 *   ledger.json         paid Postcreator steps and the spending cap
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { writeSfxPack } from './sfx.mjs'
import { GSAP_URL, HYPERFRAMES_VERSION, MotionError } from './tools.mjs'

export const FORMATS = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
}
export const RECIPES = ['inserts', 'remix']

export function projectPaths(dir) {
  const root = path.resolve(dir)
  return {
    root,
    project: path.join(root, 'project.json'),
    index: path.join(root, 'index.html'),
    compositions: path.join(root, 'compositions'),
    assets: path.join(root, 'assets'),
    sfx: path.join(root, 'assets', 'sfx'),
    clips: path.join(root, 'assets', 'clips'),
    work: path.join(root, 'work'),
    reference: path.join(root, 'work', 'reference'),
    review: path.join(root, 'work', 'review'),
    inserts: path.join(root, 'inserts.json'),
    dna: path.join(root, 'edit-dna.json'),
    remix: path.join(root, 'remix.json'),
    ledger: path.join(root, 'ledger.json'),
    transcript: path.join(root, 'work', 'transcript.json'),
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    if (error.code === 'ENOENT') throw new MotionError('file_missing', `Нет файла ${file}.`)
    throw new MotionError('json_invalid', `${file}: ${error.message}`)
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readProject(dir) {
  const paths = projectPaths(dir)
  const project = await readJson(paths.project).catch(error => {
    if (error.code === 'file_missing') throw new MotionError('project_missing', `${paths.root} — не проект pc-motion.`, 'Создайте его: `pc-motion init <папка> --recipe inserts|remix`.')
    throw error
  })
  return { paths, project }
}

export async function saveProject(paths, project) {
  await writeJson(paths.project, { ...project, updatedAt: new Date().toISOString() })
}

const SYSTEM = {
  inserts: `# Перебивки к говорящей голове

Исходник не перемонтируется: картинка и звук идут как есть, а поверх по таймкодам речи
встают анимированные перебивки (2,5–7 с) — на весь кадр или 3D-карточкой в кадре. Речь не прерывается: человек
продолжает говорить, а анимация показывает сказанное — не пересказывает его текстом.

1. \`pc-motion ingest <видео> --project . --as footage\` и \`pc-motion transcribe --project .\`.
2. \`pc-motion look --project .\`: вшитые субтитры, плашки, лица, свободное место. Субтитры —
   только если их нет в исходнике (\`"captions"\`: pop, karaoke, stack, minimal, spatial).
3. Карта перебивок в \`inserts.json\`: каждая сцена рисуется под этот ролик (\`"template": "custom"\`,
   \`pc-motion inserts scaffold\` даёт заготовки) — на весь кадр или 3D-карточкой (\`"card"\`).
   Между полноэкранными перебивками говорящий виден не меньше 3 с. Время задаётся словами
   речи (\`"at": {"word": "…"}\`): ключевое слово = момент «приземления» главного движения.
4. \`pc-motion inserts build --project .\` пишет \`compositions/\` и \`index.html\`; \`pc-motion snapshot --project . --only <id>\` — кадры одной сцены.
5. \`pc-motion render --project . --quality draft\`, \`pc-motion review --project .\`, правки, финальный рендер.
`,
  remix: `# Монтаж по референсу

Повторяем ритм, монтажные приёмы и движение референса на своём материале. Футаж и музыку
референса не используем — только их структуру.

1. \`pc-motion ingest <референс> --project . --as reference\`, \`pc-motion analyze-reference --project .\`.
2. Посмотреть \`work/reference/contact.jpg\` и дописать в \`edit-dna.json\` описание каждого кадра и стиль.
3. Свой материал: \`pc-motion ingest <клип> --project . --as clip\`; недостающие кадры — генерация в
   Postcreator (Seedance) и \`pc-motion fetch\`; каждый платный шаг — в \`ledger.json\`.
4. Музыка: \`pc-motion ingest <трек> --project . --as music\`.
5. \`pc-motion remix plan --project .\`, проверить \`remix.json\`, \`pc-motion remix build --project .\`.
6. \`pc-motion render --project . --quality draft\`, \`pc-motion review --project . --against reference\`.
`,
}

/** Create a project folder from scratch; refuses a folder that already has files. */
export async function initProject(dir, { recipe, format = 'portrait', fps = 30, title } = {}) {
  if (!RECIPES.includes(recipe)) throw new MotionError('recipe_invalid', `Рецепт должен быть одним из: ${RECIPES.join(', ')}.`)
  const frame = FORMATS[format]
  if (!frame) throw new MotionError('format_invalid', `Формат должен быть одним из: ${Object.keys(FORMATS).join(', ')}.`)
  const paths = projectPaths(dir)
  const existing = await readdir(paths.root).catch(() => [])
  if (existing.length > 0) throw new MotionError('project_exists', `${paths.root} не пустая.`, 'Укажите новую папку: проект не перезаписывает чужие файлы.')
  for (const folder of [paths.compositions, paths.assets, paths.clips, paths.work]) await mkdir(folder, { recursive: true })
  const project = {
    version: 1,
    recipe,
    title: title ?? path.basename(paths.root),
    format,
    width: frame.width,
    height: frame.height,
    fps,
    hyperframes: HYPERFRAMES_VERSION,
    style: { ground: '#05060a', ink: '#f4f4f0', accent: '#8ce874', brand: '' },
    footage: null,
    clips: [],
    music: null,
    reference: null,
    createdAt: new Date().toISOString(),
  }
  await saveProject(paths, project)
  await writeJson(paths.ledger, { capRub: null, entries: [] })
  await writeJson(path.join(paths.root, 'package.json'), {
    name: project.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'motion-project',
    private: true,
    type: 'module',
    scripts: Object.fromEntries(['preview', 'check', 'render'].map(name => [name, `npx --yes hyperframes@${HYPERFRAMES_VERSION} ${name}`])),
  })
  await writeJson(path.join(paths.root, 'hyperframes.json'), {
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
    media: { autoProxy: true },
    authoringSkill: 'hyperframes',
  })
  await writeFile(path.join(paths.root, 'SYSTEM.md'), SYSTEM[recipe])
  await writeFile(path.join(paths.root, '.gitignore'), 'work/\nrenders/\n.hyperframes/\nnode_modules/\n')
  const sfx = await writeSfxPack(paths.sfx)
  await writeFile(paths.index, placeholderIndex(project))
  return { paths, project, sfx }
}

/** A valid empty composition so preview works before the first build. */
export function placeholderIndex(project) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${project.width}, height=${project.height}" />
    <script src="${GSAP_URL}"></script>
    <style>html, body { margin: 0; width: ${project.width}px; height: ${project.height}px; overflow: hidden; background: ${project.style.ground}; }</style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="${project.width}" data-height="${project.height}"></div>
    <script>window.__timelines["main"] = gsap.timeline({ paused: true });</script>
  </body>
</html>
`
}
