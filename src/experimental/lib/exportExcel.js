/**
 * Experimental Ledger / Loans — Excel export (ExcelJS).
 *
 * Uses the exceljs dependency already present in package.json (lazy loaded),
 * exactly like the existing exporters do. Nothing is imported from
 * src/services/reports/ — this is a standalone writer.
 */

import { formatNumber, monthLabel, todayInput } from './format.js'

async function loadExcelJS() {
  if (window.ExcelJS) return window.ExcelJS
  const mod = await import('exceljs')
  return mod.default || mod
}

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B63' } }
const HEAD_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
const TITLE_FONT = { bold: true, size: 14, color: { argb: 'FF1F3B63' } }
const LABEL_FONT = { bold: true, size: 10, color: { argb: 'FF444B57' } }

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEAD_FILL
    cell.font = HEAD_FONT
    cell.alignment = { vertical: 'middle', horizontal: 'left' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF2B3440' } } }
  })
}

function autoSize(sheet, widths) {
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w
  })
}

function writeMetaBlock(sheet, rows) {
  let r = 1
  for (const [label, value] of rows) {
    sheet.getCell(`A${r}`).value = label
    sheet.getCell(`A${r}`).font = LABEL_FONT
    sheet.getCell(`B${r}`).value = value
    sheet.getCell(`B${r}`).font = { size: 10 }
    r += 1
  }
  return r + 1
}

function downloadWorkbook(workbook, filename) {
  return workbook.xlsx.writeBuffer().then((buffer) => {
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  })
}

function scopeLabel(filters, accountName, memberName) {
  const parts = []
  parts.push(accountName || 'All accounts')
  parts.push(memberName || 'All members')
  if (filters.dateFrom || filters.dateTo) {
    parts.push(`${filters.dateFrom || '…'} → ${filters.dateTo || '…'}`)
  }
  return parts.join(' · ')
}

/**
 * @param {{user:object, dataset:object, filters:object, result:object,
 *          accountName:string, memberName:string}} args
 */
export async function exportLedgerExcel(args) {
  const { user, dataset, filters, result, accountName, memberName } = args
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CoopLog Experimental Ledger'
  workbook.created = new Date()

  // ---------------------------------------------------------------- Ledger
  const sheet = workbook.addWorksheet('Ledger', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  const startRow = writeMetaBlock(sheet, [
    ['Cooperative', user.cooperativeName || user.cooperativeId],
    ['Report', 'General Ledger (experimental)'],
    ['Scope', scopeLabel(filters, accountName, memberName)],
    ['Generated', `${todayInput()} — ${new Date().toLocaleTimeString('en-GB')}`],
    ['Opening balance', formatNumber(result.opening)],
    ['Total credits', formatNumber(result.credits)],
    ['Total debits', formatNumber(result.debits)],
    ['Closing balance', formatNumber(result.closing)],
    [
      'Note',
      'Balances include Approved entries only. Pending / Declined rows are listed for review and never post to balances.',
    ],
  ])

  const header = sheet.getRow(startRow)
  header.values = [
    'Date',
    'Reference',
    'Description',
    'Transaction Type',
    'Account',
    'Account Type',
    'Member',
    'Credit',
    'Debit',
    'Balance',
    'Status',
    'Flags',
    'Bank / Method',
  ]
  styleHeaderRow(header)
  header.height = 20

  let rowIndex = startRow + 1
  for (const r of result.display) {
    const row = sheet.getRow(rowIndex++)
    row.values = [
      r.date,
      r.ref,
      r.displayDescription,
      r.transactionType,
      r.accountName,
      r.accountType,
      r.memberName,
      r.credit || null,
      r.debit || null,
      r.balance,
      r.status,
      [r.isReversal ? 'REVERSAL' : '', r.isAutogen ? 'AUTO' : '', r.isLoanRequest ? 'LOAN REQUEST' : '']
        .filter(Boolean)
        .join(', '),
      r.bankName,
    ]
    row.getCell(8).numFmt = '#,##0.00'
    row.getCell(9).numFmt = '#,##0.00'
    row.getCell(10).numFmt = '#,##0.00'
    if (r.status !== 'Approved') {
      row.font = { color: { argb: 'FF8A6D1F' }, italic: true }
    }
    if (r.credit) row.getCell(8).font = { color: { argb: 'FF0B7A52' } }
    if (r.debit) row.getCell(9).font = { color: { argb: 'FFC93A3A' } }
  }

  const totalRow = sheet.getRow(rowIndex)
  totalRow.values = [
    '',
    '',
    'TOTALS (posted, in filter)',
    '',
    '',
    '',
    '',
    result.credits,
    result.debits,
    result.closing,
    '',
    '',
    '',
  ]
  totalRow.font = { bold: true }
  totalRow.getCell(8).numFmt = '#,##0.00'
  totalRow.getCell(9).numFmt = '#,##0.00'
  totalRow.getCell(10).numFmt = '#,##0.00'

  autoSize(sheet, [12, 22, 46, 20, 26, 14, 26, 15, 15, 16, 12, 20, 18])

  // ------------------------------------------------------- Monthly summary
  const monthly = workbook.addWorksheet('Monthly Summary')
  const mStart = writeMetaBlock(monthly, [
    ['Scope', scopeLabel(filters, accountName, memberName)],
    ['Note', 'Posted (Approved) entries only, grouped by transaction month.'],
  ])
  const mHeader = monthly.getRow(mStart)
  mHeader.values = ['Month', 'Credits', 'Debits', 'Net', 'Entries']
  styleHeaderRow(mHeader)

  let mRow = mStart + 1
  for (const m of result.totalsByMonth) {
    const row = monthly.getRow(mRow++)
    row.values = [monthLabel(m.month), m.credits, m.debits, m.credits - m.debits, m.count]
    row.getCell(2).numFmt = '#,##0.00'
    row.getCell(3).numFmt = '#,##0.00'
    row.getCell(4).numFmt = '#,##0.00'
  }
  autoSize(monthly, [16, 16, 16, 16, 12])

  // ---------------------------------------------------------- Filter record
  const filtersSheet = workbook.addWorksheet('Filters')
  const fStart = writeMetaBlock(filtersSheet, [
    ['Account', filters.accountId === 'all' ? 'All accounts' : accountName],
    ['Member', filters.memberId === 'all' ? 'All members' : memberName],
    ['Transaction type', filters.txType === 'all' ? 'All types' : filters.txType],
    ['Status', filters.status === 'all' ? 'All statuses' : filters.status],
    ['From', filters.dateFrom || '(none)'],
    ['To', filters.dateTo || '(none)'],
    ['Reference search', filters.refSearch || '(none)'],
    ['Description search', filters.descSearch || '(none)'],
    ['Rows exported', result.display.length],
  ])
  filtersSheet.getCell(`A${fStart}`).value = 'These filters were active when the file was generated.'
  filtersSheet.getCell(`A${fStart}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } }
  autoSize(filtersSheet, [24, 60])

  const stamp = todayInput().replace(/-/g, '')
  const scopeSlug = (accountName || 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  return downloadWorkbook(workbook, `ledger_${scopeSlug}_${stamp}.xlsx`)
}

/**
 * @param {{user:object, loans:Array, summary:object, filters:object,
 *          accountName?:string}} args
 */
export async function exportLoansExcel(args) {
  const { user, loans, summary, filters } = args
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CoopLog Experimental Loans'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Loans', { views: [{ state: 'frozen', ySplit: 1 }] })
  const start = writeMetaBlock(sheet, [
    ['Cooperative', user.cooperativeName || user.cooperativeId],
    ['Report', 'Loan register (experimental)'],
    ['Generated', `${todayInput()} — ${new Date().toLocaleTimeString('en-GB')}`],
    ['Total disbursed', formatNumber(summary.disbursed)],
    ['Total outstanding', formatNumber(summary.outstanding)],
    ['Total repayments', formatNumber(summary.repayments)],
    ['Pending applications', formatNumber(summary.pending)],
    ['Approved loans', formatNumber(summary.approved)],
    ['Overdue loans', formatNumber(summary.overdueCount)],
    [
      'Note',
      'Outstanding balances follow the existing rule: the member+account balance sits on the most recent loan of that pair.',
    ],
  ])

  const header = sheet.getRow(start)
  header.values = [
    'Loan Reference',
    'Member',
    'Registration No',
    'Loan Type',
    'Principal',
    'Interest & Charges',
    'Total Payable',
    'Amount Repaid',
    'Outstanding',
    'Application Date',
    'Disbursed',
    'Due Date',
    'Duration (months)',
    'Status',
    'Repayment Status',
  ]
  styleHeaderRow(header)

  let rowIndex = start + 1
  for (const l of loans) {
    const row = sheet.getRow(rowIndex++)
    row.values = [
      l.ref,
      l.memberName,
      l.memberReg,
      l.accountName,
      l.principal,
      l.interest,
      l.totalPayable,
      l.repaid,
      l.outstanding,
      l.appliedDate || '',
      l.issuedDate || '',
      l.dueDate || '',
      l.durationMonths || '',
      l.statusDisplay,
      l.repaymentState,
    ]
    for (const c of [5, 6, 7, 8, 9]) row.getCell(c).numFmt = '#,##0.00'
    if (l.statusDisplay === 'Overdue') {
      row.font = { color: { argb: 'FFC93A3A' }, bold: true }
    } else if (l.statusDisplay === 'Pending') {
      row.font = { color: { argb: 'FF9A6700' }, italic: true }
    }
  }

  autoSize(sheet, [22, 28, 16, 22, 14, 18, 15, 15, 15, 16, 16, 16, 16, 14, 18])

  const fSheet = workbook.addWorksheet('Filters')
  writeMetaBlock(fSheet, [
    ['Member search', filters.memberSearch || '(none)'],
    ['Reference search', filters.refSearch || '(none)'],
    ['Status', filters.status === 'all' ? 'All' : filters.status],
    ['Loan type', filters.accountId === 'all' ? 'All types' : filters.accountId],
    ['Applied from', filters.appliedFrom || '(none)'],
    ['Applied to', filters.appliedTo || '(none)'],
    ['Disbursed from', filters.disbursedFrom || '(none)'],
    ['Disbursed to', filters.disbursedTo || '(none)'],
    ['Repayment status', filters.repayment === 'all' ? 'All' : filters.repayment],
    ['Rows exported', loans.length],
  ])
  autoSize(fSheet, [24, 60])

  const stamp = todayInput().replace(/-/g, '')
  return downloadWorkbook(workbook, `loan-register_${stamp}.xlsx`)
}
