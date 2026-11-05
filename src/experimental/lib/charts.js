/**
 * Experimental pages — dependency-free SVG charts.
 *
 * The existing app has its own chart helper (src/components/weeklyChart.js);
 * this is a separate, self-contained implementation so the experimental pages
 * share nothing with it.
 */

import { escapeHtml, formatCurrency, monthLabel, num } from './format.js'

const W = 640
const H = 210
const PAD = { top: 14, right: 14, bottom: 26, left: 62 }

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (min === max) {
    if (min === 0) return [0]
    const pad = Math.abs(min) * 0.2
    min -= pad
    max += pad
  }
  const span = max - min
  const rawStep = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)))
  const norm = rawStep / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks = []
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Number(v.toFixed(6)))
  return ticks
}

function compact(value) {
  const n = num(value)
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

/** Balance trend: single area + line series. */
export function lineChartSVG(series, options = {}) {
  const height = options.height || H
  const empty = `<div class="xp-note">No posted activity in this period to chart.</div>`
  if (!series || series.length === 0) return empty

  const values = series.map((p) => num(p.closing))
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values))
  const yMin = Math.min(...ticks)
  const yMax = Math.max(...ticks)
  const innerW = W - PAD.left - PAD.right
  const innerH = height - PAD.top - PAD.bottom

  const xAt = (i) =>
    series.length === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (series.length - 1)) * innerW
  const yAt = (v) => PAD.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH

  const linePts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
  const areaPts = `${PAD.left},${yAt(Math.max(yMin, 0)).toFixed(1)} ${linePts.join(
    ' '
  )} ${xAt(series.length - 1).toFixed(1)},${yAt(Math.max(yMin, 0)).toFixed(1)}`

  const grid = ticks
    .map((t) => {
      const y = yAt(t)
      const zero = Math.abs(t) < 1e-9
      return `
        <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"
              stroke="${zero ? 'var(--xp-border-strong)' : 'var(--xp-border)'}"
              stroke-width="${zero ? 1.2 : 1}" stroke-dasharray="${zero ? '' : '3 4'}" />
        <text x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
              font-size="10" fill="var(--xp-text-3)">${escapeHtml(compact(t))}</text>`
    })
    .join('')

  const labelEvery = Math.max(1, Math.ceil(series.length / 8))
  const xLabels = series
    .map((p, i) =>
      i % labelEvery === 0 || i === series.length - 1
        ? `<text x="${xAt(i).toFixed(1)}" y="${height - 8}" text-anchor="middle"
            font-size="10" fill="var(--xp-text-3)">${escapeHtml(monthLabel(p.month))}</text>`
        : ''
    )
    .join('')

  const dots = series
    .map(
      (p, i) =>
        `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(values[i]).toFixed(1)}" r="3"
           fill="var(--xp-accent)" stroke="var(--xp-surface)" stroke-width="1.5">
           <title>${escapeHtml(monthLabel(p.month))}: ${escapeHtml(formatCurrency(values[i]))}</title>
         </circle>`
    )
    .join('')

  const last = values[values.length - 1]
  const lastLabel = `<text x="${Math.min(W - PAD.right, xAt(series.length - 1) + 6).toFixed(1)}"
      y="${Math.max(12, yAt(last) - 8).toFixed(1)}" font-size="10.5" font-weight="700"
      fill="var(--xp-accent)" text-anchor="end">${escapeHtml(formatCurrency(last))}</text>`

  return `
    <svg class="xp-chart-svg" viewBox="0 0 ${W} ${height}" role="img"
         aria-label="Balance trend by month" preserveAspectRatio="none"
         style="height:${height}px">
      <defs>
        <linearGradient id="xpLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--xp-accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--xp-accent)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${grid}
      <polygon points="${areaPts}" fill="url(#xpLineFill)" />
      <polyline points="${linePts.join(' ')}" fill="none" stroke="var(--xp-accent)"
                stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${lastLabel}
      ${xLabels}
    </svg>`
}

/** Monthly credits vs debits: grouped bars. */
export function barChartSVG(series, options = {}) {
  const height = options.height || H
  if (!series || series.length === 0) {
    return `<div class="xp-note">No posted activity in this period to chart.</div>`
  }

  const values = series.flatMap((p) => [num(p.credits), num(p.debits)])
  const ticks = niceTicks(0, Math.max(...values, 1))
  const yMax = Math.max(...ticks)
  const innerW = W - PAD.left - PAD.right
  const innerH = height - PAD.top - PAD.bottom
  const groupW = innerW / series.length
  const barW = Math.max(3, Math.min(22, groupW / 2.8))

  const yAt = (v) => PAD.top + innerH - (v / (yMax || 1)) * innerH

  const grid = ticks
    .map((t) => {
      const y = yAt(t)
      return `
        <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"
              stroke="var(--xp-border)" stroke-width="1" stroke-dasharray="3 4" />
        <text x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end"
              font-size="10" fill="var(--xp-text-3)">${escapeHtml(compact(t))}</text>`
    })
    .join('')

  const bars = series
    .map((p, i) => {
      const cx = PAD.left + groupW * i + groupW / 2
      const c = num(p.credits)
      const d = num(p.debits)
      const ch = innerH * (c / (yMax || 1))
      const dh = innerH * (d / (yMax || 1))
      const labelEvery = Math.max(1, Math.ceil(series.length / 8))
      const label =
        i % labelEvery === 0 || i === series.length - 1
          ? `<text x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10"
              fill="var(--xp-text-3)">${escapeHtml(monthLabel(p.month))}</text>`
          : ''
      return `
        <rect x="${(cx - barW - 1.5).toFixed(1)}" y="${yAt(c).toFixed(1)}" width="${barW.toFixed(1)}"
              height="${Math.max(0, ch).toFixed(1)}" rx="2" fill="var(--xp-credit)">
          <title>${escapeHtml(monthLabel(p.month))} credits: ${escapeHtml(formatCurrency(c))}</title>
        </rect>
        <rect x="${(cx + 1.5).toFixed(1)}" y="${yAt(d).toFixed(1)}" width="${barW.toFixed(1)}"
              height="${Math.max(0, dh).toFixed(1)}" rx="2" fill="var(--xp-debit)">
          <title>${escapeHtml(monthLabel(p.month))} debits: ${escapeHtml(formatCurrency(d))}</title>
        </rect>
        ${label}`
    })
    .join('')

  return `
    <svg class="xp-chart-svg" viewBox="0 0 ${W} ${height}" role="img"
         aria-label="Monthly credits and debits" preserveAspectRatio="none"
         style="height:${height}px">
      ${grid}
      ${bars}
    </svg>`
}

/** Horizontal progress bar (used by loan repayment progress). */
export function progressHTML(percent, state = '') {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  const cls = state ? ` is-${state}` : state === '' ? '' : ''
  return `<div class="xp-progress${cls}" role="progressbar" aria-valuenow="${pct.toFixed(
    0
  )}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct.toFixed(1)}%"></span></div>`
}
