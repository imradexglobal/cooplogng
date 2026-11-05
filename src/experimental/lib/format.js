/**
 * Experimental pages — formatting helpers.
 *
 * Self-contained on purpose: the new Ledger / Loan pages must not depend on
 * src/utils/formatters.js (or any other UI helper used by the existing pages),
 * so deleting this folder can never break the original application.
 */

const CURRENCY = '\u20A6' // Naira, same unit the cooperative is denominated in

export function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const escapeAttribute = escapeHtml

function numberFormatter(min, max) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  })
}

/** Naira amount, e.g. ₦1,234 or ₦1,234.56 */
export function formatCurrency(amount) {
  const num = Number(amount)
  if (!Number.isFinite(num)) return `${CURRENCY}0`
  const isInteger = Math.abs(num % 1) < 1e-9
  return CURRENCY + numberFormatter(isInteger ? 0 : 2, 2).format(num)
}

/** Plain grouped number (no symbol), decimals only when present. */
export function formatNumber(amount) {
  const num = Number(amount)
  if (!Number.isFinite(num)) return '0'
  const isInteger = Math.abs(num % 1) < 1e-9
  return numberFormatter(isInteger ? 0 : 2, 2).format(num)
}

/** 2026-11-05 -> 5 Nov 2026 */
export function formatDate(value) {
  const d = toDate(value)
  if (!d) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Date input value (YYYY-MM-DD) from anything date-like. */
export function toDateInput(value) {
  const d = toDate(value)
  if (!d) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Accepts 'YYYY-MM-DD', ISO timestamps and Date objects -> local Date at midnight. */
export function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const str = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(str)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Calendar-day key (YYYY-MM-DD) for a date-like value, in local time. */
export function dayKey(value) {
  const d = toDate(value)
  if (!d) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 'YYYY-MM' bucket key used by the monthly summaries. */
export function monthKey(value) {
  const d = toDate(value)
  if (!d) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}`
}

export function monthLabel(key) {
  const [y, m] = String(key).split('-')
  const idx = Number(m) - 1
  if (!Number.isInteger(idx) || idx < 0 || idx > 11) return key
  return new Date(Number(y), idx, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

/** Short, human-quotable reference (last 8 chars of the generated id). */
export function shortRef(id) {
  const s = String(id || '')
  return s.length > 8 ? s.slice(-8) : s
}

export function todayInput() {
  return toDateInput(new Date())
}

export function addMonths(dateStr, months) {
  const d = toDate(dateStr)
  if (!d) return ''
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return dayKey(d)
}

export function daysBetween(fromStr, toStr) {
  const a = toDate(fromStr)
  const b = toDate(toStr)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 'a, b, c' list -> Set for cheap membership checks. */
export function toSet(csv) {
  return new Set(
    String(csv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

export function plural(count, one, many) {
  return `${formatNumber(count)} ${count === 1 ? one : many || `${one}s`}`
}
