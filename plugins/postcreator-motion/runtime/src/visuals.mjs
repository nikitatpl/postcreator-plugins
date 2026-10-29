/**
 * Visual insert templates: the scene shows what is being said — a dome over
 * the viewer, planets on their orbits, an actor in a mocap suit, a crowd with
 * one dancer — and text only labels it. An insert explains with a picture;
 * the text templates are for the rare thought there is nothing to draw for.
 *
 * Every visual draws itself from one clock: a GSAP tween over the whole
 * insert calls draw(t), so a frame depends only on its time and renders the
 * same on every machine. Shapes are SVG built by the script; seeded noise
 * (mulberry32) stands in for Math.random.
 */
import { escapeHtml, fit, js, UPPER } from './markup.mjs'
import { MotionError } from './tools.mjs'

export const VISUALS = {
  stage: {
    summary: 'Сцена: занавес раскрывается, прожекторы сходятся на том, что открывают на land. Премьера, постановка, анонс.',
    data: { kicker: 'строка сверху', title: 'заголовок до 4 слов', reveal: 'что открывается на сцене, до 4 слов', note: 'строка под ним' },
    sound: { land: 'chime' },
  },
  orbit: {
    summary: 'Система вокруг центра: орбиты рисуются, планета-пункт загорается на своём слове (marks). Цикл, экосистема, «вокруг чего всё вращается».',
    data: { kicker: 'строка сверху', title: 'заголовок', center: 'подпись центра', items: '2–4 пункта', notes: 'подписи к пунктам' },
    sound: { ticks: true },
  },
  space: {
    summary: '3D-площадка: сетка пола и оси, человек идёт к точке и фиксируется на land, координаты бегут. Координаты, позиционирование, трекинг.',
    data: { kicker: 'строка сверху', title: 'заголовок', point: '[x, z] — куда приходит, в клетках сетки (до ±4)', unit: 'единица координат, по умолчанию «м»', label: 'подпись фиксации' },
    sound: { land: 'boom' },
  },
  body: {
    summary: 'Тело в мокап-костюме: маркеры → кости и движение → камеры-датчики, этап на каждом слове (marks). Захват движения, технология, работа тела.',
    data: { kicker: 'строка сверху', title: 'заголовок', steps: '2–4 этапа-чипа, по умолчанию костюм/движения/датчики', sensors: 'false — без камер' },
    sound: { ticks: true },
  },
  map: {
    summary: 'Карта города: кольца и улицы рисуются, камера наезжает, пин падает на land. Место, адрес, «снимаем в …».',
    data: { kicker: 'строка сверху', title: 'заголовок', place: 'название места (обязательно)', note: 'строка под ним', city: 'подпись карты' },
    sound: { land: 'boom' },
  },
  dome: {
    summary: 'Купол над зрителем: сетка купола и звёзды, угол обзора раскрывается к land. Погружение, 360°, «весь обзор»; sweep — взгляд обходит купол.',
    data: { kicker: 'строка сверху', title: 'заголовок', from: 'начальный угол, по умолчанию 60', to: 'конечный угол, по умолчанию 180', unit: 'по умолчанию «°»', label: 'подпись под углом', fov: 'false — без угла обзора', sweep: 'true — после land взгляд обходит купол' },
    sound: { land: 'chime' },
  },
  effort: {
    summary: 'Долго против одного дубля: ручные ключи копятся по одному, быстрый способ пишет кривую сразу; чипы нехватки зачёркиваются на marks.',
    data: { kicker: 'строка сверху', title: 'заголовок', slow: '{label, note} медленного способа', fast: '{label, note} быстрого', missing: '1–3 чипа: без чего обходится быстрый способ' },
    sound: { ticks: true },
  },
  people: {
    summary: 'Люди разного возраста встают в ряд под куполом (marks) и вместе загораются на land. Аудитория, «для всех», возрасты.',
    data: { kicker: 'строка сверху', title: 'заголовок', groups: '2–5 подписей, от младших к старшим', total: 'итог под рядом' },
    sound: { land: 'chime', ticks: true },
  },
  dots: {
    summary: 'Много точек гаснут, остаются единицы; выделенные загораются с подписями и связью (marks: «единицы», потом по пункту). Редкость, «один из многих», партнёрство.',
    data: { kicker: 'строка сверху', title: 'заголовок', total: 'сколько точек, 12–80 (по умолчанию 40)', label: 'что это за точки', items: '1–3 выделенных: строки или {label, note}' },
    sound: { ticks: true },
  },
  cast: {
    summary: 'Три персонажа становятся разными на своих словах (marks): характер (лица), размер, поведение (движение). Персонажи, роли, типажи.',
    data: { kicker: 'строка сверху', title: 'заголовок', traits: 'три чипа, по умолчанию характер/размер/поведение' },
    sound: { ticks: true },
  },
  crowd: {
    summary: 'Толпа в глубину; лупа ищет и на land находит одного — он танцует. Массовка, «найдите», пасхалка, деталь в общем плане.',
    data: { kicker: 'строка сверху', title: 'заголовок', label: 'метка найденного', note: 'строка под ней' },
    sound: { land: 'chime' },
  },
}

const DEFAULT_COLORS = { accent: '#8ce874', ink: '#f4f4f0', ground: '#05060a' }

function hex6(color, fallback) {
  const value = String(color ?? '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(value)) return value
  if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map(char => char + char).join('')}`
  return fallback
}

function mixHex(a, b, m) {
  const parse = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
  const x = parse(a)
  const y = parse(b)
  return `#${x.map((value, i) => Math.round(value + (y[i] - value) * m).toString(16).padStart(2, '0')).join('')}`
}

const round3 = value => Math.round(value * 1000) / 1000

function list(value, min, max, message) {
  const items = Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : []
  if (items.length < min || items.length > max) throw new MotionError('insert_invalid', message)
  return items
}

/** One time per step: the plan's marks, or steps spread over the insert. */
function beats(marks, count, from, duration) {
  if (marks.length >= count) return marks.slice(0, count)
  const to = Math.max(from, Math.min(duration - 0.6, Math.max(from + 0.3 * (count - 1), duration - 1.2)))
  return Array.from({ length: count }, (_, i) => round3(count === 1 ? from : from + ((to - from) * i) / (count - 1)))
}

/** Where the picture goes: below the caption, inside the band social apps leave free. */
function boxOf(f) {
  const x0 = f.pad
  const x1 = f.W - f.pad
  const y0 = f.top + Math.round((f.portrait ? 300 : 230) * f.u)
  const y1 = f.bottom - Math.round(30 * f.u)
  // y1 is where text must stop; a picture may go on down to y2, under the social apps' buttons.
  const y2 = Math.max(y1, Math.round(f.H * (f.portrait ? 0.86 : 0.94)))
  return { x0, x1, y0, y1, y2, w: x1 - x0, h: y1 - y0, cx: Math.round((x0 + x1) / 2), cy: Math.round((y0 + y1) / 2), S: Math.min(x1 - x0, y1 - y0) }
}

function caption(id, data, f) {
  const title = String(data.title ?? '').trim()
  const kicker = String(data.kicker ?? '').trim()
  const highlight = String(data.highlight ?? '').trim().toLowerCase()
  const size = fit(title, 64 * f.u, f.W - 2 * f.pad, 2, 0.45, UPPER)
  const words = title ? title.split(/\s+/) : []
  return {
    css: `
        #${id} .vz-cap { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top + Math.round(64 * f.u)}px; text-align: center; }
        #${id} .vz-kicker { font-family: "JetBrains Mono", monospace; font-size: ${Math.round(24 * f.u)}px; letter-spacing: 0.26em; text-transform: uppercase; color: ${f.accent}; margin-bottom: ${Math.round(18 * f.u)}px; }
        #${id} .vz-title { font-size: ${size}px; font-weight: 800; text-transform: uppercase; line-height: 1.04; }
        #${id} .vz-word { display: inline-block; overflow: hidden; vertical-align: top; padding: 0.04em 0.06em 0.1em; }
        #${id} .vz-word > span { display: inline-block; }`,
    body: kicker || words.length ? `<div class="vz-cap">${kicker ? `<div class="vz-kicker">${escapeHtml(kicker)}</div>` : ''}${words.length ? `<div class="vz-title">${words.map(word => `<span class="vz-word"><span${highlight && word.toLowerCase().startsWith(highlight) ? ' class="accent"' : ''}>${escapeHtml(word)}</span></span>`).join(' ')}</div>` : ''}</div>` : '',
    script: `
      ${kicker ? `tl.fromTo("#${id} .vz-kicker", { opacity: 0, y: ${12 * f.u} }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.22);` : ''}
      ${words.length ? `tl.fromTo("#${id} .vz-word > span", { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: "expo.out", stagger: 0.06 }, 0.3);` : ''}`,
  }
}

function chips(id, items, top) {
  return `<div class="vz-chips" style="top:${top}px">${items.map((item, i) => `<span class="vz-chip" id="${id}-chip${i}">${escapeHtml(item)}<i class="vz-x" id="${id}-x${i}"></i></span>`).join('')}</div>`
}

// Client helpers every visual starts with. `tl` and `DUR` come from the scene shell.
const runtime = ({ id, seed, colors, box, f, land, marks, data }) => `
      const NS = "http://www.w3.org/2000/svg";
      const ROOT = document.getElementById(${js(id)});
      const $ = selector => ROOT.querySelector(selector);
      const $$ = selector => Array.from(ROOT.querySelectorAll(selector));
      const uid = name => ${js(id)} + "-" + name;
      const mk = (tag, attrs, parent) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); parent.appendChild(el); return el; };
      const put = (el, attrs) => { for (const k in attrs) el.setAttribute(k, attrs[k]); };
      let seed = ${seed};
      const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
      const clamp = v => Math.max(0, Math.min(1, v));
      const lerp = (a, b, m) => a + (b - a) * m;
      const ramp = (t, at, length) => clamp((t - at) / length);
      const inOut = gsap.parseEase("power2.inOut"), out = gsap.parseEase("expo.out"), pop = gsap.parseEase("back.out(2.2)");
      // Colours as #rrggbb, #rgb or rgb()/rgba(), so mix(mix(a, b, m), c, k) works.
      const rgb = c => { c = String(c); if (c[0] === "#") { const h = c.length === 4 ? c.slice(1).split("").map(x => x + x).join("") : c.slice(1, 7); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); } return (c.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number); };
      const mix = (a, b, m) => { const x = rgb(a), y = rgb(b); return "rgb(" + x.map((v, i) => Math.round(lerp(v, y[i], clamp(m)))).join(",") + ")"; };
      const alpha = (c, a) => "rgba(" + rgb(c).join(",") + "," + a + ")";
      const pts = list => list.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
      const clock = draw => { const c = { t: 0 }; draw(0); tl.fromTo(c, { t: 0 }, { t: DUR, duration: DUR, ease: "none", onUpdate: () => draw(c.t) }, 0); };
      const svg = $(".vz-svg");
      const AC = ${js(colors.accent)}, INK = ${js(colors.ink)}, GR = ${js(colors.ground)};
      const B = ${js(box)}, U = ${f.u}, FW = ${f.W}, FH = ${f.H}, PAD = ${f.pad}, LAND = ${land}, MARKS = ${js(marks)}, DATA = ${js(data)};
      const chipOn = (i, t) => tl.to("#${id}-chip" + i, { backgroundColor: AC, color: GR, borderColor: AC, duration: 0.25 }, t);
      const chipOff = (i, t) => tl.to("#${id}-chip" + i, { backgroundColor: alpha(GR, 0), color: INK, borderColor: alpha(INK, 0.3), duration: 0.25 }, t);`

// A figure as joints in units of its height: feet at the origin, up is negative.
const RIG = `
      const STAND = { head: [0, -0.92], neck: [0, -0.77], pelvis: [0, -0.47], lSh: [-0.12, -0.75], rSh: [0.12, -0.75], lEl: [-0.16, -0.59], rEl: [0.16, -0.59], lHa: [-0.18, -0.44], rHa: [0.18, -0.44], lHi: [-0.075, -0.47], rHi: [0.075, -0.47], lKn: [-0.085, -0.23], rKn: [0.085, -0.23], lFo: [-0.095, 0], rFo: [0.095, 0] };
      const JOINTS = Object.keys(STAND);
      const BONES = [["neck", "pelvis"], ["lSh", "rSh"], ["lSh", "lEl"], ["lEl", "lHa"], ["rSh", "rEl"], ["rEl", "rHa"], ["lHi", "rHi"], ["lHi", "lKn"], ["lKn", "lFo"], ["rHi", "rKn"], ["rKn", "rFo"]];
      const ARMS = ["head", "neck", "lSh", "rSh", "lEl", "rEl", "lHa", "rHa"];
      const BODY = JOINTS.filter(j => j !== "lFo" && j !== "rFo");
      function pose(kind, t, k) {
        k = k || 0;
        const P = {};
        for (const j of JOINTS) P[j] = [STAND[j][0], STAND[j][1]];
        const move = (names, dx, dy) => names.forEach(j => { P[j][0] += dx; P[j][1] += dy; });
        if (kind === "walk") {
          const s = Math.sin(t * 6 + k), c = Math.cos(t * 6 + k);
          move(["lKn"], 0.02 * s, -0.05 * Math.max(0, s)); move(["lFo"], 0.05 * s, -0.07 * Math.max(0, s));
          move(["rKn"], -0.02 * s, -0.05 * Math.max(0, -s)); move(["rFo"], -0.05 * s, -0.07 * Math.max(0, -s));
          move(["lEl"], -0.03 * s, 0); move(["lHa"], -0.07 * s, -0.02 * Math.abs(s));
          move(["rEl"], 0.03 * s, 0); move(["rHa"], 0.07 * s, -0.02 * Math.abs(s));
          move(BODY, 0, -0.015 * Math.abs(c));
        } else if (kind === "dance") {
          const p = t * 4.4 + k, s = Math.sin(p), up = Math.max(0, s), down = Math.max(0, -s);
          P.rEl = [0.17 + 0.06 * up, -0.59 - 0.25 * up]; P.rHa = [0.18 + 0.03 * up, -0.44 - 0.58 * up];
          P.lEl = [-0.17 - 0.06 * down, -0.59 - 0.25 * down]; P.lHa = [-0.18 - 0.03 * down, -0.44 - 0.58 * down];
          move(ARMS.concat(["pelvis", "lHi", "rHi"]), 0.035 * s, 0);
          move(BODY, 0, 0.028 * Math.abs(Math.sin(p * 2)));
          move(["lKn"], -0.02 * up, 0); move(["rKn"], 0.02 * down, 0);
        } else if (kind === "jump") {
          const air = Math.max(0, Math.sin(t * 3.6 + k));
          P.lEl = [-0.2, -0.6 - 0.2 * air]; P.rEl = [0.2, -0.6 - 0.2 * air]; P.lHa = [-0.24, -0.45 - 0.5 * air]; P.rHa = [0.24, -0.45 - 0.5 * air];
          move(["lKn"], -0.03 * air, 0); move(["rKn"], 0.03 * air, 0);
          move(JOINTS, 0, -0.17 * air * air);
        } else if (kind === "wave") {
          P.rEl = [0.22, -0.8]; P.rHa = [0.25 + 0.06 * Math.sin(t * 8 + k), -1.0];
          move(ARMS, 0.01 * Math.sin(t * 1.7 + k), 0);
        } else if (kind === "lean") {
          move(["head"], 0.05, 0.035); move(["neck", "lSh", "rSh"], 0.03, 0.02);
          P.rHa = [0.22, -0.3]; P.rEl = [0.19, -0.55];
          move(ARMS, 0.008 * Math.sin(t * 1.4 + k), 0);
        } else {
          const s = Math.sin(t * 1.7 + k);
          move(ARMS, 0.014 * s, 0); move(["lHa", "rHa"], 0, 0.01 * s);
        }
        return P;
      }
      const mixPose = (A, Z, m) => { const P = {}; for (const j of JOINTS) P[j] = [lerp(A[j][0], Z[j][0], m), lerp(A[j][1], Z[j][1], m)]; return P; };
      function figure(parent, opts) {
        const g = mk("g", { "stroke-linecap": "round" }, parent);
        const frame = mk("g", {}, g), marks = mk("g", {}, g);
        const bones = BONES.map(() => mk("line", {}, frame));
        const head = mk("circle", {}, frame);
        const dots = opts && opts.joints ? JOINTS.map(() => mk("circle", {}, marks)) : [];
        return { g, dots, draw(P, x, y, h, color, o) {
          o = o || {};
          const w = (o.width ?? 0.075) * h, shown = o.bones ?? 1, hr = o.head ?? 0.085;
          // Bones and head fade as one shape (per-stroke opacity would show every joint); the markers on their own.
          put(frame, { opacity: shown }); put(marks, { opacity: o.dots ?? 1 });
          BONES.forEach((bone, i) => put(bones[i], { x1: x + P[bone[0]][0] * h, y1: y + P[bone[0]][1] * h, x2: x + P[bone[1]][0] * h, y2: y + P[bone[1]][1] * h, stroke: color, "stroke-width": i === 0 ? w * 1.6 : w }));
          // A bigger head grows upwards, so it never sinks into the shoulders.
          const hx = x + P.head[0] * h, hy = y + (P.head[1] - Math.max(0, hr - 0.085)) * h;
          put(head, { cx: hx, cy: hy, r: hr * h, fill: o.hollow ? "none" : color, stroke: color, "stroke-width": o.hollow ? w : 0 });
          dots.forEach((dot, i) => put(dot, { cx: x + P[JOINTS[i]][0] * h, cy: y + P[JOINTS[i]][1] * h, r: (o.dot ?? 0.018) * h, fill: o.dotColor ?? color }));
          return [hx, hy, hr * h];
        } };
      }`

function visual({ id, data, land, marks = [], f }, { seed, css = '', body = '', script, rig = false }) {
  const cap = caption(id, data, f)
  const colors = { accent: hex6(f.accent, DEFAULT_COLORS.accent), ink: hex6(f.ink, DEFAULT_COLORS.ink), ground: hex6(f.ground, DEFAULT_COLORS.ground) }
  const box = boxOf(f)
  const u = value => Math.round(value * f.u)
  return {
    css: () => `
        #${id} .vz-svg { position: absolute; left: 0; top: 0; width: ${f.W}px; height: ${f.H}px; overflow: visible; }
        #${id} .vz-label { position: absolute; font-family: "JetBrains Mono", monospace; font-size: ${u(22)}px; letter-spacing: 0.2em; text-transform: uppercase; color: color-mix(in srgb, currentColor 75%, transparent); white-space: nowrap; }
        #${id} .vz-chips { position: absolute; left: ${f.pad}px; right: ${f.pad}px; display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: ${u(14)}px; }
        #${id} .vz-chip { position: relative; font-family: "JetBrains Mono", monospace; font-size: ${u(22)}px; letter-spacing: 0.14em; text-transform: uppercase; padding: ${u(14)}px ${u(22)}px; border-radius: 999px; border: ${Math.max(1, u(2))}px solid color-mix(in srgb, ${f.ink} 30%, transparent); color: ${f.ink}; white-space: nowrap; }
        #${id} .vz-x { position: absolute; left: 10%; right: 10%; top: 50%; height: ${Math.max(2, u(3))}px; background: ${f.accent}; transform: scaleX(0); transform-origin: 0 50%; }${cap.css}${css}`,
    body: () => `<svg class="vz-svg" data-layout-ignore viewBox="0 0 ${f.W} ${f.H}" fill="none"></svg>${cap.body}${body}`,
    script: () => `${runtime({ id, seed, colors, box, f, land, marks, data })}${rig ? RIG : ''}${cap.script}${body.includes('class="vz-chips"') ? `
      tl.fromTo("#${id} .vz-chips", { opacity: 0, y: ${u(20)} }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.3);` : ''}${script}`,
  }
}

const FONTS = /^\s*(inherit|["']?(Inter|JetBrains Mono)["']?\s*(,\s*(sans-serif|monospace))?)\s*$/i
const NONDETERMINISTIC = [
  [/Math\.random/, 'Math.random — бери rand(), он от зерна'],
  [/Date\.now|new Date\b|performance\.now/, 'часы компьютера — бери время t из clock()'],
  [/requestAnimationFrame|setTimeout|setInterval/, 'таймеры — всё движение только через tl и clock()'],
]

const seedOf = id => [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)

/** Prefix every rule of a scene's own stylesheet with its insert id: scenes share one document. */
function scopeCss(id, file, css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  if (/@(media|keyframes|supports|container|layer|import)\b/i.test(clean)) throw new MotionError('scene_invalid', `${file}: в стилях сцены только простые правила — без @media, @keyframes и @import; движение задаёт GSAP.`)
  const rules = []
  const rest = clean.replace(/([^{}]+)\{([^{}]*)\}/g, (_, selectors, body) => {
    const list = selectors.trim()
    rules.push(list.startsWith('@') ? `${list} {${body}}` : `${list.split(',').map(selector => `#${id} ${selector.trim()}`).join(', ')} {${body}}`)
    return ''
  })
  if (rest.trim()) throw new MotionError('scene_invalid', `${file}: не разобрал стили около «${rest.trim().slice(0, 40)}».`)
  return rules.map(rule => `\n        ${rule}`).join('')
}

/**
 * A scene the agent drew for this video: its own style, markup and script.
 * The build adds what every insert shares — the iris, HUD and caption, the
 * word timings and the drawing helpers — and refuses what would render
 * differently twice or leak into other scenes.
 */
export function sceneFragment(scene, source, file) {
  const fail = message => { throw new MotionError('scene_invalid', `${file}: ${message}`) }
  const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n')
  const scripts = [...source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  if (scripts.some(match => /\bsrc\s*=/.test(match[1]))) fail('внешние скрипты нельзя: GSAP уже подключён.')
  const code = scripts.map(match => match[2]).join('\n')
  if (!code.trim()) fail('нет <script>: сцена рисуется в нём — clock(t => …) и tl.')
  const body = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').trim()
  for (const [pattern, hint] of NONDETERMINISTIC) if (pattern.test(code)) fail(`рендер будет разным от раза к разу: ${hint}.`)
  if (/window\.__timelines/.test(code)) fail('таймлайн регистрирует сборка — добавляй анимацию в tl.')
  if (/document\s*\.\s*(querySelector|getElementById|getElementsBy)/.test(code)) fail('ищи элементы через $() и $$(): все сцены живут в одном документе.')
  if (/\sid\s*=/.test(body)) fail('id в разметке сталкиваются с другими сценами — бери классы и $(); для градиентов в скрипте есть uid("имя").')
  if (/(src|href)\s*=\s*["']?\s*(https?:|\/\/)|url\(\s*["']?\s*(https?:|\/\/)/i.test(source)) fail('внешние файлы нельзя: положи картинку в assets/ и сошлись на неё относительно.')
  for (const match of styles.matchAll(/font-family\s*:\s*([^;}]+)/gi)) if (!FONTS.test(match[1])) fail(`шрифт ${match[1].trim()}: HyperFrames сам подключает только "Inter" и "JetBrains Mono".`)
  try {
    // eslint-disable-next-line no-new-func -- parse only: a syntax error should stop the build, not the render
    new Function(code)
  } catch (error) {
    fail(`ошибка в скрипте: ${error.message}.`)
  }
  return visual(scene, { seed: seedOf(scene.id), css: scopeCss(scene.id, file, styles), body, script: `\n      {\n${code}\n      }`, rig: true })
}

export const VISUAL_BUILDERS = {
  stage(scene) {
    const { id, data, f } = scene
    const B = boxOf(f)
    const reveal = String(data.reveal ?? '').trim()
    const note = String(data.note ?? '').trim()
    const floor = Math.round(B.y1 - 0.16 * B.h)
    const size = fit(reveal, 72 * f.u, B.w * 0.82, 2, 0.45, UPPER)
    return visual(scene, {
      seed: 11,
      css: `
        #${id} .vz-reveal { position: absolute; left: ${B.x0}px; right: ${f.W - B.x1}px; top: ${Math.round(floor - 0.36 * B.h)}px; text-align: center; font-size: ${size}px; font-weight: 800; text-transform: uppercase; line-height: 1.02; color: ${f.accent}; opacity: 0; }
        #${id} .vz-reveal small { display: block; margin-top: ${Math.round(18 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(22 * f.u)}px; letter-spacing: 0.22em; font-weight: 400; color: ${f.ink}; }`,
      body: reveal || note ? `<div class="vz-reveal">${escapeHtml(reveal)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>` : '',
      script: `
      const L = B.x0 + 0.02 * B.w, R = B.x1 - 0.02 * B.w, T = B.y0 + 0.02 * B.h, F = ${floor};
      const clip = mk("clipPath", { id: ${js(`${id}-arch`)} }, mk("defs", {}, svg));
      mk("rect", { x: L, y: T, width: R - L, height: F - T, rx: 0.16 * (R - L) }, clip);
      const inside = mk("g", { "clip-path": "url(#${id}-arch)" }, svg);
      const STARS = Array.from({ length: 90 }, () => ({ x: lerp(L, R, rand()), y: lerp(T, F - 40 * U, rand()), r: (0.6 + rand() * 1.8) * U, k: rand() * 6 }));
      const stars = STARS.map(s => mk("circle", { cx: s.x, cy: s.y, r: s.r, fill: INK }, inside));
      const OX = B.cx, OY = T + 0.3 * (F - T), ORX = 0.3 * B.w, ORY = 0.075 * B.w;
      mk("ellipse", { cx: OX, cy: OY, rx: ORX, ry: ORY, stroke: AC, "stroke-opacity": 0.35, "stroke-width": 2 * U }, inside);
      mk("circle", { cx: OX, cy: OY, r: 0.03 * B.w, fill: AC }, inside);
      const planet = mk("circle", { r: 0.012 * B.w, fill: INK }, inside);
      const beams = [0, 1].map(() => mk("polygon", { fill: AC }, inside));
      const pools = [0, 1].map(() => mk("ellipse", { fill: AC }, inside));
      mk("line", { x1: L, y1: F, x2: R, y2: F, stroke: AC, "stroke-opacity": 0.5, "stroke-width": 3 * U }, inside);
      const curtains = [0, 1].map(() => { const g = mk("g", {}, inside); return { rect: mk("rect", { y: T, height: F - T, fill: mix(GR, AC, 0.08) }, g), edge: mk("line", { y1: T, y2: F, stroke: AC, "stroke-opacity": 0.6, "stroke-width": 2 * U }, g), folds: Array.from({ length: 6 }, () => mk("path", { stroke: AC, "stroke-opacity": 0.22, "stroke-width": 2 * U }, g)) }; });
      let valance = "M" + L + " " + T + " H" + R + " V" + (T + 0.05 * B.h);
      for (let i = 0; i < 9; i += 1) { const a = R - (i * (R - L)) / 9, b = R - ((i + 1) * (R - L)) / 9; valance += " Q" + (a + b) / 2 + " " + (T + 0.095 * B.h) + " " + b + " " + (T + 0.05 * B.h); }
      mk("path", { d: valance + " Z", fill: mix(GR, AC, 0.14), stroke: AC, "stroke-opacity": 0.45, "stroke-width": 2 * U }, inside);
      mk("rect", { x: L, y: T, width: R - L, height: F - T, rx: 0.16 * (R - L), stroke: AC, "stroke-opacity": 0.6, "stroke-width": 3 * U }, svg);
      clock(t => {
        const open = inOut(ramp(t, 0.35, Math.max(0.6, LAND - 0.65))), lit = ramp(t, 0.5, 0.5), focus = inOut(ramp(t, LAND - 0.55, 0.55));
        stars.forEach((el, i) => put(el, { opacity: (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.2 + STARS[i].k))) * (0.4 + 0.6 * open) }));
        put(planet, { cx: OX + Math.cos(t * 0.9) * ORX, cy: OY + Math.sin(t * 0.9) * ORY });
        const cw = ((R - L) / 2) * (1 - 0.88 * open);
        curtains.forEach((c, side) => {
          const x0 = side === 0 ? L : R - cw, edge = side === 0 ? L + cw : R - cw;
          put(c.rect, { x: x0, width: cw }); put(c.edge, { x1: edge, x2: edge });
          c.folds.forEach((fold, k) => { const x = x0 + (cw * (k + 0.5)) / 6, s = Math.sin(t * 1.3 + k + side) * 4 * U; put(fold, { d: "M" + x + " " + T + " C" + (x + s) + " " + (T + (F - T) / 3) + " " + (x - s) + " " + (T + (2 * (F - T)) / 3) + " " + x + " " + F }); });
        });
        [-1, 1].forEach((s, i) => {
          const ax = s < 0 ? L + 0.1 * B.w : R - 0.1 * B.w, ay = T + 0.06 * B.h;
          const tx = B.cx + (s * 0.24 * B.w + Math.sin(t * 1.5 + i * 2) * 0.1 * B.w) * (1 - focus), spread = 0.11 * B.w * (1 - 0.35 * focus);
          put(beams[i], { points: pts([[ax, ay], [tx - spread, F], [tx + spread, F]]), opacity: lit * (0.06 + 0.08 * focus) });
          put(pools[i], { cx: tx, cy: F, rx: spread * 1.15, ry: spread * 0.2, opacity: lit * (0.14 + 0.16 * focus) });
        });
      });
      ${reveal || note ? `tl.fromTo("#${id} .vz-reveal", { opacity: 0, scale: 1.25, filter: "blur(10px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out" }, LAND);` : ''}`,
    })
  },

  orbit(scene) {
    const { id, data, land, marks, duration, f } = scene
    const items = list(data.items, 2, 4, `${id}: data.items — от 2 до 4 пунктов.`)
    const notes = Array.isArray(data.notes) ? data.notes.map(note => String(note ?? '')) : []
    const B = boxOf(f)
    const times = beats(marks, items.length, Math.max(0.6, Math.min(land, duration - 1.2)), duration)
    const center = String(data.center ?? '').trim()
    const cy = Math.round(B.cy - 0.02 * B.h)
    return visual(scene, {
      seed: 23,
      css: `
        #${id} .vz-pl { position: absolute; opacity: 0; white-space: nowrap; }
        #${id} .vz-pl b { display: block; font-size: ${Math.round(42 * f.u)}px; font-weight: 800; text-transform: uppercase; line-height: 1; }
        #${id} .vz-pl i { display: block; font-style: normal; margin-top: ${Math.round(8 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.16em; text-transform: uppercase; color: ${f.accent}; }
        #${id} .vz-center { left: 0; right: 0; text-align: center; top: ${Math.round(cy + 0.53 * B.S * 0.45 + 36 * f.u)}px; opacity: 0; }`,
      body: items.map((item, i) => `<div class="vz-pl" id="${id}-pl${i}"><b>${escapeHtml(item)}</b>${notes[i] ? `<i>${escapeHtml(notes[i])}</i>` : ''}</div>`).join('') + (center ? `<div class="vz-label vz-center" id="${id}-center">${escapeHtml(center)}</div>` : ''),
      script: `
      const TIMES = ${js(times)}, N = TIMES.length, CX = B.cx, CY = ${cy};
      const RING = i => B.S * (0.17 + 0.12 * i), SLOT = N === 2 ? [1, 2] : N === 3 ? [0, 1, 2] : [0, 1, 2, 3];
      const grad = mk("radialGradient", { id: ${js(`${id}-sun`)} }, mk("defs", {}, svg));
      mk("stop", { offset: "0", "stop-color": AC, "stop-opacity": 0.7 }, grad); mk("stop", { offset: "1", "stop-color": AC, "stop-opacity": 0 }, grad);
      const rings = [0, 1, 2, 3].map(i => mk("ellipse", { cx: CX, cy: CY, rx: RING(i), ry: RING(i) * 0.45, stroke: INK, "stroke-opacity": 0.22, "stroke-width": 2 * U, pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, svg));
      mk("circle", { cx: CX, cy: CY, r: 0.19 * B.S, fill: "url(#${id}-sun)" }, svg);
      const rays = Array.from({ length: 12 }, () => mk("line", { stroke: AC, "stroke-width": 3 * U, "stroke-linecap": "round" }, svg));
      const sun = mk("circle", { cx: CX, cy: CY, r: 0, fill: AC }, svg);
      const bodies = [0, 1, 2, 3].map(i => { const item = SLOT.indexOf(i); return { ring: i, item, a0: rand() * 6.283, w: 0.75 * Math.pow(RING(0) / RING(i), 1.5), el: mk("circle", { fill: INK }, svg), halo: mk("circle", { stroke: AC, "stroke-width": 3 * U, opacity: 0 }, svg) }; });
      rings.forEach((ring, i) => tl.to(ring, { strokeDashoffset: 0, duration: 0.8, ease: "power2.out" }, 0.25 + 0.08 * i));
      tl.to(sun, { attr: { r: 0.06 * B.S }, duration: 0.6, ease: "back.out(2)" }, 0.2);
      clock(t => {
        const on = ramp(t, 0.2, 0.5);
        rays.forEach((ray, i) => { const a = (i / 12) * 6.283 + t * 0.35, r1 = 0.075 * B.S, r2 = (0.1 + 0.012 * Math.sin(t * 3 + i)) * B.S; put(ray, { x1: CX + Math.cos(a) * r1, y1: CY + Math.sin(a) * r1, x2: CX + Math.cos(a) * r2, y2: CY + Math.sin(a) * r2, opacity: 0.7 * on }); });
        bodies.forEach(b => {
          const a = b.a0 + b.w * t, x = CX + Math.cos(a) * RING(b.ring), y = CY + Math.sin(a) * RING(b.ring) * 0.45;
          const lit = b.item >= 0 ? ramp(t, TIMES[b.item], 0.25) : 0, seen = ramp(t, 0.4 + 0.08 * b.ring, 0.4);
          put(b.el, { cx: x, cy: y, fill: lit > 0 ? AC : INK, r: (b.item >= 0 ? 0.022 + 0.01 * pop(lit) : 0.011) * B.S, opacity: seen * (b.item >= 0 ? 1 : 0.45) });
          if (b.item < 0) return;
          const age = t - TIMES[b.item];
          put(b.halo, { cx: x, cy: y, r: (0.03 + 0.14 * clamp(age / 0.9)) * B.S, opacity: age > 0 && age < 0.9 ? 1 - age / 0.9 : 0 });
          const label = $("#${id}-pl" + b.item), gap = 0.04 * B.S, width = label.offsetWidth;
          let right = x >= CX;
          if (right && x + gap + width > FW - PAD) right = false;
          else if (!right && x - gap - width < PAD) right = true;
          label.style.left = (x + (right ? gap : -gap)) + "px"; label.style.top = y + "px";
          label.style.transform = right ? "translate(0,-50%)" : "translate(-100%,-50%)"; label.style.textAlign = right ? "left" : "right";
        });
      });
      TIMES.forEach((t, i) => { tl.fromTo("#${id}-pl" + i, { opacity: 0 }, { opacity: 1, duration: 0.3 }, t); if (i + 1 < N) tl.to("#${id}-pl" + i, { opacity: 0.55, duration: 0.3 }, TIMES[i + 1]); });
      ${center ? `tl.to("#${id}-center", { opacity: 1, duration: 0.4 }, 0.5);` : ''}`,
    })
  },

  space(scene) {
    const { id, data, f } = scene
    const B = boxOf(f)
    const point = Array.isArray(data.point) && data.point.length >= 2 && data.point.slice(0, 2).every(Number.isFinite) ? data.point.slice(0, 2).map(v => Math.max(-4, Math.min(4, v))) : [2.4, 1.6]
    const unit = escapeHtml(data.unit ?? 'м')
    const label = String(data.label ?? '').trim()
    return visual(scene, {
      seed: 31,
      rig: true,
      css: `
        #${id} .vz-read { position: absolute; left: 0; right: 0; top: ${Math.round(B.y1 - 0.1 * B.h)}px; text-align: center; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(32 * f.u)}px; letter-spacing: 0.06em; color: ${f.ink}; opacity: 0; }
        #${id} .vz-read span { color: ${f.accent}; margin: 0 ${Math.round(10 * f.u)}px 0 ${Math.round(28 * f.u)}px; }
        #${id} .vz-axis { position: absolute; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(24 * f.u)}px; font-weight: 700; transform: translate(-50%, -50%); opacity: 0; }
        #${id} .vz-lock { position: absolute; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.2em; text-transform: uppercase; color: ${f.accent}; white-space: nowrap; opacity: 0; }`,
      body: `<div class="vz-read" id="${id}-read"><span>X</span><b id="${id}-x">0.00</b> ${unit}<span>Z</span><b id="${id}-z">0.00</b> ${unit}</div>${['x', 'y', 'z'].map(axis => `<div class="vz-axis" id="${id}-a${axis}">${axis.toUpperCase()}</div>`).join('')}<div class="vz-lock" id="${id}-lock">● ${escapeHtml(label || 'lock')}</div>`,
      script: `
      const END = ${js(point)}, START = [-3, -2.6], CTRL = [-2.8, 2.4];
      const F = B.S * 1.4, D = 13, P0 = 0.55, CYV = B.cy - 0.02 * B.h, G = 4;
      const proj = (x, y, z, yaw) => { const xr = x * Math.cos(yaw) - z * Math.sin(yaw), zr = x * Math.sin(yaw) + z * Math.cos(yaw), up = y * Math.cos(P0) + zr * Math.sin(P0), depth = D + zr * Math.cos(P0) - y * Math.sin(P0); return [B.cx + (F * xr) / depth, CYV - (F * up) / depth, depth]; };
      const grid = [];
      for (let i = -G; i <= G; i += 1) { grid.push([[i, -G], [i, G]]); grid.push([[-G, i], [G, i]]); }
      const gridEls = grid.map(() => mk("line", { stroke: INK, "stroke-width": 1.5 * U }, svg));
      const axes = [[3, 0, 0, AC], [0, 2.2, 0, INK], [0, 0, 3, INK]].map(a => ({ to: a, el: mk("line", { stroke: a[3], "stroke-width": 3 * U, "stroke-linecap": "round" }, svg) }));
      const trail = mk("polyline", { stroke: AC, "stroke-width": 3 * U, "stroke-dasharray": (8 * U) + " " + (10 * U), "stroke-opacity": 0.7 }, svg);
      const ring = mk("ellipse", { stroke: AC, "stroke-width": 3 * U }, svg), lock = mk("ellipse", { stroke: AC, "stroke-width": 2 * U }, svg);
      const actor = figure(svg, { joints: true });
      const at = m => [(1 - m) * (1 - m) * START[0] + 2 * (1 - m) * m * CTRL[0] + m * m * END[0], (1 - m) * (1 - m) * START[1] + 2 * (1 - m) * m * CTRL[1] + m * m * END[1]];
      const GO = 0.45, STOP = Math.max(GO + 0.5, LAND - 0.15);
      const fmt = v => (v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
      clock(t => {
        const yaw = 0.65 + 0.1 * t;
        grid.forEach(([a, b], i) => {
          const r = out(ramp(t, 0.15 + 0.02 * i, 0.5)), p = proj(a[0], 0, a[1], yaw), q = proj(lerp(a[0], b[0], r), 0, lerp(a[1], b[1], r), yaw);
          const edge = (a[0] === b[0] && Math.abs(a[0]) === G) || (a[1] === b[1] && Math.abs(a[1]) === G);
          put(gridEls[i], { x1: p[0], y1: p[1], x2: q[0], y2: q[1], "stroke-opacity": (edge ? 0.45 : 0.16) * (0.5 + 0.5 * clamp((17 - (p[2] + q[2]) / 2) / 7)) });
        });
        const o = proj(0, 0, 0, yaw);
        axes.forEach((axis, i) => {
          const r = out(ramp(t, 0.5 + 0.1 * i, 0.5)), e = proj(axis.to[0] * r, axis.to[1] * r, axis.to[2] * r, yaw);
          put(axis.el, { x1: o[0], y1: o[1], x2: e[0], y2: e[1], opacity: r > 0 ? 1 : 0 });
          const name = $("#${id}-a" + "xyz"[i]); name.style.left = (e[0] + (i === 1 ? 0 : e[0] >= o[0] ? 24 : -24) * U) + "px"; name.style.top = (e[1] - (i === 1 ? 22 : 18) * U) + "px"; name.style.opacity = r;
        });
        const m = inOut(ramp(t, GO, STOP - GO)), here = at(m), foot = proj(here[0], 0, here[1], yaw), top = proj(here[0], 1.75, here[1], yaw);
        const walking = Math.min(ramp(t, GO, 0.25), 1 - ramp(t, STOP - 0.25, 0.25)), seen = ramp(t, 0.35, 0.3);
        actor.draw(mixPose(pose("idle", t), pose("walk", t), walking), foot[0], foot[1], foot[1] - top[1], INK, { width: 0.03, hollow: true, head: 0.06, dot: 0.03, dotColor: AC, bones: seen, dots: seen });
        const path = []; for (let k = 0; k <= 30; k += 1) { const p = at((m * k) / 30), s = proj(p[0], 0, p[1], yaw); path.push([s[0], s[1]]); }
        put(trail, { points: pts(path), opacity: m > 0 ? 1 : 0 });
        const rx = (F * 0.5) / foot[2], age = t - LAND, k = out(clamp(age / 0.4));
        put(ring, { cx: foot[0], cy: foot[1], rx: rx, ry: rx * 0.42, opacity: seen });
        put(lock, { cx: foot[0], cy: foot[1], rx: rx * lerp(2.6, 1.35, k), ry: rx * 0.42 * lerp(2.6, 1.35, k), opacity: age > 0 ? 0.9 : 0 });
        $("#${id}-x").textContent = fmt(here[0]); $("#${id}-z").textContent = fmt(here[1]);
        const tag = $("#${id}-lock"); tag.style.left = (foot[0] + rx * 1.5) + "px"; tag.style.top = top[1] + "px";
      });
      tl.to("#${id}-read", { opacity: 1, duration: 0.5 }, 0.5);
      tl.to("#${id}-read b", { color: AC, duration: 0.3 }, LAND);
      tl.to("#${id}-lock", { opacity: 1, duration: 0.3 }, LAND + 0.05);`,
    })
  },

  body(scene) {
    const { id, data, marks, duration, f } = scene
    const steps = list(data.steps ?? ['костюм', 'движения', 'датчики'], 2, 4, `${id}: data.steps — от 2 до 4 этапов.`)
    const times = beats(marks, steps.length, 0.45, duration)
    const B = boxOf(f)
    return visual(scene, {
      seed: 41,
      rig: true,
      body: chips(id, steps, Math.round(B.y1 - 0.075 * B.h)) + `<div class="vz-label" id="${id}-track" style="color:${f.accent};opacity:0">● tracking</div>`,
      script: `
      const TIMES = ${js(times)}, N = TIMES.length, FX = B.cx, FY = B.y1 - 0.15 * B.h, HT = 0.6 * B.h;
      const T0 = TIMES[0], T1 = TIMES[1], T2 = N > 2 && ${data.sensors !== false} ? TIMES[2] : null, T3 = N > 3 ? TIMES[3] : null;
      const suit = figure(svg, {});
      const trails = [0, 1].map(() => mk("polyline", { stroke: AC, "stroke-width": 3 * U, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0 }, svg));
      const CAMS = T2 === null ? [] : [[B.x0 + 0.05 * B.w, B.y0 + 0.06 * B.h], [B.x1 - 0.05 * B.w, B.y0 + 0.06 * B.h], [B.x0 + 0.03 * B.w, B.y1 - 0.34 * B.h], [B.x1 - 0.03 * B.w, B.y1 - 0.34 * B.h]];
      const TARGETS = ["head", "lHa", "rHa", "lFo", "rFo", "pelvis"];
      const beams = CAMS.map(() => TARGETS.map(() => mk("line", { stroke: AC, "stroke-width": 1.5 * U }, svg)));
      const cams = CAMS.map(() => { const g = mk("g", {}, svg); mk("rect", { x: -18 * U, y: -12 * U, width: 36 * U, height: 24 * U, rx: 5 * U, stroke: INK, "stroke-width": 2.5 * U, fill: GR }, g); mk("circle", { r: 6 * U, fill: AC }, g); return g; });
      const rig = figure(svg, { joints: true });
      const halos = JOINTS.map(() => mk("circle", { stroke: AC, "stroke-width": 2 * U }, svg));
      const corners = [0, 1, 2, 3].map(() => mk("path", { stroke: AC, "stroke-width": 3 * U }, svg));
      const motion = t => inOut(ramp(t, T1 + 0.15, 0.6));
      const poseAt = t => mixPose(pose("idle", t), pose("dance", t), motion(t));
      clock(t => {
        const P = poseAt(t), avatar = T3 === null ? 0 : ramp(t, T3, 0.5);
        suit.draw(P, FX, FY, HT, avatar > 0 ? mix(INK, AC, avatar) : INK, { width: 0.09, head: 0.08, bones: lerp(0.1, 0.3, avatar) * ramp(t, 0.2, 0.3) });
        rig.draw(P, FX, FY, HT, INK, { width: 0.012, hollow: true, head: 0.055, bones: ramp(t, T1, 0.45) });
        JOINTS.forEach((j, i) => {
          const at = T0 + i * 0.025, grow = pop(ramp(t, at, 0.35)), age = t - at;
          put(rig.dots[i], { r: 0.021 * HT * grow, fill: ramp(t, T1, 0.3) > 0 ? AC : INK });
          put(halos[i], { cx: FX + P[j][0] * HT, cy: FY + P[j][1] * HT, r: (0.02 + 0.05 * clamp(age / 0.6)) * HT, opacity: age > 0 && age < 0.6 ? 1 - age / 0.6 : 0 });
        });
        ["lHa", "rHa"].forEach((j, k) => { const line = []; for (let s = 0; s <= 12; s += 1) { const q = poseAt(Math.max(0, t - s * 0.035)); line.push([FX + q[j][0] * HT, FY + q[j][1] * HT]); } put(trails[k], { points: pts(line), opacity: 0.6 * motion(t) }); });
        cams.forEach((g, c) => {
          const grow = pop(ramp(t, T2 + c * 0.06, 0.35)), on = ramp(t, T2, 0.3);
          put(g, { transform: "translate(" + CAMS[c][0] + " " + CAMS[c][1] + ") scale(" + grow + ")" });
          beams[c].forEach((beam, k) => { const p = P[TARGETS[k]]; put(beam, { x1: CAMS[c][0], y1: CAMS[c][1], x2: FX + p[0] * HT, y2: FY + p[1] * HT, opacity: on * (Math.sin(t * 19 + c * 2.1 + k * 1.3) > -0.2 ? 0.32 : 0.08) }); });
        });
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        JOINTS.forEach(j => { const x = FX + P[j][0] * HT, y = FY + P[j][1] * HT; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
        x0 -= 0.08 * HT; x1 += 0.08 * HT; y0 -= 0.1 * HT; y1 += 0.04 * HT;
        const L = 0.07 * HT, seen = ramp(t, T1 + 0.3, 0.3);
        const d = ["M" + x0 + " " + (y0 + L) + " V" + y0 + " H" + (x0 + L), "M" + (x1 - L) + " " + y0 + " H" + x1 + " V" + (y0 + L), "M" + x0 + " " + (y1 - L) + " V" + y1 + " H" + (x0 + L), "M" + (x1 - L) + " " + y1 + " H" + x1 + " V" + (y1 - L)];
        corners.forEach((el, i) => put(el, { d: d[i], opacity: seen }));
        const tag = $("#${id}-track"); tag.style.left = x0 + "px"; tag.style.top = (y1 + 12 * U) + "px"; tag.style.opacity = seen;
      });
      TIMES.forEach((t, i) => { chipOn(i, t); if (i > 0) chipOff(i - 1, t); });`,
    })
  },

  map(scene) {
    const { id, data, f } = scene
    const place = String(data.place ?? '').trim()
    if (!place) throw new MotionError('insert_invalid', `${id}: data.place обязателен — что отмечает пин.`)
    const note = String(data.note ?? '').trim()
    const city = String(data.city ?? '').trim()
    const B = boxOf(f)
    const size = fit(place, 50 * f.u, B.w * 0.9, 2, 0.5, UPPER)
    return visual(scene, {
      seed: 53,
      css: `
        #${id} .vz-card { position: absolute; left: ${B.x0}px; right: ${f.W - B.x1}px; top: ${Math.round(B.cy + 0.13 * B.S)}px; text-align: center; opacity: 0; }
        #${id} .vz-card b { display: block; font-size: ${size}px; font-weight: 800; text-transform: uppercase; line-height: 1.02; }
        #${id} .vz-card i { display: block; font-style: normal; margin-top: ${Math.round(12 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.2em; text-transform: uppercase; color: ${f.accent}; }`,
      body: `<div class="vz-card" id="${id}-card"><b>${escapeHtml(place)}</b>${note ? `<i>${escapeHtml(note)}</i>` : ''}</div>${city ? `<div class="vz-label" id="${id}-city" style="left:${B.x0}px;top:${B.y0}px;opacity:0">${escapeHtml(city)}</div>` : ''}`,
      script: `
      const MC = [B.cx - 0.03 * B.S, B.cy + 0.03 * B.S], PIN = [B.cx + 0.12 * B.S, B.cy - 0.09 * B.S], AIM = [B.cx, B.cy];
      const world = mk("g", {}, svg);
      let river = ""; for (let i = 0; i <= 60; i += 1) { const x = MC[0] - 0.8 * B.S + (i / 60) * 1.6 * B.S, y = MC[1] + 0.1 * B.S * Math.sin((x / B.S) * 5 + 1) + 0.05 * B.S * Math.sin((x / B.S) * 13); river += (i ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }
      mk("path", { d: river, stroke: INK, "stroke-opacity": 0.1, "stroke-width": 22 * U, "stroke-linecap": "round" }, world);
      mk("path", { d: river, stroke: INK, "stroke-opacity": 0.25, "stroke-width": 1.5 * U, "vector-effect": "non-scaling-stroke" }, world);
      for (let i = 0; i < 160; i += 1) { const a = rand() * 6.283, r = Math.sqrt(rand()) * 0.62 * B.S, x = MC[0] + Math.cos(a) * r, y = MC[1] + Math.sin(a) * r, s = (6 + rand() * 12) * U; mk("rect", { x: x, y: y, width: s, height: s * (0.6 + rand() * 0.8), fill: INK, opacity: 0.05 + rand() * 0.07, transform: "rotate(" + (rand() * 40 - 20).toFixed(1) + " " + x.toFixed(1) + " " + y.toFixed(1) + ")" }, world); }
      const roads = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * 6.283 + rand() * 0.3, bend = (rand() - 0.5) * 0.5, r0 = 0.08 * B.S, r1 = 0.75 * B.S; return mk("path", { d: "M" + (MC[0] + Math.cos(a) * r0) + " " + (MC[1] + Math.sin(a) * r0) + " Q" + (MC[0] + Math.cos(a + bend) * r1 * 0.5) + " " + (MC[1] + Math.sin(a + bend) * r1 * 0.5) + " " + (MC[0] + Math.cos(a) * r1) + " " + (MC[1] + Math.sin(a) * r1), stroke: INK, "stroke-opacity": 0.22, "stroke-width": 2 * U, "vector-effect": "non-scaling-stroke", pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, world); });
      const ringPath = (r, a, b) => { const p = []; for (let i = 0; i <= 96; i += 1) { const th = (i / 96) * 6.283, rr = r * (1 + 0.05 * Math.sin(3 * th + a) + 0.03 * Math.sin(5 * th + b)); p.push((MC[0] + Math.cos(th) * rr).toFixed(1) + " " + (MC[1] + Math.sin(th) * rr * 0.92).toFixed(1)); } return "M" + p.join(" L") + " Z"; };
      const rings = [[0.17, 0.42], [0.31, 0.32], [0.5, 0.24]].map(([r, o], i) => mk("path", { d: ringPath(r * B.S, i * 1.7, i * 0.9 + 0.4), stroke: INK, "stroke-opacity": o, "stroke-width": (3 - i * 0.5) * U, "vector-effect": "non-scaling-stroke", pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, world));
      rings.forEach((el, i) => tl.to(el, { strokeDashoffset: 0, duration: 0.9, ease: "power2.out" }, 0.2 + 0.12 * i));
      roads.forEach((el, i) => tl.to(el, { strokeDashoffset: 0, duration: 0.7, ease: "power2.out" }, 0.35 + 0.03 * i));
      const pulses = [0, 1, 2].map(() => mk("ellipse", { stroke: AC, "stroke-width": 3 * U }, svg));
      const shadow = mk("ellipse", { fill: GR, opacity: 0 }, svg);
      const pin = mk("g", { opacity: 0 }, svg), PR = 0.04 * B.S;
      mk("path", { d: "M0 0 C" + (-0.55 * PR) + " " + (-0.9 * PR) + " " + (-PR) + " " + (-1.25 * PR) + " " + (-PR) + " " + (-1.9 * PR) + " A" + PR + " " + PR + " 0 1 1 " + PR + " " + (-1.9 * PR) + " C" + PR + " " + (-1.25 * PR) + " " + (0.55 * PR) + " " + (-0.9 * PR) + " 0 0 Z", fill: AC }, pin);
      mk("circle", { cx: 0, cy: -1.9 * PR, r: 0.4 * PR, fill: GR }, pin);
      const bounce = gsap.parseEase("bounce.out"), GO = 0.55, STOP = Math.max(GO + 0.5, LAND - 0.2);
      clock(t => {
        const m = inOut(ramp(t, GO, STOP - GO)), z = 1 + 0.85 * m, T = [lerp(PIN[0], AIM[0], m), lerp(PIN[1], AIM[1], m)];
        put(world, { transform: "translate(" + T[0] + " " + T[1] + ") scale(" + z + ") translate(" + (-PIN[0]) + " " + (-PIN[1]) + ")" });
        const drop = ramp(t, LAND - 0.3, 0.45), fall = 1 - bounce(drop);
        put(pin, { transform: "translate(" + T[0] + " " + (T[1] - fall * 0.35 * B.S) + ")", opacity: drop > 0 ? 1 : 0 });
        put(shadow, { cx: T[0], cy: T[1], rx: PR * (0.9 - 0.5 * fall), ry: PR * 0.3 * (1 - 0.5 * fall), opacity: drop > 0 ? 0.6 : 0 });
        pulses.forEach((el, k) => { const age = t - LAND - k * 0.45, a = ((age % 1.35) + 1.35) % 1.35; put(el, { cx: T[0], cy: T[1], rx: (a / 1.35) * 0.24 * B.S, ry: (a / 1.35) * 0.1 * B.S, opacity: age >= 0 ? 0.8 * (1 - a / 1.35) : 0 }); });
      });
      tl.fromTo("#${id}-card", { opacity: 0, y: 20 * U }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }, LAND + 0.1);
      ${city ? `tl.to("#${id}-city", { opacity: 1, duration: 0.4 }, 0.4);` : ''}`,
    })
  },

  dome(scene) {
    const { id, data, f } = scene
    const fov = data.fov !== false
    const from = Number.isFinite(data.from) ? data.from : 60
    const to = Math.min(359, Number.isFinite(data.to) ? data.to : 180)
    const label = String(data.label ?? '').trim()
    const B = boxOf(f)
    return visual(scene, {
      seed: 67,
      rig: true,
      css: `
        #${id} .vz-read { position: absolute; left: 0; right: 0; top: ${B.y0 - Math.round(10 * f.u)}px; text-align: center; opacity: 0; }
        #${id} .vz-read b { font-size: ${Math.round(112 * f.u)}px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
        #${id} .vz-read span { font-size: ${Math.round(64 * f.u)}px; font-weight: 800; color: ${f.accent}; vertical-align: top; }
        #${id} .vz-read i { display: block; font-style: normal; margin-top: ${Math.round(10 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(22 * f.u)}px; letter-spacing: 0.24em; text-transform: uppercase; color: color-mix(in srgb, ${f.ink} 75%, transparent); }`,
      body: fov ? `<div class="vz-read" id="${id}-read"><b id="${id}-deg">${Math.round(from)}</b><span>${escapeHtml(data.unit ?? '°')}</span>${label ? `<i>${escapeHtml(label)}</i>` : ''}</div>` : '',
      script: `
      const FOV = ${fov}, SWEEP = ${data.sweep === true}, FROM = ${from}, TO = ${to};
      const R = Math.min(0.47 * B.w, (FOV ? 0.6 : 0.7) * B.h), E = 0.3, BY = B.y1 - (FOV ? 0.12 : 0.16) * B.h;
      const sph = (th, ph, yaw) => { const a = th + yaw, X = R * Math.cos(ph) * Math.cos(a), Y = R * Math.sin(ph), Z = R * Math.cos(ph) * Math.sin(a); return [B.cx + X, BY - (Y * Math.cos(E) + Z * Math.sin(E)), Z]; };
      const PARAS = [0.28, 0.56, 0.84, 1.12, 1.36];
      const merid = Array.from({ length: 12 }, () => mk("polyline", { stroke: INK, "stroke-opacity": 0.28, "stroke-width": 1.6 * U }, svg));
      const paras = PARAS.map(() => mk("polyline", { stroke: INK, "stroke-opacity": 0.2, "stroke-width": 1.4 * U }, svg));
      const base = mk("ellipse", { cx: B.cx, cy: BY, rx: R, ry: R * Math.sin(E), stroke: AC, "stroke-opacity": 0.7, "stroke-width": 3 * U, pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, svg);
      tl.to(base, { strokeDashoffset: 0, duration: 0.8, ease: "power2.out" }, 0.2);
      const STARS = Array.from({ length: 80 }, () => ({ th: rand() * 6.283, ph: 0.12 + rand() * 1.35, r: (1.2 + rand() * 2.6) * U, k: rand() * 6 }));
      const stars = STARS.map(s => mk("circle", { r: s.r, fill: INK }, svg));
      const fan = mk("path", { fill: AC, "fill-opacity": 0.1, stroke: AC, "stroke-opacity": 0.8, "stroke-width": 2.5 * U, opacity: 0 }, svg);
      const viewer = figure(svg, {}), VH = 0.2 * R, EYE = [B.cx, BY - 0.9 * VH];
      const trail = mk("polyline", { stroke: AC, "stroke-width": 4 * U, "stroke-linecap": "round", "stroke-opacity": 0.5, opacity: 0 }, svg);
      const gaze = mk("line", { stroke: AC, "stroke-width": 2 * U, "stroke-dasharray": (6 * U) + " " + (8 * U), opacity: 0 }, svg);
      const spot = mk("circle", { fill: AC, opacity: 0 }, svg), glow = mk("circle", { stroke: AC, "stroke-width": 2 * U, opacity: 0 }, svg);
      const gazeAt = s => sph(1.1 + 1.6 * Math.max(0, s - LAND + 0.3), 0.75 + 0.35 * Math.sin(1.3 * s), 0);
      clock(t => {
        const yaw = 0.12 * t + (SWEEP ? 0.6 * Math.max(0, t - LAND) : 0);
        merid.forEach((el, k) => { const th = (k / 12) * Math.PI, n = Math.round(48 * out(ramp(t, 0.25 + 0.035 * k, 0.6))), line = []; for (let s = 0; s <= n; s += 1) { const ph = (s / 48) * Math.PI; line.push(ph <= Math.PI / 2 ? sph(th, ph, yaw) : sph(th + Math.PI, Math.PI - ph, yaw)); } put(el, { points: pts(line) }); });
        paras.forEach((el, k) => { const n = Math.round(64 * out(ramp(t, 0.45 + 0.06 * k, 0.6))), line = []; for (let s = 0; s <= n; s += 1) line.push(sph((s / 64) * 6.283, PARAS[k], yaw)); put(el, { points: pts(line) }); });
        const angle = FOV ? lerp(FROM, TO, inOut(ramp(t, 0.6, Math.max(0.4, LAND - 0.6)))) : 0, half = (angle / 2) * Math.PI / 180;
        STARS.forEach((s, i) => {
          const p = sph(s.th, s.ph, yaw), off = Math.abs(Math.atan2(p[0] - EYE[0], EYE[1] - p[1]));
          const bright = FOV ? (off <= half ? 1 : 0.15) : 0.55 + 0.35 * Math.sin(t * 2 + s.k);
          put(stars[i], { cx: p[0], cy: p[1], opacity: ramp(t, 0.5, 0.5) * bright * (p[2] > 0 ? 0.55 : 1) });
        });
        if (FOV) {
          const r = R * 1.1, p1 = [EYE[0] - Math.sin(half) * r, EYE[1] - Math.cos(half) * r], p2 = [EYE[0] + Math.sin(half) * r, EYE[1] - Math.cos(half) * r];
          put(fan, { d: "M" + EYE[0] + " " + EYE[1] + " L" + p1[0] + " " + p1[1] + " A" + r + " " + r + " 0 " + (angle > 180 ? 1 : 0) + " 1 " + p2[0] + " " + p2[1] + " Z", opacity: ramp(t, 0.45, 0.3) });
          $("#${id}-deg").textContent = Math.round(angle);
        }
        viewer.draw(pose("idle", t), B.cx, BY, VH, INK, { width: 0.1, head: 0.1, bones: ramp(t, 0.3, 0.3) });
        if (SWEEP) {
          const g = ramp(t, LAND - 0.3, 0.4), p = gazeAt(t), line = [];
          for (let k = 0; k < 14; k += 1) { const q = gazeAt(Math.max(0, t - k * 0.05)); line.push([q[0], q[1]]); }
          put(trail, { points: pts(line), opacity: g }); put(spot, { cx: p[0], cy: p[1], r: 0.022 * B.S, opacity: g });
          put(glow, { cx: p[0], cy: p[1], r: (0.035 + 0.01 * Math.sin(t * 6)) * B.S, opacity: 0.7 * g }); put(gaze, { x1: EYE[0], y1: EYE[1], x2: p[0], y2: p[1], opacity: 0.8 * g });
        }
      });
      ${fov ? `tl.fromTo("#${id}-read", { opacity: 0, y: ${Math.round(16 * f.u)} }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0.45);
      tl.to("#${id}-deg", { color: AC, duration: 0.3 }, LAND);` : ''}`,
    })
  },

  effort(scene) {
    const { id, data, marks, duration, f } = scene
    const slow = data.slow ?? {}
    const fast = data.fast ?? {}
    const missing = Array.isArray(data.missing) ? data.missing.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 3) : []
    const times = beats(marks, Math.max(1, missing.length), 0.6, duration)
    const B = boxOf(f)
    const rows = [Math.round(B.y0 + 0.02 * B.h), Math.round(B.y0 + 0.52 * B.h)]
    const row = (r, info, fallback, count) => `<div class="vz-row" id="${id}-row${r}" style="top:${rows[r]}px"><b>${escapeHtml(info.label ?? fallback.label)}</b><i>${escapeHtml(info.note ?? fallback.note)}</i><span class="vz-count">${count}</span></div>`
    return visual(scene, {
      seed: 71,
      css: `
        #${id} .vz-row { position: absolute; left: ${B.x0}px; right: ${f.W - B.x1}px; }
        #${id} .vz-row b { display: block; font-size: ${Math.round(36 * f.u)}px; font-weight: 800; text-transform: uppercase; line-height: 1; }
        #${id} .vz-row i { display: block; font-style: normal; margin-top: ${Math.round(10 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.18em; text-transform: uppercase; color: color-mix(in srgb, ${f.ink} 60%, transparent); }
        #${id} .vz-count { position: absolute; right: 0; top: 0; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(30 * f.u)}px; }
        #${id}-row1 .vz-count { color: ${f.accent}; }
        #${id} .vz-chips { justify-content: flex-start; left: ${B.x0}px; }`,
      body: row(0, slow, { label: 'вручную', note: 'ключ за ключом' }, `ключи · <span id="${id}-keys">0</span>`) + row(1, fast, { label: 'мокап', note: 'один дубль' }, `<span id="${id}-done">0%</span>`) + (missing.length ? chips(id, missing, Math.round(rows[0] + 0.335 * B.h)) : ''),
      script: `
      const TIMES = ${js(times)}, ROW = ${js(rows)}, TRACK = ROW.map(y => y + 0.3 * B.h), AMP = 0.065 * B.h;
      const curve = x => Math.sin(x * 7.5 + 0.6) * 0.65 + Math.sin(x * 19 + 1.3) * 0.3 + Math.sin(x * 41) * 0.08;
      const gA = mk("g", {}, svg), gB = mk("g", {}, svg);
      [gA, gB].forEach((g, r) => { mk("line", { x1: B.x0, y1: TRACK[r], x2: B.x1, y2: TRACK[r], stroke: INK, "stroke-opacity": 0.3, "stroke-width": 2 * U }, g); for (let i = 0; i <= 24; i += 1) { const x = B.x0 + (i / 24) * B.w; mk("line", { x1: x, y1: TRACK[r], x2: x, y2: TRACK[r] + (i % 4 ? 8 : 16) * U, stroke: INK, "stroke-opacity": 0.3, "stroke-width": 1.5 * U }, g); } });
      const K = 14, keyX = k => B.x0 + ((k + 0.5) / 28) * B.w, keyY = k => TRACK[0] - 0.09 * B.h - AMP * curve((k + 0.5) / 28), keyAt = k => 0.5 + (k * (DUR - 1.3)) / K;
      const poly = mk("polyline", { stroke: INK, "stroke-opacity": 0.55, "stroke-width": 2 * U }, gA);
      const keys = Array.from({ length: K }, () => mk("path", { d: "M0 " + (-16 * U) + " L" + 16 * U + " 0 L0 " + 16 * U + " L" + (-16 * U) + " 0 Z", fill: INK }, gA));
      const live = mk("polyline", { stroke: AC, "stroke-width": 3.5 * U, "stroke-linecap": "round", "stroke-linejoin": "round" }, gB);
      const head = mk("line", { stroke: AC, "stroke-width": 2.5 * U }, gB), rec = mk("circle", { r: 8 * U, fill: AC }, gB);
      const GO = 0.6, STOP = Math.max(GO + 0.8, Math.min(DUR - 0.8, 2.2));
      clock(t => {
        const shown = [];
        keys.forEach((el, k) => { const s = pop(ramp(t, keyAt(k), 0.3)); put(el, { transform: "translate(" + keyX(k) + " " + keyY(k) + ") scale(" + s + ")" }); if (s > 0.05) shown.push([keyX(k), keyY(k)]); });
        put(poly, { points: pts(shown) }); $("#${id}-keys").textContent = shown.length;
        const m = inOut(ramp(t, GO, STOP - GO)), xh = B.x0 + m * B.w, line = [];
        for (let i = 0; i <= 90; i += 1) { const x = (i / 90) * m; line.push([B.x0 + x * B.w, TRACK[1] - 0.09 * B.h - AMP * curve(x)]); }
        put(live, { points: pts(line) });
        put(head, { x1: xh, y1: TRACK[1] - 0.2 * B.h, x2: xh, y2: TRACK[1] + 8 * U, opacity: m < 1 ? 1 : 0.3 });
        put(rec, { cx: xh, cy: TRACK[1] - 0.2 * B.h, opacity: m < 1 ? (Math.sin(t * 9) > 0 ? 1 : 0.25) : 0 });
        $("#${id}-done").textContent = Math.round(m * 100) + "%";
      });
      tl.fromTo(["#${id}-row0", "#${id}-row1"], { opacity: 0, x: ${Math.round(-30 * f.u)} }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out", stagger: 0.15 }, 0.3);
      ${missing.length ? `TIMES.forEach((t, i) => { tl.to("#${id}-x" + i, { scaleX: 1, duration: 0.3, ease: "power2.out" }, t); tl.to("#${id}-chip" + i, { opacity: 0.55, duration: 0.3 }, t); });
      tl.to([gA, "#${id}-row0"], { opacity: 0.45, duration: 0.4 }, TIMES[TIMES.length - 1] + 0.2);` : ''}`,
    })
  },

  people(scene) {
    const { id, data, land, marks, f } = scene
    const groups = list(data.groups, 2, 5, `${id}: data.groups — от 2 до 5 подписей.`)
    const n = groups.length
    const times = marks.length >= n ? marks.slice(0, n) : beats([], n, 0.45, Math.max(1.5, land + 0.25))
    const B = boxOf(f)
    const floor = Math.round(B.y1 - 0.2 * B.h)
    const heights = { 2: [0.6, 1], 3: [0.55, 0.78, 1], 4: [0.52, 0.76, 1, 0.93], 5: [0.45, 0.62, 0.8, 1, 0.92] }[n]
    const kinds = { 2: ['jump', 'idle'], 3: ['jump', 'wave', 'idle'], 4: ['jump', 'wave', 'idle', 'lean'], 5: ['jump', 'wave', 'idle', 'idle', 'lean'] }[n]
    const total = String(data.total ?? '').trim()
    const xs = groups.map((_, i) => Math.round(B.x0 + ((i + 0.5) / n) * B.w))
    return visual(scene, {
      seed: 83,
      rig: true,
      css: `
        #${id} .vz-tag { transform: translateX(-50%); top: ${floor + Math.round(24 * f.u)}px; opacity: 0; }
        #${id} .vz-total { position: absolute; left: 0; right: 0; top: ${floor + Math.round(84 * f.u)}px; text-align: center; font-size: ${fit(total, 46 * f.u, B.w, 1, 0.5, UPPER)}px; font-weight: 800; text-transform: uppercase; color: ${f.accent}; opacity: 0; }`,
      body: groups.map((group, i) => `<div class="vz-label vz-tag" id="${id}-g${i}" style="left:${xs[i]}px">${escapeHtml(group)}</div>`).join('') + (total ? `<div class="vz-total" id="${id}-total">${escapeHtml(total)}</div>` : ''),
      script: `
      const TIMES = ${js(times)}, H = ${js(heights)}, KIND = ${js(kinds)}, XS = ${js(xs)}, FL = ${floor}, HT = 0.5 * B.h;
      const arc = mk("path", { d: "M" + B.x0 + " " + FL + " A" + B.w / 2 + " " + 0.8 * B.h + " 0 0 1 " + B.x1 + " " + FL, stroke: AC, "stroke-opacity": 0.4, "stroke-width": 2.5 * U, pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, svg);
      tl.to(arc, { strokeDashoffset: 0, duration: 1, ease: "power2.out" }, 0.2);
      mk("line", { x1: B.x0, y1: FL, x2: B.x1, y2: FL, stroke: INK, "stroke-opacity": 0.25, "stroke-width": 2 * U }, svg);
      const STARS = []; while (STARS.length < 46) { const x = rand() * 2 - 1, y = rand(); if (x * x + y * y < 0.85 && y > 0.45) STARS.push({ x: B.cx + (x * B.w) / 2, y: FL - y * 0.8 * B.h, r: (1 + rand() * 2.2) * U, k: rand() * 6 }); }
      const stars = STARS.map(s => mk("circle", { cx: s.x, cy: s.y, r: s.r, fill: INK }, svg));
      const figs = H.map(() => figure(svg, {}));
      clock(t => {
        const lit = inOut(ramp(t, LAND, 0.45));
        stars.forEach((el, i) => put(el, { opacity: ramp(t, 0.4, 0.6) * (0.2 + 0.25 * (0.5 + 0.5 * Math.sin(t * 2 + STARS[i].k)) + 0.45 * lit) }));
        figs.forEach((fig, i) => { const a = out(ramp(t, TIMES[i], 0.55)); fig.draw(pose(KIND[i], t, i * 1.3), XS[i], FL + (1 - a) * 0.12 * B.h, H[i] * HT, mix(INK, AC, lit), { width: 0.085, head: 0.09, bones: a }); });
      });
      TIMES.forEach((t, i) => tl.fromTo("#${id}-g" + i, { opacity: 0, y: ${Math.round(10 * f.u)} }, { opacity: 1, y: 0, duration: 0.4 }, t + 0.1));
      tl.to("#${id} .vz-tag", { color: AC, duration: 0.4 }, LAND);
      ${total ? `tl.fromTo("#${id}-total", { opacity: 0, scale: 1.2 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" }, LAND + 0.1);` : ''}`,
    })
  },

  dots(scene) {
    const { id, data, marks, duration, f } = scene
    const items = (Array.isArray(data.items) ? data.items : []).map(item => (typeof item === 'string' ? { label: item } : item ?? {})).filter(item => String(item.label ?? '').trim())
    if (items.length < 1 || items.length > 3) throw new MotionError('insert_invalid', `${id}: data.items — от 1 до 3 выделенных точек.`)
    const total = Math.max(12, Math.min(80, Math.round(Number(data.total) || 40)))
    const times = beats(marks, items.length + 1, 0.6, duration)
    const B = boxOf(f)
    const cols = 8
    const rows = Math.ceil(total / cols)
    const sp = Math.round(Math.min(B.w / cols, (0.5 * B.h) / rows))
    const gridTop = Math.round(B.y0 + 0.05 * B.h)
    const cardTop = Math.round(gridTop + rows * sp + 0.07 * B.h)
    const cardW = Math.round(B.w / items.length)
    const centers = items.map((_, i) => Math.round(B.x0 + cardW * (i + 0.5)))
    const label = String(data.label ?? '').trim()
    return visual(scene, {
      seed: 97,
      css: `
        #${id} .vz-dcard { position: absolute; top: ${cardTop}px; width: ${cardW}px; text-align: center; opacity: 0; }
        #${id} .vz-dcard b { display: block; font-size: ${Math.min(...items.map(item => fit(item.label, 34 * f.u, cardW - 20 * f.u, 2, 0.6, UPPER)))}px; font-weight: 800; text-transform: uppercase; line-height: 1.05; }
        #${id} .vz-dcard i { display: block; font-style: normal; margin-top: ${Math.round(10 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.16em; text-transform: uppercase; color: ${f.accent}; }`,
      body: items.map((item, i) => `<div class="vz-dcard" id="${id}-c${i}" style="left:${centers[i] - cardW / 2}px"><b>${escapeHtml(item.label)}</b>${item.note ? `<i>${escapeHtml(item.note)}</i>` : ''}</div>`).join('') + (label ? `<div class="vz-label" id="${id}-what" style="left:0;right:0;text-align:center;top:${gridTop - Math.round(40 * f.u)}px;opacity:0">${escapeHtml(label)}</div>` : ''),
      script: `
      const TIMES = ${js(times)}, NT = ${total}, COLS = ${cols}, ROWS = ${rows}, SP = ${sp}, GX = B.cx - ((COLS - 1) * SP) / 2, GY = ${gridTop} + SP / 2, CARD = ${js(centers)}, CT = ${cardTop}, K = CARD.length;
      const pos = i => [GX + (i % COLS) * SP, GY + Math.floor(i / COLS) * SP];
      const delay = Array.from({ length: NT }, () => rand() * 0.6);
      // The few: away from the edges and apart from each other.
      const chosen = [];
      for (let tries = 0; chosen.length < K && tries < 2000; tries += 1) {
        const c = 1 + Math.floor(rand() * (COLS - 2)), r = ROWS > 2 ? 1 + Math.floor(rand() * (ROWS - 2)) : Math.floor(rand() * ROWS), i = r * COLS + c, far = tries > 1000 ? 0 : 2;
        if (i < NT && !chosen.includes(i) && chosen.every(j => Math.abs((j % COLS) - c) + Math.abs(Math.floor(j / COLS) - r) > far)) chosen.push(i);
      }
      chosen.sort((a, b) => (a % COLS) - (b % COLS));
      const leaders = chosen.map(() => mk("line", { stroke: AC, "stroke-width": 2 * U, "stroke-opacity": 0.7, pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1 }, svg));
      const link = mk("polyline", { stroke: AC, "stroke-width": 3 * U, "stroke-dasharray": (10 * U) + " " + (10 * U), opacity: 0 }, svg);
      const dots = Array.from({ length: NT }, (_, i) => mk("circle", { cx: pos(i)[0], cy: pos(i)[1], fill: INK }, svg));
      const halos = chosen.map(() => mk("circle", { stroke: AC, "stroke-width": 3 * U, opacity: 0 }, svg));
      clock(t => {
        dots.forEach((el, i) => {
          const k = chosen.indexOf(i), grow = pop(ramp(t, 0.3 + i * 0.012, 0.35)), gone = k >= 0 ? 0 : ramp(t, TIMES[0] + delay[i], 0.35), lit = k >= 0 ? ramp(t, TIMES[k + 1], 0.25) : 0;
          put(el, { r: 0.2 * SP * grow * (1 + 0.6 * pop(lit)), fill: lit > 0 ? AC : INK, opacity: lerp(0.75, 0.07, gone) });
        });
        chosen.forEach((i, k) => { const age = t - TIMES[k + 1], p = pos(i); put(halos[k], { cx: p[0], cy: p[1], r: (0.35 + 0.9 * clamp(age / 0.8)) * SP, opacity: age > 0 && age < 0.8 ? 1 - age / 0.8 : 0 }); });
        if (K > 1) put(link, { points: pts(chosen.map(pos)), opacity: ramp(t, TIMES[K] + 0.2, 0.3), "stroke-dashoffset": -t * 40 * U });
      });
      chosen.forEach((i, k) => { const p = pos(i); put(leaders[k], { x1: p[0], y1: p[1] + 0.3 * SP, x2: CARD[k], y2: CT - 14 * U }); tl.to(leaders[k], { strokeDashoffset: 0, duration: 0.35 }, TIMES[k + 1]); tl.fromTo("#${id}-c" + k, { opacity: 0, y: 14 * U }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }, TIMES[k + 1] + 0.1); });
      ${label ? `tl.to("#${id}-what", { opacity: 1, duration: 0.4 }, 0.4);` : ''}`,
    })
  },

  cast(scene) {
    const { id, data, marks, duration, f } = scene
    const traits = Array.isArray(data.traits) && data.traits.length === 3 ? data.traits.map(String) : ['характер', 'размер', 'поведение']
    const times = beats(marks, 3, 0.5, duration)
    const B = boxOf(f)
    const accent = hex6(f.accent, DEFAULT_COLORS.accent)
    const ink = hex6(f.ink, DEFAULT_COLORS.ink)
    const ground = hex6(f.ground, DEFAULT_COLORS.ground)
    return visual(scene, {
      seed: 101,
      rig: true,
      body: chips(id, traits, Math.round(B.y1 - 0.075 * B.h)),
      script: `
      const TIMES = ${js(times)}, FL = B.y1 - 0.2 * B.h, BH = 0.4 * B.h, COLORS = ${js([accent, ink, mixHex(accent, ground, 0.35)])}, GRAY = ${js(mixHex(ink, ground, 0.5))};
      const XS = [-0.31, 0, 0.31].map(k => B.cx + k * B.w), SIZE = [0.72, 1.28, 0.95], WIDTH = [0.12, 0.065, 0.09], HEAD = [0.16, 0.11, 0.13], KIND = ["jump", "walk", "dance"];
      mk("line", { x1: B.x0, y1: FL, x2: B.x1, y2: FL, stroke: INK, "stroke-opacity": 0.25, "stroke-width": 2 * U }, svg);
      const shadows = XS.map(() => mk("ellipse", { fill: INK, opacity: 0.08 }, svg));
      const figs = XS.map(() => figure(svg, {}));
      const faces = XS.map(() => ({ eyes: [0, 1].map(() => mk("circle", { fill: GR }, svg)), brows: [0, 1].map(() => mk("path", { stroke: GR, "stroke-linecap": "round" }, svg)), mouth: mk("path", { stroke: GR, "stroke-linecap": "round" }, svg) }));
      clock(t => {
        const face = ramp(t, TIMES[0], 0.35), size = inOut(ramp(t, TIMES[1], 0.6)), act = inOut(ramp(t, TIMES[2], 0.5));
        figs.forEach((fig, i) => {
          const h = BH * lerp(1, SIZE[i], size), seen = ramp(t, 0.3 + i * 0.1, 0.4);
          const P = mixPose(pose("idle", t, i * 1.4), pose(KIND[i], t, i * 1.1), act);
          const [hx, hy, r] = fig.draw(P, XS[i], FL, h, mix(GRAY, COLORS[i], face), { width: lerp(0.08, WIDTH[i], size), head: lerp(0.12, HEAD[i], size), bones: seen });
          put(shadows[i], { cx: XS[i], cy: FL, rx: 0.16 * h, ry: 0.03 * h });
          const F = faces[i], o = face * seen;
          // Happy arcs, angry brows over small eyes, surprised wide eyes.
          [-1, 1].forEach((s, e) => {
            const ex = hx + s * 0.36 * r, ey = hy - 0.05 * r;
            if (i === 0) { put(F.eyes[e], { cx: ex, cy: ey, r: 0, opacity: 0 }); put(F.brows[e], { d: "M" + (ex - 0.2 * r) + " " + (ey + 0.06 * r) + " Q" + ex + " " + (ey - 0.24 * r) + " " + (ex + 0.2 * r) + " " + (ey + 0.06 * r), "stroke-width": 0.1 * r, opacity: o }); }
            else if (i === 1) { put(F.eyes[e], { cx: ex, cy: ey + 0.05 * r, r: 0.1 * r, opacity: o }); put(F.brows[e], { d: "M" + (ex - 0.22 * r) + " " + (ey - 0.2 * r + s * 0.08 * r) + " L" + (ex + 0.22 * r) + " " + (ey - 0.2 * r - s * 0.08 * r), "stroke-width": 0.09 * r, opacity: o }); }
            else { put(F.eyes[e], { cx: ex, cy: ey, r: 0.15 * r, opacity: o }); put(F.brows[e], { d: "M" + (ex - 0.16 * r) + " " + (ey - 0.32 * r) + " Q" + ex + " " + (ey - 0.42 * r) + " " + (ex + 0.16 * r) + " " + (ey - 0.32 * r), "stroke-width": 0.07 * r, opacity: o }); }
          });
          const mouth = i === 0 ? "M" + (hx - 0.28 * r) + " " + (hy + 0.3 * r) + " Q" + hx + " " + (hy + 0.58 * r) + " " + (hx + 0.28 * r) + " " + (hy + 0.3 * r)
            : i === 1 ? "M" + (hx - 0.22 * r) + " " + (hy + 0.42 * r) + " L" + (hx + 0.22 * r) + " " + (hy + 0.42 * r)
            : "M" + (hx - 0.1 * r) + " " + (hy + 0.42 * r) + " A" + 0.1 * r + " " + 0.13 * r + " 0 1 0 " + (hx + 0.1 * r) + " " + (hy + 0.42 * r) + " A" + 0.1 * r + " " + 0.13 * r + " 0 1 0 " + (hx - 0.1 * r) + " " + (hy + 0.42 * r);
          put(F.mouth, { d: mouth, "stroke-width": 0.09 * r, opacity: o });
        });
      });
      TIMES.forEach((t, i) => chipOn(i, t));`,
    })
  },

  crowd(scene) {
    const { id, data, f } = scene
    const label = String(data.label ?? '').trim()
    const note = String(data.note ?? '').trim()
    return visual(scene, {
      seed: 113,
      rig: true,
      css: `
        #${id} .vz-found { position: absolute; transform: translate(-50%, -100%); text-align: center; white-space: nowrap; opacity: 0; padding: ${Math.round(14 * f.u)}px ${Math.round(22 * f.u)}px; border-radius: ${Math.round(14 * f.u)}px; background: color-mix(in srgb, ${f.ground} 88%, transparent); border: ${Math.max(1, Math.round(2 * f.u))}px solid color-mix(in srgb, ${f.accent} 60%, transparent); }
        #${id} .vz-found b { display: block; font-size: ${Math.round(40 * f.u)}px; font-weight: 800; text-transform: uppercase; line-height: 1; color: ${f.accent}; }
        #${id} .vz-found i { display: block; font-style: normal; margin-top: ${Math.round(8 * f.u)}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(20 * f.u)}px; letter-spacing: 0.16em; text-transform: uppercase; }`,
      body: label || note ? `<div class="vz-found" id="${id}-found">${label ? `<b>${escapeHtml(label)}</b>` : ''}${note ? `<i>${escapeHtml(note)}</i>` : ''}</div>` : '',
      script: `
      const rows = [];
      for (let r = 0; r < 5; r += 1) {
        const s = 0.42 + 0.145 * r, y = B.y0 + 0.33 * B.h + r * 0.115 * B.h, n = Math.round(13 - 1.6 * r), row = [];
        for (let k = 0; k < n; k += 1) row.push({ x: B.x0 + ((k + 0.5 + (rand() - 0.5) * 0.5) / n) * B.w, y: y + (rand() - 0.5) * 0.02 * B.h, h: 0.24 * B.h * s * (0.9 + rand() * 0.2), kind: rand() < 0.18 ? "walk" : "idle", k: rand() * 6, color: mix(GR, INK, 0.22 + 0.13 * r) });
        rows.push(row);
      }
      const people = rows.flat(), aimX = B.cx + 0.18 * B.w;
      const target = rows[1].reduce((best, p) => (Math.abs(p.x - aimX) < Math.abs(best.x - aimX) ? p : best));
      const figs = people.map(() => figure(svg, {}));
      svg.appendChild(figs[people.indexOf(target)].g);
      const lens = mk("g", { opacity: 0 }, svg);
      const glass = mk("circle", { fill: INK, "fill-opacity": 0.05, stroke: INK, "stroke-width": 5 * U }, lens), handle = mk("line", { stroke: INK, "stroke-width": 12 * U, "stroke-linecap": "round" }, lens);
      const LR = 0.12 * B.S, AIM = [target.x, target.y - target.h * 0.55];
      clock(t => {
        const found = pop(ramp(t, LAND, 0.4)), danced = t >= LAND;
        people.forEach((p, i) => {
          const me = p === target, grow = me ? lerp(1, 1.9, found) : 1;
          figs[i].draw(pose(me && danced ? "dance" : p.kind, t, p.k), p.x, p.y + (grow - 1) * p.h * 0.45, p.h * grow, me && danced ? AC : p.color, { width: 0.09, head: 0.09, bones: ramp(t, 0.25 + i * 0.008, 0.3) });
        });
        const settle = inOut(ramp(t, LAND - 0.6, 0.55)), wander = [B.cx + 0.3 * B.w * Math.sin(1.1 * t + 0.4), B.y0 + 0.5 * B.h + 0.1 * B.h * Math.sin(1.7 * t)];
        const c = [lerp(wander[0], AIM[0], settle), lerp(wander[1], AIM[1], settle)], r = LR * lerp(1, 1.25, found);
        put(glass, { cx: c[0], cy: c[1], r: r }); put(handle, { x1: c[0] + r * 0.72, y1: c[1] + r * 0.72, x2: c[0] + r * 1.35, y2: c[1] + r * 1.35 });
        put(lens, { opacity: ramp(t, 0.35, 0.35) });
        const tag = $("#${id}-found");
        if (tag) { const half = tag.offsetWidth / 2; tag.style.left = Math.max(PAD + half, Math.min(FW - PAD - half, c[0])) + "px"; tag.style.top = (c[1] - r - 16 * U) + "px"; }
      });
      ${label || note ? `tl.fromTo("#${id}-found", { opacity: 0, y: ${Math.round(12 * f.u)} }, { opacity: 1, y: 0, duration: 0.4, ease: "expo.out" }, LAND + 0.15);` : ''}`,
    })
  },
}
