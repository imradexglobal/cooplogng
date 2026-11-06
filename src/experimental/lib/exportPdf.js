/**
 * Experimental Ledger / Loans — PDF export.
 *
 * Loads jsPDF + autotable from the CDN on demand (same pinned versions the
 * existing Reports exporter uses). No module of the existing pages is
 * imported, so this file is fully removable.
 */

import { formatDate, formatNumber, todayInput } from './format.js'

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
const AUTOTABLE_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js'

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-xp-src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') resolve()
      else existing.addEventListener('load', () => resolve(), { once: true })
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.dataset.xpSrc = src
    el.async = true
    el.onload = () => {
      el.dataset.loaded = '1'
      resolve()
    }
    el.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(el)
  })
}

async function loadJsPDF() {
  await loadScript(JSPDF_URL)
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF unavailable')
  if (!window.jspdf.jsPDF.prototype.autoTable) await loadScript(AUTOTABLE_URL)
  return window.jspdf.jsPDF
}

const NAVY = [31, 59, 99]
const GREY = [110, 118, 130]
const RED = [178, 44, 44]
const GREEN = [11, 122, 82]

function header(doc, title, lines, pageWidth) {
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, pageWidth, 24, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(title, 14, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.text(lines[0] || '', 14, 17.5)
  doc.setFontSize(7.5)
  doc.text(lines[1] || '', pageWidth - 14, 17.5, { align: 'right' })
  return 32
}

function summaryBlock(doc, items, y, pageWidth) {
  doc.setTextColor(...GREY)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  const colW = (pageWidth - 28) / items.length
  items.forEach((it, i) => {
    const x = 14 + colW * i
    doc.text(it.label.toUpperCase(), x, y)
    doc.setTextColor(20, 22, 27)
    doc.setFontSize(11)
    doc.text(it.value, x, y + 6)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7.5)
    doc.setTextColor(...GREY)
  })
  doc.setDrawColor(210, 214, 220)
  doc.line(14, y + 10, pageWidth - 14, y + 10)
  return y + 16
}

function footer(doc) {
  const count = doc.internal.getNumberOfPages()
  for (let i = 1; i <= count; i++) {
    doc.setPage(i)
    doc.setTextColor(...GREY)
    doc.setFontSize(7.5)
    doc.text(
      `Generated ${todayInput()} · CoopLog · Page ${i} of ${count}`,
      14,
      doc.internal.pageSize.getHeight() - 8
    )
  }
}

function download(doc, filename) {
  doc.save(filename)
}

const MAX_PDF_ROWS = 1200

/** @param {{user, dataset, filters, result, accountName, memberName}} args */
export async function exportLedgerPdf(args) {
  const { user, filters, result, accountName, memberName } = args
  const jsPDF = await loadJsPDF()
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  const scope = [
    accountName || 'All accounts',
    memberName || 'All members',
    `${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`,
  ].join('  ·  ')

  let y = header(
    doc,
    'Ledger',
    [
      `${user.cooperativeName || user.cooperativeId}  ·  ${scope}`,
      `Generated ${todayInput()} ${new Date().toLocaleTimeString('en-GB')}`,
    ],
    pageWidth
  )

  y = summaryBlock(
    doc,
    [
      { label: 'Opening balance', value: formatNumber(result.opening) },
      { label: 'Total credits', value: formatNumber(result.credits) },
      { label: 'Total debits', value: formatNumber(result.debits) },
      { label: 'Closing balance', value: formatNumber(result.closing) },
      { label: 'Rows shown', value: formatNumber(result.display.length) },
    ],
    y,
    pageWidth
  )

  const rows = result.display.slice(0, MAX_PDF_ROWS)
  const body = rows.map((r) => [
    r.date,
    r.shortRef,
    (r.displayDescription || '').slice(0, 64),
    r.accountName,
    r.memberName,
    r.credit ? formatNumber(r.credit) : '',
    r.debit ? formatNumber(r.debit) : '',
    formatNumber(r.balance),
    r.status,
  ])

  doc.autoTable({
    startY: y,
    head: [['Date', 'Ref', 'Description', 'Account', 'Member', 'Credit', 'Debit', 'Balance', 'Status']],
    body,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, textColor: [40, 44, 52] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [246, 247, 250] },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 20 },
      2: { cellWidth: 78 },
      3: { cellWidth: 40 },
      4: { cellWidth: 44 },
      5: { halign: 'right', cellWidth: 26 },
      6: { halign: 'right', cellWidth: 26 },
      7: { halign: 'right', cellWidth: 28 },
      8: { cellWidth: 24 },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return
      if (data.column.index === 5 && data.cell.raw) data.cell.styles.textColor = GREEN
      if (data.column.index === 6 && data.cell.raw) data.cell.styles.textColor = RED
      if (data.column.index === 8 && data.cell.raw && data.cell.raw !== 'Approved') {
        data.cell.styles.textColor = [154, 103, 0]
      }
    },
  })

  if (result.display.length > MAX_PDF_ROWS) {
    const y2 = (doc.lastAutoTable?.finalY || y) + 6
    doc.setTextColor(...GREY)
    doc.setFontSize(8)
    doc.text(
      `Note: the first ${MAX_PDF_ROWS} of ${result.display.length} rows are shown. Use the Excel export for the complete listing.`,
      14,
      y2
    )
  }

  footer(doc)
  const scopeSlug = (accountName || 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  download(doc, `ledger_${scopeSlug}_${todayInput().replace(/-/g, '')}.pdf`)
}

/** @param {{user, loans, summary, filters}} args */
export async function exportLoansPdf(args) {
  const { user, loans, summary, filters } = args
  const jsPDF = await loadJsPDF()
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()

  let y = header(
    doc,
    'Loan',
    [
      `${user.cooperativeName || user.cooperativeId}  ·  ${filters.status === 'all' ? 'All statuses' : filters.status}`,
      `Generated ${todayInput()} ${new Date().toLocaleTimeString('en-GB')}`,
    ],
    pageWidth
  )

  y = summaryBlock(
    doc,
    [
      { label: 'Disbursed', value: formatNumber(summary.disbursed) },
      { label: 'Outstanding', value: formatNumber(summary.outstanding) },
      { label: 'Repayments', value: formatNumber(summary.repayments) },
      { label: 'Pending', value: formatNumber(summary.pending) },
      { label: 'Overdue', value: formatNumber(summary.overdueCount) },
    ],
    y,
    pageWidth
  )

  const rows = loans.slice(0, MAX_PDF_ROWS).map((l) => [
    l.ref,
    l.memberName,
    l.accountName,
    formatNumber(l.principal),
    formatNumber(l.interest),
    formatNumber(l.totalPayable),
    formatNumber(l.repaid),
    formatNumber(l.outstanding),
    l.issuedDate ? formatDate(l.issuedDate) : '',
    l.statusDisplay,
  ])

  doc.autoTable({
    startY: y,
    head: [
      [
        'Reference',
        'Member',
        'Loan type',
        'Principal',
        'Interest',
        'Payable',
        'Repaid',
        'Outstanding',
        'Disbursed',
        'Status',
      ],
    ],
    body: rows,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, textColor: [40, 44, 52] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [246, 247, 250] },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 46 },
      2: { cellWidth: 34 },
      3: { halign: 'right', cellWidth: 24 },
      4: { halign: 'right', cellWidth: 24 },
      5: { halign: 'right', cellWidth: 24 },
      6: { halign: 'right', cellWidth: 24 },
      7: { halign: 'right', cellWidth: 26 },
      8: { cellWidth: 24 },
      9: { cellWidth: 24 },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return
      if (data.column.index === 9 && data.cell.raw === 'Overdue') {
        data.cell.styles.textColor = RED
        data.cell.styles.fontStyle = 'bold'
      }
      if (data.column.index === 9 && data.cell.raw === 'Pending') {
        data.cell.styles.textColor = [154, 103, 0]
      }
    },
  })

  footer(doc)
  download(doc, `loan-register_${todayInput().replace(/-/g, '')}.pdf`)
}
