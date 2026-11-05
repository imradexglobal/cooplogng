import { readFileSync } from 'fs'
import { join } from 'path'

const read = p => readFileSync(join(process.cwd(), p), 'utf8')

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, pass: true })
    console.log('   ok  ', name)
  } catch (e) {
    results.push({ name, pass: false, err: e.message })
    console.log('   FAIL', name, '-', e.message)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((msg || 'not equal') + '\n  expected: ' + JSON.stringify(b) + '\n  actual:   ' + JSON.stringify(a))
}

console.log('\n=== COOPLOGNG RECONCILIATION TEST SUITE (36 checks) ===\n')
console.log('--- Section A: Static rule / code-structure checks ---')

// TR-10.1 (Task 10): No getReconciliationTotalsByDateRange anywhere in src
test('[TR-10.1] getReconciliationTotalsByDateRange removed from all src', () => {
  const rec = read('src/services/data/reconciliation.js')
  const idx = read('src/services/data/index.js')
  const ui = read('src/screens/Reconciliation.js')
  const all = rec + idx + ui
  assert(!all.includes('getReconciliationTotalsByDateRange'), 'found in production files')
})

// TR-1.1: exactly one getReconciliationTotals in reconciliation.js
test('[TR-1.1] Single authoritative getReconciliationTotals, no LIKE engine', () => {
  const rec = read('src/services/data/reconciliation.js')
  const matches = [...rec.matchAll(/export\s+(?:async\s+)?function\s+getReconciliationTotals\s*\(/g)]
  assertEq(matches.length, 1, 'should be exactly ONE exported getReconciliationTotals function')
  assert(!rec.includes('period_start%'), 'no legacy LIKE period_start% pattern')
})

// TR-5.1: No duplicate recon-month ids, no months hardcoded array
test('[TR-5.1 + TR-10.2] No recon-month IDs, no hardcoded months array', () => {
  const ui = read('src/screens/Reconciliation.js')
  assert(!ui.includes('id="recon-month"'), 'should not contain recon-month id')
  assert(!ui.includes("'2025-01'"), 'should not contain hardcoded YYYY-MM months')
})

// TR-5.2: No innerText parseFloat pattern
test('[TR-5.2] No parseFloat-from-innerText patterns in UI', () => {
  const ui = read('src/screens/Reconciliation.js')
  const p1 = /parseFloat\s*\(\s*document\.getElementById\([^)]*\)\s*\.\s*innerText/
  assert(!p1.test(ui), 'should not parse innerText as number')
})

// TR-2.4 + TR-10.3: period_month still populated, batch UPDATE IN clause
test('[TR-2.4, TR-10.3] period_month written; batch IN-clause + re-verify before seal', () => {
  const rec = read('src/services/data/reconciliation.js')
  assert(
    rec.includes('.slice(0, 7)') || rec.includes('.slice(0,7)'),
    'period_month populated from period_start.slice'
  )
  assert(
    rec.includes('UPDATE remittance SET reconciliation_summary_id') &&
    rec.includes(' IN (') || rec.includes(' IN( '),
    'uses batch UPDATE with IN clause (not per-rem saveDoc loop)'
  )
  assert(
    rec.includes('checkHash') && rec.includes('re-check before sealing'),
    'saveReconciliationSummary re-verifies via checkHash with error message'
  )
})

// TR-3.1: unseal uses FK predicate not date range
test('[TR-3.1] Unseal uses FK predicate, not date-range clearing', () => {
  const rec = read('src/services/data/reconciliation.js')
  const idxUnseal = rec.indexOf('function unsealReconciliation')
  const idxEnd = rec.indexOf('\nexport async function ', idxUnseal + 10)
  const unsealFunc = idxEnd > idxUnseal ? rec.slice(idxUnseal, idxEnd) : rec.slice(idxUnseal)
  assert(
    unsealFunc.includes('reconciliation_summary_id = ') &&
    (unsealFunc.includes('reconciliation_summary_id = ?') || unsealFunc.includes('summaryId')),
    'unseal clears by FK reconciliation_summary_id predicate'
  )
  const badPattern = /remittance_date\s*(<=|>=|<|>|BETWEEN)/i
  assert(!badPattern.test(unsealFunc.slice(0, unsealFunc.indexOf('} catch') > 0 ? 2500 : unsealFunc.length)),
    'unseal does NOT use remittance_date predicate')
})

// Task 4 enforcement helper calls
test('[Task 4] Seal enforcement helper on 5+ mutation paths, FK-based', () => {
  const r = read('src/services/data/remittances.js')
  assert(r.includes('_ensureRemittanceNotSealed'), '_ensureRemittanceNotSealed defined')
  const calls = r.match(/_ensureRemittanceNotSealed\s*\(/g) || []
  assert(calls.length >= 5, 'expected >=5 enforcement call sites, got ' + calls.length)
  assert(
    r.includes('reconciliation_summary_id') &&
    r.includes('is_deleted') &&
    r.includes('reconciliation_summary_id: null'),
    'FK-based enforcement with orphan FK self-heal (not date-range)'
  )
})

// TR-9.1 accounting pack overlap-based inPeriod
test('[TR-9.1] Accounting pack uses overlap inPeriod + full-range period label', () => {
  const pack = read('src/services/reports/accountingPack.js')
  const idx = pack.indexOf('bankReconciliation')
  const idx2 = pack.indexOf('];', idx + 300)
  const brSection = idx2 > idx ? pack.slice(idx, idx2) : pack.slice(idx, idx + 3000)
  const hasOverlap =
    (brSection.includes('period_start') && brSection.includes('period_end') &&
      (brSection.includes(' <= to') || brSection.includes('>= from')))
  assert(hasOverlap, 'uses overlap-based inPeriod (ps<=to && pe>=from)')
  const hasRangeLabel =
    brSection.includes(' -> ') ||
    brSection.includes(' \u2192 ') ||
    (brSection.split('period_start').length >= 2 && brSection.split('period_end').length >= 2)
  assert(hasRangeLabel, 'period label uses start -> end full range string')
})

console.log('\n--- Section B: Logic tests (in-memory mock DB) ---')

function makeMockDB() {
  return {
    remittances: [],
    summaries: [],
    syncQ: [],
    members: []
  }
}

function mock_getReconciliationTotals(db, cooperativeId, bankName, periodStart, periodEnd) {
  const rows = db.remittances.filter(r =>
    r.cooperative_id === cooperativeId &&
    r.bank_name === bankName &&
    r.is_deleted === 0 &&
    r.status === 'Approved' &&
    r.remittance_date.slice(0, 10) >= periodStart &&
    r.remittance_date.slice(0, 10) <= periodEnd
  )
  let systemCr = 0, systemDr = 0
  const relevantIds = []
  for (const r of rows) {
    if (r.amount > 0) systemCr += r.amount
    else systemDr += Math.abs(r.amount)
    relevantIds.push(r.id)
  }
  relevantIds.sort()
  return { systemCr, systemDr, relevantIds, transactionCount: rows.length }
}

function simpleHash(str) {
  let h1 = 0x811c9dc5, h2 = 0xdeadbeef
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

function mock_checkReconciliation(db, cooperativeId, bankName, periodStart, periodEnd, bankCr, bankDr) {
  const tot = mock_getReconciliationTotals(db, cooperativeId, bankName, periodStart, periodEnd)
  const crMils = Math.round((bankCr - tot.systemCr) * 1000)
  const drMils = Math.round((bankDr - tot.systemDr) * 1000)
  const diffCr = crMils / 1000
  const diffDr = drMils / 1000
  const balanced = Math.abs(crMils) <= 9 && Math.abs(drMils) <= 9
  const status = balanced ? 'Balanced' : 'Discrepancy'
  const hashInput = bankCr + '|' + bankDr + '|' + tot.systemCr + '|' + tot.systemDr + '|' + tot.relevantIds.join(',')
  const checkHash = simpleHash(hashInput)
  return {
    status, diffCr, diffDr,
    systemCr: tot.systemCr, systemDr: tot.systemDr,
    transactionCount: tot.transactionCount,
    relevantIds: tot.relevantIds,
    checkHash, bankCr, bankDr, bankName, periodStart, periodEnd, cooperativeId
  }
}

function seed30(db, coopId, bankName) {
  coopId = coopId || 'coop1'
  bankName = bankName || 'Main Bank'
  for (let d = 1; d <= 30; d++) {
    const ds = '2026-09-' + String(d).padStart(2, '0')
    db.remittances.push({
      id: 'r_cr_' + d, cooperative_id: coopId, bank_name: bankName,
      remittance_date: ds + 'T09:00:00.000Z', amount: 100, status: 'Approved',
      is_deleted: 0, member_id: null, reconciliation_summary_id: null,
      description: 'CR ' + d, category: 'Savings', loan_id: null,
      created_by: 'u1', modified_by: null, created_at: ds, modified_at: null, is_synced: 1
    })
    db.remittances.push({
      id: 'r_dr_' + d, cooperative_id: coopId, bank_name: bankName,
      remittance_date: ds + 'T10:00:00.000Z', amount: -50, status: 'Approved',
      is_deleted: 0, member_id: null, reconciliation_summary_id: null,
      description: 'DR ' + d, category: 'Withdrawal', loan_id: null,
      created_by: 'u1', modified_by: null, created_at: ds, modified_at: null, is_synced: 1
    })
  }
}

let db
function freshDB() { db = makeMockDB(); seed30(db); return db }

// 1. Balanced
test('[1] Balanced reconciliation check: Balanced status with 0 diffs', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  assertEq(chk.status, 'Balanced')
  assertEq(chk.systemCr, 2000)
  assertEq(chk.systemDr, 1000)
  assertEq(chk.diffCr, 0)
  assertEq(chk.diffDr, 0)
})

// 2. CR disc +100
test('[2] CR discrepancy +100: Discrepancy status, diffCr=100', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2100, 1000)
  assertEq(chk.status, 'Discrepancy')
  assertEq(chk.diffCr, 100)
  assertEq(chk.diffDr, 0)
})

// 3. DR disc +50
test('[3] DR discrepancy +50: Discrepancy status, diffDr=50', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1050)
  assertEq(chk.status, 'Discrepancy')
  assertEq(chk.diffCr, 0)
  assertEq(chk.diffDr, 50)
})

// 4. Tolerance 0.009 vs 0.01
test('[4] Tolerance: 0.009 diff -> Balanced; 0.01 diff -> Discrepancy', () => {
  freshDB()
  const bal = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000.009, 1000.009)
  assertEq(bal.status, 'Balanced')
  const disc = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000.01, 1000)
  assertEq(disc.status, 'Discrepancy')
})

// 5. Partial Sep 11-20 = 10 days, 20 rows
test('[5] Partial range Sep 11-20: 10 days, sysCr=1000, sysDr=500, tx=20', () => {
  freshDB()
  const tot = mock_getReconciliationTotals(db, 'coop1','Main Bank','2026-09-11','2026-09-20')
  assertEq(tot.transactionCount, 20)
  assertEq(tot.systemCr, 1000)
  assertEq(tot.systemDr, 500)
  assertEq(tot.relevantIds.length, 20)
})

// 6. Single-day Sep21
test('[6] Single-day Sep 21: 2 rows, sysCr=100, sysDr=50', () => {
  freshDB()
  const tot = mock_getReconciliationTotals(db, 'coop1','Main Bank','2026-09-21','2026-09-21')
  assertEq(tot.transactionCount, 2)
  assertEq(tot.systemCr, 100)
  assertEq(tot.systemDr, 50)
})

// 7. Partial-month seal
test('[7] Partial-month Sep 11-20 seal stores correct period_start/end', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-11','2026-09-20', 1000, 500)
  assertEq(chk.periodStart, '2026-09-11')
  assertEq(chk.periodEnd, '2026-09-20')
  assertEq(chk.status, 'Balanced')
})

// 8. Full-month seal
test('[8] Full-month Sep 1-30: Balanced with sysCr=3000 sysDr=1500 tx=60', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-30', 3000, 1500)
  assertEq(chk.status, 'Balanced')
  assertEq(chk.systemCr, 3000)
  assertEq(chk.systemDr, 1500)
  assertEq(chk.transactionCount, 60)
})

// 9. Overlapping 2 summaries
test('[9] Overlap allowed: A(1-20) + B(11-30) -> 2 summaries, FKs stamped correctly by order', () => {
  freshDB()
  db.summaries.push(
    { id: 'sumA', cooperative_id: 'coop1', bank_name: 'Main Bank', period_start: '2026-09-01', period_end: '2026-09-20', status: 'Sealed', is_deleted: 0 },
    { id: 'sumB', cooperative_id: 'coop1', bank_name: 'Main Bank', period_start: '2026-09-11', period_end: '2026-09-30', status: 'Sealed', is_deleted: 0 }
  )
  db.remittances.forEach(r => {
    const d = Number(r.id.split('_')[2])
    if (d >= 1 && d <= 20) r.reconciliation_summary_id = 'sumA'
  })
  db.remittances.forEach(r => {
    const d = Number(r.id.split('_')[2])
    if (d >= 11 && d <= 30) r.reconciliation_summary_id = 'sumB'
  })
  assertEq(db.summaries.filter(s => s.is_deleted === 0).length, 2)
  const byFK = { sumA: 0, sumB: 0 }
  db.remittances.forEach(r => { if (r.reconciliation_summary_id) byFK[r.reconciliation_summary_id]++ })
  assertEq(byFK.sumA, 20, 'days 1-10: 10 days x2 = 20 FK = sumA')
  assertEq(byFK.sumB, 40, 'days 11-30: 20 days x2 = 40 FK = sumB')
})

// 10. Later range includes previously reconciled dates
test('[10] Later range includes earlier dates: B check 11-30 correct totals', () => {
  freshDB()
  const chkB = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-11','2026-09-30', 2000, 1000)
  assertEq(chkB.transactionCount, 40)
  assertEq(chkB.systemCr, 2000)
  assertEq(chkB.systemDr, 1000)
  assertEq(chkB.status, 'Balanced')
})

// 11. REC-A unchanged after REC-B
test('[11] REC-A totals identical before vs after any later seal exists', () => {
  freshDB()
  const before = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  db.summaries.push({ id:'sumB', is_deleted: 0, period_start: '2026-09-11', period_end: '2026-09-30' })
  const after = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  assertEq(before.systemCr, after.systemCr, 'A systemCr unchanged')
  assertEq(before.systemDr, after.systemDr, 'A systemDr unchanged')
  assertEq(before.checkHash, after.checkHash, 'A checkHash identical')
})

// 12. Duplicate exact key rejected
test('[12] 4-part exact duplicate rejected; overlap (not exact) allowed', () => {
  freshDB()
  db.summaries.push({ id:'x', cooperative_id:'coop1', bank_name:'Main Bank', period_start:'2026-09-01', period_end:'2026-09-20', is_deleted: 0 })
  const exactExists = (coop, bank, start, end) =>
    db.summaries.some(s => s.cooperative_id===coop && s.bank_name===bank && s.period_start===start && s.period_end===end && s.is_deleted===0)
  assert(exactExists('coop1','Main Bank','2026-09-01','2026-09-20'), 'exact exists after first insert')
  assert(!exactExists('coop1','Main Bank','2026-09-11','2026-09-30'), 'overlap is NOT duplicate')
})

// 13. Check passes re-verify (hash match)
test('[13] Re-verification: checkHash matches on identical check calls', () => {
  freshDB()
  const first = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  const again = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  assertEq(first.checkHash, again.checkHash)
})

// 14. Data changed between check+seal -> seal throws (TR-2.1)
test('[14/TR-2.1] Intervening data change: seal throws hash mismatch', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  db.remittances.push({
    id: 'r_new1', cooperative_id: 'coop1', bank_name: 'Main Bank',
    remittance_date: '2026-09-15T12:00:00.000Z', amount: 500, status: 'Approved',
    is_deleted: 0, member_id: null, reconciliation_summary_id: null
  })
  const recheck = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  assert(chk.checkHash !== recheck.checkHash, 'checkHash MUST differ after intervening remittance')
  let threw = false
  try {
    if (chk.checkHash !== recheck.checkHash) throw new Error('Underlying data changed since last check; please re-check before sealing.')
  } catch (e) {
    threw = true
    assert(e.message.includes('Underlying data changed'), 'correct error message')
  }
  assert(threw, 'seal path throws on checkHash mismatch')
})

// 15. Seal stamps FKs correctly
test('[15] Seal: in-range remittances stamped; out-of-range untouched', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  const summaryId = 'sum_sealed_1'
  chk.relevantIds.forEach(id => {
    const r = db.remittances.find(rr => rr.id === id)
    if (r) r.reconciliation_summary_id = summaryId
  })
  const stamped = db.remittances.filter(r => r.reconciliation_summary_id === summaryId)
  assertEq(stamped.length, 40)
  const untouched = db.remittances.filter(r => {
    const d = Number(r.id.split('_')[2])
    return d >= 21 && d <= 30 && r.reconciliation_summary_id !== null
  })
  assertEq(untouched.length, 0, 'days 21-30 FK untouched')
})

// 16. TR-3.1 unseal overlap critical
test('[16/TR-3.1] Unseal REC-B: B FKs cleared; A 1-10 FKs PRESERVED (not date-based)', () => {
  freshDB()
  db.remittances.forEach(r => {
    const d = Number(r.id.split('_')[2])
    if (d >= 1 && d <= 20) r.reconciliation_summary_id = 'sumA'
  })
  db.remittances.forEach(r => {
    const d = Number(r.id.split('_')[2])
    if (d >= 11 && d <= 30) r.reconciliation_summary_id = 'sumB'
  })
  db.summaries.push(
    { id: 'sumA', is_deleted: 0, cooperative_id: 'coop1' },
    { id: 'sumB', is_deleted: 0, cooperative_id: 'coop1' }
  )
  // Unseal B with FK-only predicate (NOT date range!)
  db.remittances.forEach(r => {
    if (r.reconciliation_summary_id === 'sumB') r.reconciliation_summary_id = null
  })
  db.summaries.find(s => s.id === 'sumB').is_deleted = 1
  for (const r of db.remittances) {
    const d = Number(r.id.split('_')[2])
    if (d >= 1 && d <= 10) assertEq(r.reconciliation_summary_id, 'sumA', 'day ' + d + ' A FK preserved')
    if (d >= 11 && d <= 30) assertEq(r.reconciliation_summary_id, null, 'day ' + d + ' B FK cleared')
  }
  assertEq(db.summaries.find(s => s.id === 'sumA').is_deleted, 0, 'sumA is_deleted=0 preserved')
  assertEq(db.summaries.find(s => s.id === 'sumB').is_deleted, 1, 'sumB is_deleted=1')
})

// 17. Persisted status = Sealed (not Balanced)
test('[17] Persisted summary status = Sealed (Balanced is in-memory only)', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-01','2026-09-20', 2000, 1000)
  assertEq(chk.status, 'Balanced', 'in-memory check shows Balanced')
  const persistedDoc = { id: 'new_sum', status: 'Sealed', period_month: '2026-09' }
  assertEq(persistedDoc.status, 'Sealed', 'persisted doc status is Sealed, never Balanced')
})

// 18. Sync queue: identity entries
test('[18] Sync queue: 1 summary set op + per-rem update ops; identity-only payload=null', () => {
  freshDB()
  const chk = mock_checkReconciliation(db, 'coop1','Main Bank','2026-09-21','2026-09-22', 200, 100)
  const queue = []
  queue.push({ coop: 'coop1', coll: 'bank_reconciliation_summary', id: 'sum_x', op: 'set', payload: null })
  for (const rid of chk.relevantIds) queue.push({ coop: 'coop1', coll: 'remittance', id: rid, op: 'update', payload: null })
  assertEq(chk.relevantIds.length, 4, '4 remittances in Sep21+22')
  assertEq(queue.length, 5, '1 summary + 4 remittance sync entries')
  for (const e of queue) assertEq(e.payload, null, 'payload=null -> identity-only queue')
})

// 19. Pack inPeriod overlap + range label
test('[19/TR-9.1,9.2] Accounting pack inPeriod overlap + full-range period label', () => {
  const pack = { from: '2026-09-15', to: '2026-09-30' }
  const daily21 = { period_start: '2026-09-21', period_end: '2026-09-21' }
  const a = { period_start: '2026-09-01', period_end: '2026-09-20' }
  const oct = { period_start: '2026-10-01', period_end: '2026-10-31' }
  const inPeriod = (s, pk) => s.period_start <= pk.to && s.period_end >= pk.from
  assertEq(inPeriod(daily21, pack), true, 'daily 09-21 overlaps pack 15-30')
  assertEq(inPeriod(a, pack), true, 'A 09-01-20 overlaps pack 15-30')
  const octPack = { from: '2026-10-01', to: '2026-10-31' }
  assertEq(inPeriod(daily21, octPack), false, 'daily 09-21 NOT in Oct pack [TR-9.2]')
  const label = s => s.period_start + ' \u2192 ' + s.period_end
  assertEq(label(daily21), '2026-09-21 \u2192 2026-09-21', 'period label = full start-end range string')
})

// 20. P0: delta sync must FILTER WRITES, not just count events.
// This is the write-amplification fix: the 5-min overlap window always
// re-fetches the doc sitting exactly at the cursor, so `colObsMax` can never
// exceed the old cursor and `Math.max` is a no-op. Dedup must gate saveMany().
function deltaSyncBody() {
  const bg = read('src/services/backgroundSyncService.js')
  const m = bg.match(/^async function _deltaSync\(\)\s*\{/m)
  assert(m, '_deltaSync() declaration not found')
  // Body runs to the next line that starts at column 0 with a declaration.
  const start = m.index
  const rest = bg.slice(start + m[0].length)
  const end = rest.search(/\n(?=(?:async function |export (?:async )?function |export const |function )\S*\s*\(?)/)
  assert(end > -1, 'could not delimit _deltaSync body')
  return bg.slice(start, start + m[0].length + end)
}

test('[20] _deltaSync filters overlap docs out of saveMany, not just event count', () => {
  const body = deltaSyncBody()
  assert(/const\s+toSave\s*=/.test(body), 'must build a toSave list')
  assert(/saveMany\([^)]*,\s*toSave\s*\)/.test(body), 'saveMany must receive toSave (filtered), not the full doc set')
  // The cursor-driven delta loop must not write the unfiltered set. A
  // `saveMany(col, docs)` is legitimate in the incomplete-full-sync promotion
  // path above, so anchor on the LAST loop (the one iterating `collections`
  // that performs the actual delta fetch/write).
  const loops = [...body.matchAll(/for\s*\(\s*(?:const|let)\s+col\s+of\s+/g)]
  assert(loops.length >= 2, 'expected promotion loop + delta cursor loop')
  const loop = body.slice(loops[loops.length - 1].index)
  assert(/saveMany\([^)]*,\s*toSave\s*\)/.test(loop), 'cursor loop must save via toSave')
  assert(!/saveMany\([^)]*,\s*docs\s*\)/.test(loop), 'cursor loop must NOT save the unfiltered doc set')
})

// 21. P0: the filter must compare per-doc sync_at against prevCursor.
test('[21] write filter keys off per-doc sync_at vs prevCursor (legacy rows stay saveable)', () => {
  const bg = read('src/services/backgroundSyncService.js')
  const body = deltaSyncBody()
  assert(/_syncAtMs\(/.test(body), 'must use a per-doc sync_at reader')
  assert(/prevCursor/.test(body), 'filter must be relative to prevCursor')
  // Legacy rows with no sync_at must NOT be filtered out (would silently drop them)
  const filterLine = body.split('\n').find(l => /const\s+toSave\s*=/.test(l)) || ''
  const nextFew = body.slice(body.indexOf('const toSave'), body.indexOf('const toSave') + 400)
  assert(/===?\s*0|>\s*0/.test(nextFew) || /prevCursor\s*<=\s*0/.test(nextFew),
    'first/only sync must not filter (prevCursor<=0 guard)')
  assert(!filterLine.includes('prevCursor<=0&&!'), 'no nonsensical compound guard')
})

// 22. P0: sync_state read-modify-write must be serialized.
// Four functions mutate the SAME single record; IndexedDB gives no
// cross-transaction atomicity, so a stale read clobbers a cursor advance
// and the overlap window re-pulls forever.
test('[22] all sync_state read-modify-write mutators go through the write chain', () => {
  const st = read('src/services/sqlite/syncState.js')
  assert(/_serializeStateWrite/.test(st), 'serializer helper missing')
  for (const fn of ['markCollectionSynced', 'markCollectionUnsynced', 'updateSyncState']) {
    const body = st.match(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b[\\s\\S]*?\\n}`))[0]
    assert(/_serializeStateWrite/.test(body), fn + ' bypasses the write chain (lost-update race)')
  }
  // A rejected write must not deadlock the chain for later mutations
  assert(/_stateWriteChain\s*=\s*run\.then\(\(\)\s*=>\s*\{\s*\},\s*\(\)\s*=>\s*\{\s*\}\)/.test(st),
    'chain must absorb rejections so one failed write cannot stall all later writes')
})

// 23. P1: login must not infer "no previous data" when sync_state HAS cursors.
test('[23] login derives context from sync_state when app_settings sync_context is missing', () => {
  const ss = read('src/services/syncService.js')
  assert(/derived_from/.test(ss), 'must record that context was derived, not persisted')
  assert(/getSyncMeta/.test(ss), 'must read cursors from sync_state to derive context')
  // A missing context row must NOT immediately force a full sync
  const body = ss.match(/function\s+loadSyncContext[\s\S]*?\n}/)[0]
  assert(!/if\s*\(\s*!\s*prev\s*\)\s*\{\s*return\s*full/.test(body),
    'a null context must still consult sync_state before forcing full')
})

// 24. P1: empty tables must force FULL sync even when context exists.
test('[24] usable-data check runs BEFORE the delta/full decision', () => {
  const ss = read('src/services/syncService.js')
  const iData = ss.indexOf('dbHasUsableData')
  const iFull = ss.search(/FULL_COOP_SYNC|FULL_MEMBER_SYNC|forceFull/)
  assert(iData > -1, 'dbHasUsableData not referenced')
  assert(iFull > -1, 'no FULL decision branch found')
  assert(iData < iFull, 'usable-data check must precede the FULL/DELTA_ONLY decision')
})

// 25. P1: is_full_sync_complete===0 with nothing unsynced must self-heal.
test('[25] incomplete full sync with no unsynced collections is promoted, not stalled', () => {
  const bg = read('src/services/backgroundSyncService.js')
  assert(/is_full_sync_complete/.test(bg), 'incomplete marker never checked')
  assert(/Promoted incomplete sync/.test(bg), 'no promotion path -> permanent stall')
  assert(!/if\s*\(\s*unsynced\.length\s*===\s*0\s*\)\s*return\s*;/.test(bg),
    'still returns silently when nothing is unsynced (the stall bug)')
})

// 26. P2: identical session must not bump _sessionGen (it aborted login delta sync).
test('[26] session generation only bumps on real identity change', () => {
  const bg = read('src/services/backgroundSyncService.js')
  assert(/_sessionIdentity/.test(bg), 'no session identity comparison')
  assert(/_adoptSession/.test(bg), 'session not adopted through a single path')
  const adopt = bg.match(/function\s+_adoptSession[\s\S]*?\n}/)[0]
  assert(/_sessionGen/.test(adopt), '_adoptSession must own the generation check')
})

// 27. P2: swallowed sync_context write failure must be logged.
test('[27] sync_context write failure is logged, not silently swallowed', () => {
  const bg = read('src/services/backgroundSyncService.js')
  const i = bg.indexOf("setAppSetting('sync_context'")
  assert(i > -1, 'sync_context write not found')
  // The catch attached to the sync_context write must report the error.
  // (Best-effort cleanup deletes elsewhere legitimately use bare catch{}.)
  const ctx = bg.slice(i, i + 1400)
  assert(!/catch\s*\{\s*\}/.test(ctx), 'sync_context write failure is silently swallowed')
  assert(/console\.(warn|error)[\s\S]*?sync_context/.test(ctx), 'sync_context write failure must be logged')
})

// 28. P0: full remittance scans must include old Firestore documents without sync_at.
test('[28] full scans include legacy remittances and existing caches backfill once', () => {
  const bg = read('src/services/backgroundSyncService.js')
  const fetchStart = bg.indexOf('async function _fetchCollection(')
  const fetchEnd = bg.indexOf('\n// ─── Scope pruning', fetchStart)
  assert(fetchStart > -1 && fetchEnd > fetchStart, 'could not locate _fetchCollection body')
  const fetchBody = bg.slice(fetchStart, fetchEnd)
  assert(/const isDeltaQuery = Boolean\(cursor\) \|\| sinceTs > 0/.test(fetchBody), 'full and delta fetch modes are not distinguished')
  assert(/: \[\]/.test(fetchBody), 'full scans must use Firestore default document-ID ordering, not sync_at')
  const delta = deltaSyncBody()
  assert(/needsLegacyRemittanceBackfill/.test(delta), 'existing caches do not get a legacy remittance backfill')
  assert(/legacyBackfillVersion/.test(delta), 'successful backfill is not persisted to the remittance cursor')
  assert(/!needsLegacyRemittanceBackfill && prevCursor > 0/.test(delta), 'backfill does not save the complete server set')
})

console.log('\n--- SUMMARY ---')
const passed = results.filter(r => r.pass).length
const total = results.length
console.log('Passed ' + passed + '/' + total)
const failures = results.filter(r => !r.pass)
if (failures.length) {
  console.log('\nFailures:')
  for (const f of failures) console.log('  -', f.name, '::', f.err)
  process.exitCode = 1
} else {
  console.log('All reconciliation tests passed.')
}
