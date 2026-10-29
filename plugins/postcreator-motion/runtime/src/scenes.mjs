/**
 * Insert scene templates: full-frame infographic cut-ins for a talking head.
 *
 * Every template takes data plus scene-local times (`land` — when the main
 * element arrives, `marks` — one per step or item) and returns a HyperFrames
 * sub-composition. All of them share one look: the project's ground, ink and
 * accent, an iris in and out, a HUD with the scene number and topic, and text
 * kept inside the band social apps leave free (200–1330 px on a vertical).
 */
import { escapeHtml, fit, js, MONO_UPPER, UPPER } from './markup.mjs'
import { MotionError } from './tools.mjs'
import { sceneFragment, VISUAL_BUILDERS, VISUALS } from './visuals.mjs'

export { escapeHtml }

const TEXT_TEMPLATES = {
  stat: {
    summary: 'Одно большое число докручивается до значения: рост, юбилей, KPI.',
    sound: { land: 'boom' },
    data: { value: 'число (обязательно)', prefix: 'строка перед числом', suffix: 'строка после: %, ×, ₽', decimals: 'знаков после запятой', from: 'с какого числа докручивать (по умолчанию 0, для года — на 100 меньше)', year: 'true — это год (без пробела в разрядах, докрутка за 100 лет); по умолчанию — если в label/kicker есть «год»', plain: 'true — без пробела между разрядами', label: 'подпись под числом', kicker: 'строка сверху' },
  },
  steps: {
    summary: 'Процесс из 2–4 этапов: каждый этап появляется на своём слове (marks).',
    sound: { ticks: true },
    data: { title: 'заголовок', steps: 'массив из 2–4 коротких строк' },
  },
  compare: {
    summary: 'Было → стало: два столбца, второй вырастает на слове land, бейдж разницы.',
    sound: { land: 'boom' },
    data: { title: 'заголовок', before: '{label, value}', after: '{label, value}', unit: 'единица' },
  },
  title: {
    summary: 'Кинетический заголовок: слова выезжают из маски, выделенное слово загорается на land. Только когда показать нечего.',
    sound: { land: 'chime' },
    data: { kicker: 'строка сверху', text: 'фраза до 60 символов', highlight: 'слово из text для акцента' },
  },
  list: {
    summary: 'Перечень из 2–5 пунктов, каждый на своём слове (marks).',
    sound: { ticks: true },
    data: { title: 'заголовок', items: 'массив из 2–5 строк' },
  },
}

/** Visuals first: an insert should show what is said, text cards are the fallback. */
export const TEMPLATES = { ...VISUALS, ...TEXT_TEMPLATES }

function frameOf(project) {
  const { width: W, height: H } = project
  const u = Math.min(W, H) / 1080
  const portrait = H > W
  // Text band: social UI covers the top and bottom of a vertical frame.
  const top = portrait ? Math.round(H * 0.105) : Math.round(H * 0.09)
  const bottom = portrait ? Math.round(H * 0.69) : Math.round(H * 0.88)
  const { accent, ground, ink } = project.style
  return { W, H, u, portrait, top, bottom, accent, ground, ink, cx: Math.round(W / 2), cy: Math.round(portrait ? H * 0.42 : H * 0.5), pad: Math.round(W * (portrait ? 0.067 : 0.06)) }
}

function shell({ id, project, index, topic, css, body, script, duration, card = false, hud: showHud = true }) {
  const f = frameOf(project)
  const { ground, ink, accent, brand } = project.style
  const hud = Math.round(22 * f.u)
  const radius = Math.ceil(Math.hypot(f.W, f.H))
  return `<template>
  <style>
    #${id}-root { position: absolute; inset: 0; overflow: hidden; color: ${ink}; font-family: "Inter", sans-serif; }
    #${id}-stage { position: absolute; inset: 0; background: radial-gradient(80% 50% at 50% ${Math.round((f.cy / f.H) * 100)}%, color-mix(in srgb, ${accent} 10%, ${ground}) 0%, ${ground} 62%, #000 100%); }
    #${id}-content { position: absolute; inset: 0; transform-origin: ${f.cx}px ${f.cy}px; }
    #${id} .hud { position: absolute; top: ${f.top}px; font-family: "JetBrains Mono", monospace; font-size: ${hud}px; letter-spacing: 0.22em; text-transform: uppercase; color: color-mix(in srgb, ${ink} 55%, transparent); white-space: nowrap; }
    #${id} .hud b { color: ${accent}; font-weight: 500; }
    #${id} .mask { display: block; overflow: hidden; padding: 0.04em 0 0.1em; }
    #${id} .rise { display: inline-block; }
    #${id} .accent { color: ${accent}; }
    ${css(f)}
  </style>
  <div id="${id}-root" data-composition-id="${id}" data-width="${f.W}" data-height="${f.H}">
    <div id="${id}" style="position:absolute;inset:0">
      <div id="${id}-stage">
        <svg data-layout-ignore viewBox="0 0 ${f.W} ${f.H}" style="position:absolute;inset:0;width:${f.W}px;height:${f.H}px" fill="none">
          <circle cx="${f.cx}" cy="${Math.round(f.H * (f.portrait ? 1.02 : 1.35))}" r="${Math.round(f.W * 0.95)}" stroke="color-mix(in srgb, ${accent} 24%, transparent)" stroke-width="${2 * f.u}"/>
          <circle cx="${f.cx}" cy="${Math.round(f.H * (f.portrait ? 1.06 : 1.4))}" r="${Math.round(f.W * 0.8)}" stroke="color-mix(in srgb, ${ink} 12%, transparent)" stroke-width="${1.5 * f.u}" stroke-dasharray="${4 * f.u} ${10 * f.u}"/>
        </svg>
        <div id="${id}-content">${body(f)}</div>
        ${card || !showHud ? '' : `<div class="hud" style="left:${f.pad}px"><b>${String(index).padStart(2, '0')}</b> &nbsp;/&nbsp; ${escapeHtml(topic)}</div>
        ${brand ? `<div class="hud" style="right:${f.pad}px">${escapeHtml(brand)}</div>` : ''}`}
      </div>
      <svg data-layout-ignore viewBox="0 0 ${f.W} ${f.H}" style="position:absolute;inset:0;width:${f.W}px;height:${f.H}px" fill="none">
        <circle id="${id}-ring" cx="${f.cx}" cy="${f.cy}" r="0" stroke="${accent}" stroke-width="${3 * f.u}"/>
      </svg>
    </div>
  </div>
  <script>
    (function () {
      const DUR = ${duration};
      const tl = gsap.timeline({ paused: true });
      ${card ? '// A card flies in as a whole: no iris inside it.' : `tl.fromTo("#${id}-stage", { clipPath: "circle(0px at ${f.cx}px ${f.cy}px)" }, { clipPath: "circle(${radius}px at ${f.cx}px ${f.cy}px)", duration: 0.65, ease: "expo.out" }, 0);
      tl.fromTo("#${id}-ring", { attr: { r: 0 }, opacity: 1 }, { attr: { r: ${radius} }, duration: 0.65, ease: "expo.out" }, 0);
      tl.to("#${id}-ring", { opacity: 0, duration: 0.3 }, 0.3);`}
      tl.fromTo("#${id}-content", { scale: 1.12 }, { scale: 1, duration: 1.1, ease: "expo.out" }, 0);
      ${card || !showHud ? '' : `tl.fromTo("#${id} .hud", { opacity: 0 }, { opacity: 1, duration: 0.3, stagger: 0.06 }, 0.2);`}
      ${script(f)}
      tl.to("#${id}-content", { scale: 0.88, duration: 0.42, ease: "power3.in" }, DUR - 0.46);
      ${card ? '' : `tl.fromTo("#${id}-stage", { clipPath: "circle(${radius}px at ${f.cx}px ${f.cy}px)" }, { clipPath: "circle(0px at ${f.cx}px ${f.cy}px)", duration: 0.42, ease: "power3.in", immediateRender: false }, DUR - 0.46);
      tl.fromTo("#${id}-ring", { attr: { r: ${radius} }, opacity: 0 }, { attr: { r: 0 }, opacity: 1, duration: 0.42, ease: "power3.in", immediateRender: false }, DUR - 0.46);
      tl.set("#${id}-ring", { opacity: 0 }, DUR - 0.03);`}
      window.__timelines[${js(id)}] = tl;
    })();
  </script>
</template>
`
}

function formatNumber(value, decimals, plain = false) {
  if (plain) return Number(value).toFixed(decimals)
  return Number(value).toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/**
 * A year reads as 1923, not «1 923», and counts up from a century before. A
 * number in that range is a year only when the card says so (`year: true`, or
 * «год»/«year» in its label or kicker): 1500 clients still count from zero.
 */
export function isYearLike(value, data = {}) {
  if (!Number.isInteger(value) || value < 1000 || value > 2100 || data.prefix || data.suffix || data.decimals) return false
  if (typeof data.year === 'boolean') return data.year
  return /(^|[^\p{L}])(год|года|году|годом|year)([^\p{L}]|$)/iu.test(`${data.label ?? ''} ${data.kicker ?? ''}`)
}

const BUILDERS = {
  ...VISUAL_BUILDERS,
  stat({ id, data, land, f }) {
    const value = Number(data.value)
    if (!Number.isFinite(value)) throw new MotionError('insert_invalid', `${id}: data.value должно быть числом.`)
    const decimals = Math.max(0, Math.min(3, Number(data.decimals ?? (Number.isInteger(value) ? 0 : 1))))
    const year = isYearLike(value, data)
    const plain = data.plain ?? year
    const from = Number.isFinite(Number(data.from)) && data.from !== null && data.from !== '' ? Number(data.from) : year ? value - 100 : 0
    const shown = `${data.prefix ?? ''}${formatNumber(value, decimals, plain)}${data.suffix ?? ''}`
    const size = fit(shown, 250 * f.u, f.W - 2 * f.pad, 1, 0.4)
    const r = Math.round(f.W * (f.portrait ? 0.39 : 0.2))
    const ticks = 72
    return {
      css: () => `
        #${id} .stat-num { position: absolute; left: 0; right: 0; top: ${f.cy - size * 0.55}px; text-align: center; font-size: ${size}px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
        #${id} .stat-label { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.cy + r + 40 * f.u}px; text-align: center; font-family: "JetBrains Mono", monospace; font-size: ${fit(data.label ?? '', 30 * f.u, f.W - 2 * f.pad, 2, 0.45, MONO_UPPER)}px; letter-spacing: 0.24em; text-transform: uppercase; color: color-mix(in srgb, currentColor 80%, transparent); }
        #${id} .stat-kicker { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.cy - r - 110 * f.u}px; text-align: center; font-size: ${fit(data.kicker ?? '', 46 * f.u, f.W - 2 * f.pad, 2, 0.45, UPPER)}px; font-weight: 700; text-transform: uppercase; }`,
      body: () => `
        <svg data-layout-ignore viewBox="0 0 ${f.W} ${f.H}" style="position:absolute;inset:0;width:${f.W}px;height:${f.H}px" fill="none">
          <g id="${id}-ticks" stroke-linecap="round">${Array.from({ length: ticks }, (_, i) => {
            const a = -Math.PI / 2 + (i / ticks) * Math.PI * 2
            const big = i % 6 === 0
            const r0 = r - 30 * f.u
            const r1 = r + (big ? 18 : 4) * f.u
            return `<line x1="${(f.cx + Math.cos(a) * r0).toFixed(1)}" y1="${(f.cy + Math.sin(a) * r0).toFixed(1)}" x2="${(f.cx + Math.cos(a) * r1).toFixed(1)}" y2="${(f.cy + Math.sin(a) * r1).toFixed(1)}" stroke="${big ? f.accent : f.ink}" stroke-opacity="${big ? 1 : 0.55}" stroke-width="${(big ? 5 : 3) * f.u}"/>`
          }).join('')}</g>
        </svg>
        ${data.kicker ? `<div class="stat-kicker"><span class="mask"><span class="rise">${escapeHtml(data.kicker)}</span></span></div>` : ''}
        <div class="stat-num" id="${id}-num">${escapeHtml(`${data.prefix ?? ''}${formatNumber(from, decimals, plain)}${data.suffix ?? ''}`)}</div>
        ${data.label ? `<div class="stat-label" id="${id}-label">${escapeHtml(data.label)}</div>` : ''}`,
      script: () => `
      const counter = { v: ${from} };
      const num = document.getElementById(${js(`${id}-num`)});
      const fmt = v => ${js(data.prefix ?? '')} + ${plain ? `v.toFixed(${decimals})` : `v.toLocaleString("ru-RU", { minimumFractionDigits: ${decimals}, maximumFractionDigits: ${decimals} })`} + ${js(data.suffix ?? '')};
      tl.fromTo("#${id}-ticks line", { opacity: 0 }, { opacity: 1, duration: 0.25, stagger: 0.008 }, 0.1);
      tl.fromTo(counter, { v: ${from} }, { v: ${value}, duration: Math.max(0.5, ${land} - 0.15), ease: "expo.out", onUpdate: () => { num.textContent = fmt(counter.v); } }, 0.15);
      tl.fromTo("#${id}-num", { opacity: 0 }, { opacity: 1, duration: 0.15 }, 0.15);
      tl.to("#${id}-num", { color: ${js(f.accent)}, duration: 0.25 }, ${land});
      tl.fromTo("#${id}-num", { scale: 1 }, { scale: 1.06, duration: 0.12, yoyo: true, repeat: 1, ease: "power2.out" }, ${land});
      ${data.label ? `tl.fromTo("#${id}-label", { opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out" }, ${land} + 0.1);` : ''}
      ${data.kicker ? `tl.fromTo("#${id} .stat-kicker .rise", { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: "expo.out" }, 0.35);` : ''}`,
    }
  },

  steps({ id, data, land, marks, f }) {
    const steps = Array.isArray(data.steps) ? data.steps.map(String).slice(0, 4) : []
    if (steps.length < 2) throw new MotionError('insert_invalid', `${id}: data.steps — от 2 до 4 этапов.`)
    const times = steps.map((_, i) => marks[i] ?? land + i * 0.55)
    const rowH = Math.round((f.bottom - f.top - 260 * f.u) / steps.length)
    const y0 = f.top + 200 * f.u
    const chip = Math.round(Math.min(rowH * 0.62, 120 * f.u))
    return {
      css: () => `
        #${id} .st-title { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top + 70 * f.u}px; font-size: ${fit(data.title ?? '', 54 * f.u, f.W - 2 * f.pad, 2, 0.45, UPPER)}px; font-weight: 800; text-transform: uppercase; line-height: 1.05; }
        #${id} .st-row { position: absolute; left: ${f.pad}px; right: ${f.pad}px; height: ${chip}px; display: flex; align-items: center; gap: ${28 * f.u}px; }
        #${id} .st-dot { flex: none; width: ${chip}px; height: ${chip}px; border-radius: 50%; border: ${3 * f.u}px solid currentColor; display: grid; place-items: center; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(chip * 0.36)}px; }
        #${id} .st-text { font-size: ${Math.round(Math.min(chip * 0.5, 58 * f.u))}px; font-weight: 700; line-height: 1.1; }`,
      body: () => `
        ${data.title ? `<div class="st-title"><span class="mask"><span class="rise">${escapeHtml(data.title)}</span></span></div>` : ''}
        <svg data-layout-ignore viewBox="0 0 ${f.W} ${f.H}" style="position:absolute;inset:0;width:${f.W}px;height:${f.H}px" fill="none">
          <line id="${id}-rail" x1="${f.pad + chip / 2}" y1="${y0 + chip / 2}" x2="${f.pad + chip / 2}" y2="${y0 + (steps.length - 1) * rowH + chip / 2}" stroke="${f.accent}" stroke-width="${4 * f.u}" stroke-dasharray="${(steps.length - 1) * rowH}" stroke-dashoffset="${(steps.length - 1) * rowH}"/>
        </svg>
        ${steps.map((step, i) => `<div class="st-row" id="${id}-row-${i}" style="top:${Math.round(y0 + i * rowH)}px"><div class="st-dot">${i + 1}</div><div class="st-text">${escapeHtml(step)}</div></div>`).join('\n        ')}`,
      script: () => `
      ${data.title ? `tl.fromTo("#${id} .st-title .rise", { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: "expo.out" }, 0.3);` : ''}
      const times = ${js(times)};
      times.forEach((t, i) => {
        tl.fromTo("#${id}-row-" + i, { opacity: 0, x: ${-60 * f.u} }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, t - 0.15);
        tl.fromTo("#${id}-row-" + i + " .st-dot", { scale: 0.6 }, { scale: 1, duration: 0.4, ease: "back.out(2.2)" }, t - 0.1);
        tl.to("#${id}-row-" + i + " .st-dot", { backgroundColor: ${js(f.accent)}, borderColor: ${js(f.accent)}, color: ${js(f.ground)}, duration: 0.2 }, t);
        if (i > 0) tl.to("#${id}-rail", { attr: { "stroke-dashoffset": ${(steps.length - 1) * rowH} - i * ${rowH} }, duration: 0.45, ease: "power2.inOut" }, t - 0.4);
      });`,
    }
  },

  compare({ id, data, land, f }) {
    const before = Number(data.before?.value)
    const after = Number(data.after?.value)
    if (!Number.isFinite(before) || !Number.isFinite(after)) throw new MotionError('insert_invalid', `${id}: before.value и after.value должны быть числами.`)
    const max = Math.max(Math.abs(before), Math.abs(after), 1e-9)
    const barW = Math.round((f.W - 2 * f.pad) * 0.3)
    const baseY = f.bottom - 120 * f.u
    // Room above the tallest bar for its value and, above that, the badge.
    const maxH = Math.round(baseY - (f.top + 430 * f.u))
    const hB = Math.max(8, Math.round((Math.abs(before) / max) * maxH))
    const hA = Math.max(8, Math.round((Math.abs(after) / max) * maxH))
    const xB = Math.round(f.W / 2 - barW - 40 * f.u)
    const xA = Math.round(f.W / 2 + 40 * f.u)
    const ratio = before !== 0 ? after / before : null
    const badge = data.badge ?? (ratio && ratio >= 1.5 ? `×${formatNumber(ratio, ratio < 10 ? 1 : 0)}` : ratio ? `${ratio >= 1 ? '+' : ''}${formatNumber((ratio - 1) * 100, 0)}%` : '')
    const unit = data.unit ? ` ${data.unit}` : ''
    return {
      css: () => `
        #${id} .cp-title { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top + 70 * f.u}px; font-size: ${fit(data.title ?? '', 54 * f.u, f.W - 2 * f.pad, 2, 0.45, UPPER)}px; font-weight: 800; text-transform: uppercase; line-height: 1.05; }
        #${id} .cp-bar { position: absolute; width: ${barW}px; bottom: ${f.H - baseY}px; border-radius: ${10 * f.u}px ${10 * f.u}px 0 0; transform-origin: 50% 100%; }
        #${id} .cp-val { position: absolute; width: ${barW}px; text-align: center; font-size: ${Math.round(64 * f.u)}px; font-weight: 800; font-variant-numeric: tabular-nums; }
        #${id} .cp-lbl { position: absolute; width: ${barW + 80 * f.u}px; text-align: center; top: ${baseY + 24 * f.u}px; font-family: "JetBrains Mono", monospace; font-size: ${Math.round(24 * f.u)}px; letter-spacing: 0.18em; text-transform: uppercase; color: color-mix(in srgb, currentColor 70%, transparent); }
        #${id} .cp-badge { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top + 170 * f.u}px; text-align: center; font-size: ${fit(badge, 84 * f.u, f.W - 2 * f.pad, 1, 0.5)}px; font-weight: 800; line-height: 1.05; }`,
      body: () => `
        ${data.title ? `<div class="cp-title"><span class="mask"><span class="rise">${escapeHtml(data.title)}</span></span></div>` : ''}
        <div class="cp-bar" id="${id}-bar-b" style="left:${xB}px;height:${hB}px;background:color-mix(in srgb, currentColor 30%, transparent)"></div>
        <div class="cp-bar" id="${id}-bar-a" style="left:${xA}px;height:${hA}px;background:var(--pc-accent)"></div>
        <div class="cp-val" id="${id}-val-b" style="left:${xB}px;top:${baseY - hB - 90 * f.u}px">${escapeHtml(formatNumber(before, Number.isInteger(before) ? 0 : 1) + unit)}</div>
        <div class="cp-val accent" id="${id}-val-a" style="left:${xA}px;top:${baseY - hA - 90 * f.u}px">${escapeHtml(formatNumber(after, Number.isInteger(after) ? 0 : 1) + unit)}</div>
        <div class="cp-lbl" style="left:${xB - 40 * f.u}px">${escapeHtml(data.before?.label ?? '')}</div>
        <div class="cp-lbl" style="left:${xA - 40 * f.u}px">${escapeHtml(data.after?.label ?? '')}</div>
        ${badge ? `<div class="cp-badge accent" id="${id}-badge">${escapeHtml(badge)}</div>` : ''}`,
      script: () => `
      ${data.title ? `tl.fromTo("#${id} .cp-title .rise", { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: "expo.out" }, 0.3);` : ''}
      tl.fromTo("#${id} .cp-lbl", { opacity: 0 }, { opacity: 1, duration: 0.3, stagger: 0.1 }, 0.4);
      tl.fromTo("#${id}-bar-b", { scaleY: 0 }, { scaleY: 1, duration: 0.6, ease: "expo.out" }, 0.45);
      tl.fromTo("#${id}-val-b", { opacity: 0, y: ${20 * f.u} }, { opacity: 1, y: 0, duration: 0.4 }, 0.7);
      tl.fromTo("#${id}-bar-a", { scaleY: 0 }, { scaleY: 1, duration: 0.75, ease: "expo.out" }, ${land} - 0.35);
      tl.fromTo("#${id}-val-a", { opacity: 0, y: ${20 * f.u} }, { opacity: 1, y: 0, duration: 0.4 }, ${land});
      ${badge ? `tl.fromTo("#${id}-badge", { opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" }, ${land} + 0.15);` : ''}`,
    }
  },

  title({ id, data, land, f }) {
    const text = String(data.text ?? '').trim()
    if (!text) throw new MotionError('insert_invalid', `${id}: data.text обязателен.`)
    const words = text.split(/\s+/)
    const highlight = String(data.highlight ?? '').toLowerCase()
    const size = fit(text, 104 * f.u, f.W - 2 * f.pad, f.portrait ? 4 : 2, 0.4, UPPER)
    return {
      css: () => `
        #${id} .tt-wrap { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top}px; bottom: ${f.H - f.bottom}px; display: flex; flex-direction: column; justify-content: center; }
        #${id} .tt-kicker { font-family: "JetBrains Mono", monospace; font-size: ${Math.round(26 * f.u)}px; letter-spacing: 0.26em; text-transform: uppercase; margin-bottom: ${28 * f.u}px; color: var(--pc-accent); }
        #${id} .tt-text { font-size: ${size}px; font-weight: 800; line-height: 1.02; text-transform: uppercase; letter-spacing: -0.01em; }
        #${id} .tt-word { display: inline-block; overflow: hidden; vertical-align: top; padding: 0.04em 0.12em 0.1em 0; }
        #${id} .tt-word > span { display: inline-block; }`,
      body: () => `
        <div class="tt-wrap">
          ${data.kicker ? `<div class="tt-kicker">${escapeHtml(data.kicker)}</div>` : ''}
          <div class="tt-text">${words.map((word, i) => `<span class="tt-word"${highlight && word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').startsWith(highlight.replace(/[^\p{L}\p{N}]/gu, '')) ? ' data-hl="1"' : ''}><span id="${id}-w${i}">${escapeHtml(word)}</span></span>`).join(' ')}</div>
        </div>`,
      script: () => `
      ${data.kicker ? `tl.fromTo("#${id} .tt-kicker", { opacity: 0, x: ${-40 * f.u} }, { opacity: 1, x: 0, duration: 0.7, ease: "expo.out" }, 0.25);` : ''}
      const words = Array.from(document.querySelectorAll("#${id} .tt-word > span"));
      tl.fromTo(words, { yPercent: 110 }, { yPercent: 0, duration: 0.65, ease: "expo.out", stagger: Math.min(0.12, ${Math.max(0.2, land - 0.35)} / Math.max(1, words.length)) }, 0.3);
      tl.to("#${id} [data-hl]", { color: ${js(f.accent)}, duration: 0.25 }, ${land});
      // The mask scales with its word, so the punch never clips the letters.
      tl.fromTo("#${id} [data-hl]", { scale: 1 }, { scale: 1.08, duration: 0.14, yoyo: true, repeat: 1 }, ${land});`,
    }
  },

  list({ id, data, land, marks, f }) {
    const items = Array.isArray(data.items) ? data.items.map(String).slice(0, 5) : []
    if (items.length < 2) throw new MotionError('insert_invalid', `${id}: data.items — от 2 до 5 пунктов.`)
    const times = items.map((_, i) => marks[i] ?? land + i * 0.45)
    const rowH = Math.round((f.bottom - f.top - 240 * f.u) / items.length)
    const y0 = f.top + 200 * f.u
    const size = Math.round(Math.min(rowH * 0.42, 56 * f.u))
    return {
      css: () => `
        #${id} .ls-title { position: absolute; left: ${f.pad}px; right: ${f.pad}px; top: ${f.top + 70 * f.u}px; font-size: ${fit(data.title ?? '', 54 * f.u, f.W - 2 * f.pad, 2, 0.45, UPPER)}px; font-weight: 800; text-transform: uppercase; line-height: 1.05; }
        #${id} .ls-row { position: absolute; left: ${f.pad}px; right: ${f.pad}px; display: flex; align-items: baseline; gap: ${24 * f.u}px; border-top: ${2 * f.u}px solid color-mix(in srgb, currentColor 16%, transparent); padding-top: ${18 * f.u}px; }
        #${id} .ls-n { font-family: "JetBrains Mono", monospace; font-size: ${Math.round(size * 0.55)}px; color: var(--pc-accent); }
        #${id} .ls-t { font-size: ${size}px; font-weight: 700; line-height: 1.12; }`,
      body: () => `
        ${data.title ? `<div class="ls-title"><span class="mask"><span class="rise">${escapeHtml(data.title)}</span></span></div>` : ''}
        ${items.map((item, i) => `<div class="ls-row" id="${id}-item-${i}" style="top:${Math.round(y0 + i * rowH)}px"><span class="ls-n">${String(i + 1).padStart(2, '0')}</span><span class="ls-t">${escapeHtml(item)}</span></div>`).join('\n        ')}`,
      script: () => `
      ${data.title ? `tl.fromTo("#${id} .ls-title .rise", { yPercent: 110 }, { yPercent: 0, duration: 0.6, ease: "expo.out" }, 0.3);` : ''}
      ${js(times)}.forEach((t, i) => tl.fromTo("#${id}-item-" + i, { opacity: 0, x: ${80 * f.u}, filter: "blur(6px)" }, { opacity: 1, x: 0, filter: "blur(0px)", duration: 0.5, ease: "expo.out" }, t - 0.12));`,
    }
  },
}

/** Render one insert to a sub-composition file's HTML; `source` is the agent's own scene for "custom". */
export function renderScene(project, insert, source) {
  const builder = insert.template === 'custom' ? scene => sceneFragment(scene, source ?? '', insert.file) : BUILDERS[insert.template]
  if (!builder) throw new MotionError('template_unknown', `${insert.id}: шаблона ${insert.template} нет. Есть: ${Object.keys(BUILDERS).join(', ')}.`)
  // A card is its own small frame placed into the shot; the scene is laid out for that frame.
  if (insert.card) project = { ...project, width: insert.card.width, height: insert.card.height }
  const f = frameOf(project)
  const parts = builder({ id: insert.id, data: insert.data ?? {}, land: insert.land, marks: insert.marks ?? [], duration: insert.duration, f })
  const vars = `#${insert.id}-root { --pc-accent: ${project.style.accent}; --pc-ground: ${project.style.ground}; --pc-ink: ${project.style.ink}; }`
  return shell({
    id: insert.id,
    project,
    index: insert.index,
    topic: insert.topic ?? '',
    duration: insert.duration,
    css: frame => `${vars}${parts.css(frame)}`,
    body: parts.body,
    script: parts.script,
    card: Boolean(insert.card),
    hud: insert.data?.hud !== false,
  })
}
