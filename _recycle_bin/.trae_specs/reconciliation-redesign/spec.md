# CoopLogNG Reconciliation Redesign - Product Requirements Document

## Overview
- **Summary**: Complete redesign and consolidation of the Bank Reconciliation feature from scattered monthly-only logic into one clean, authoritative, offline-first system supporting arbitrary date ranges, overlapping reconciliations, daily reconciliation, calendar visualization, proper history, discrepancy investigation, and reliable sealing/unsealing.
- **Purpose**: Fix the existing broken reconciliation implementation which has duplicate logic, reads DOM text for accounting values, performs N+1 writes, does not re-verify before seal, lacks proper status tracking, uses hardcoded month ranges, has no calendar, no history, no drill-down, and no data-layer enforcement of sealed records.
- **Target Users**: Cooperative accountants, admins, and users with `read_reconcile` / `create_reconcile` permissions.

## Goals
1. Consolidate duplicate OLD (monthly) and NEW (date-range) reconciliation logic into ONE authoritative implementation.
2. Support arbitrary date ranges: daily, weekly, partial-month, monthly, any custom range.
3. Support overlapping date ranges (e.g., Sep 1-20 sealed, then Sep 11-30 sealed — both coexist without corruption).
4. Implement authoritative service-layer calculations; UI must never perform its own accounting math.
5. Re-verify all totals immediately before sealing; never trust displayed DOM values.
6. Deterministic duplicate reconciliation protection compatible with offline-first architecture.
7. Eliminate N+1 writes during seal/unseal using existing batch mechanisms.
8. Enforce sealed records at the data layer on remittance mutation paths (edit/delete/approve/decline).
9. Use the existing `status` field meaningfully: Draft, Balanced, Discrepancy, Sealed, Unsealed.
10. Add reconciliation history section with view/inspect capability.
11. Add discrepancy drill-down showing contributing remittance records.
12. Add calendar-based date selection with green indication of previously reconciled dates.
13. Clean cohesive single-workflow UI replacing scattered inline-styled cards with duplicate IDs.
14. Preserve offline-first / outbox / sync architecture.
15. Maintain Accounting Pack Bank Reconciliation sheet compatibility.
16. Add comprehensive tests for all critical invariants.

## Non-Goals
1. Do NOT add new database columns/tables. Use existing schema exclusively.
2. Do NOT implement full bank-statement line-item matching.
3. Do NOT introduce realtime Firestore listeners; keep existing pull-based sync.
4. Do NOT refactor unrelated screens or modules.
5. Do NOT change existing accounting calculations or remittance posting rules.
6. Do NOT introduce large frontend frameworks; keep existing vanilla-JS patterns.
7. Do NOT invent fields such as `sealed_at`, `sealed_by`, `difference_cr`, `difference_dr`, etc. Use existing fields: `created_at` is seal time, `created_by` is sealer.

## Background & Context

### Existing Database Schema (NO CHANGES REQUIRED)
Verified against [constants.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/sqlite/constants.js#L1-L26):

**`bank_reconciliation_summary` table**:
- `id`, `cooperative_id`, `bank_name`
- `period_month` (legacy, keep for backward compat), `period_start`, `period_end` (for date ranges)
- `bank_total_cr`, `bank_total_dr`, `system_total_cr`, `system_total_dr`
- `status` (currently hardcoded "Balanced"; will be used properly)
- `created_at`, `created_by` (= sealed date / sealed by)
- `modified_at`, `modified_by`, `is_synced`, `is_deleted`, `sync_at`

**`remittance` table**:
- `reconciliation_summary_id` (FK linking to a specific summary; single-link per remittance, updated on each seal)

### Duplicate Logic Confirmed
Two parallel engines exist side-by-side in the codebase:

1. **OLD Monthly Engine** (`getReconciliationTotals`, hardcoded `months` array, `period_month` field):
   - Monthly-only reconciliation via LIKE pattern matching on period strings
   - 24 hardcoded months from 2025-01 to 2026-12

2. **NEW Date-Range Engine** (`getReconciliationTotalsByDateRange`, `period_start`/`period_end`):
   - Proper date filtering using `strftime('%Y-%m-%d', remittance_date)`
   - Partially integrated but the UI and sealing paths still reference the old engine

3. **UI has duplicate HTML structure bug**: Two "Parameters" cards rendered in [Reconciliation.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/Reconciliation.js#L76-L134) — the first has from/to dates, the second has month dropdown + bank selector. There are TWO `<select id="recon-month">` elements (duplicate IDs).

### Critical Confirmed Bugs
- **Seal reads DOM text**: `btnLock` handler parses `document.getElementById('sys-cr').innerText` for numeric values instead of re-calculating ([Reconciliation.js:437-438](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/screens/Reconciliation.js#L437-L438))
- **Unseal uses DATE RANGE to clear IDs**: Uses `remittance_date >= start AND <= end` SQL instead of `reconciliation_summary_id = ?` — dangerous for overlaps ([reconciliation.js:134-155](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/data/reconciliation.js#L134-L155))
- **N+1 writes**: Each remittance gets individual `saveDoc()` + `enqueueWrite()` during seal/unseal
- **Status hardcoded "Balanced"**: Always set regardless of actual outcome
- **No data-layer enforcement**: Mutations in [remittances.js](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/data/remittances.js) never check `reconciliation_summary_id`
- **Duplicate check only exact range**: No deterministic composite identity; offline devices could create duplicate reconciliations of the same range

### Accounting Pack Integration Verified
- [accountingPack.js:1442-1458](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/reports/accountingPack.js#L1442-L1458) reads `bank_reconciliation_summary`, filters by `period_month` month match, and builds `bankReconciliation` array.
- [accountingPackExcel.js:868-894](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/reports/accountingPackExcel.js#L868-L894) renders the Bank Reconciliation sheet. Update the filtering to support arbitrary `period_start`/`period_end` overlap matching and show the actual date range instead of just `period_month`.

### Sync Architecture Verified
- `bank_reconciliation_summary` is a top-level collection in [mutationEngine.js:222](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/src/services/sqlite/mutationEngine.js#L222), registered in all sync/reconcile/sweep lists in syncQueue.js.
- Firestore rules at [firestore.rules:74-79](file:///C:/Users/Admin/Documents/Imradex_Tech_Projects/cooplogng/firestore.rules#L74-L79) allow writes with `cooperative_id` + `bank_name` + `period_month`. Since `period_start`/`period_end` already exist and the rule only validates presence of `period_month`, no rule change required.

## Functional Requirements

### FR-1: Authoritative Reconciliation Service
All reconciliation calculations (system CR, system DR, transaction counts, relevant IDs, discrepancies) MUST be computed in a single service layer. The UI MUST call these services and never perform its own math.

### FR-2: Arbitrary Date-Range Reconciliation
User can select any valid From/To date pair: single day (same day), week, partial month, full month, multi-month, or any custom range. No hardcoded month list or calendar-only limitation.

### FR-3: Overlapping Date Ranges Allowed
If Reconciliation A (Sep 1-20) is sealed, user can still create and seal Reconciliation B (Sep 11-30). Both summary rows remain permanently in history. The earlier summary is never overwritten or deleted. The `reconciliation_summary_id` FK on shared remittances points to the most recently sealed of the overlapping set.

### FR-4: Re-Verification Before Seal
When user clicks "Check Reconciliation", service calculates and returns authoritative totals. When user later clicks "Seal Reconciliation": the service MUST recalculate all totals fresh from the database immediately before persisting. If the newly calculated totals differ from what was last "Checked" (statement CR/DR unchanged, but system CR/DR changed due to intervening edits/sync), seal MUST be rejected with a clear error message prompting the user to re-check.

### FR-5: Deterministic Duplicate Protection
A reconciliation identity is deterministically defined by: `(cooperative_id, bank_name, period_start, period_end)`. Before saving a new seal, the service MUST check that no non-deleted summary exists with this exact 4-part composite identity. If one exists, reject as duplicate. Random ID alone is not sufficient as identity for offline dedup.

### FR-6: Seal Performance — No N+1 Writes
Stamping `reconciliation_summary_id` onto remittances during seal MUST use the existing batch SQL (runSql UPDATE where) or `saveMany` / `upsertMany` mechanism for the local DB writes. Each remittance MUST still be individually enqueued for sync ONLY IF the existing architecture does not support bulk enqueue. The enqueue pattern itself MUST follow the app's design (identity in the queue, payload reloaded at push time).

### FR-7: Unseal Uses Correct Predicate
Unseal MUST soft-delete (`is_deleted = 1`) the summary row AND MUST clear `reconciliation_summary_id` ONLY on remittances where `reconciliation_summary_id = summaryId` (the exact FK match). Unseal MUST NEVER clear IDs based on date range, which would corrupt overlapping reconciliations.

### FR-8: Data-Layer Seal Enforcement on Mutations
The following remittance mutation paths MUST reject or raise an error when the remittance has a non-null `reconciliation_summary_id` that points to an existing non-deleted `bank_reconciliation_summary`:
- `updateRemittance` (edits)
- `deleteRemittance` (soft delete)
- `approveRemittance` / `declineRemittance` (status transitions) — but only for already-approved rows being re-mutated; approving a Pending row that falls in a reconciled range is allowed if it was not part of the original reconciliation set (i.e., reconciliation_summary_id is null). The enforcement is on the FK, not the date.
- `cleanupRemittanceFamily` cascades must also be blocked if parent is sealed.

The check MUST happen at the data-service layer (before saveDoc), not only in the UI. Error message must reference reconciliation sealing.

### FR-9: Real Reconciliation Status
Use the existing `bank_reconciliation_summary.status` field. Allowed values and their meaning:
- **Draft**: Not used for persisted rows (UI-only state before check).
- **Balanced**: A successful "Check" result where CR and DR differences are both under ₦0.01. (Not yet sealed.)
- **Discrepancy**: A "Check" result where either CR or DR difference is ≥ ₦0.01. (Not yet sealed.)
- **Sealed**: Persisted after successful seal operation. `is_deleted = 0` + `status = 'Sealed'`.
- **Unsealed**: After unseal. Row has `is_deleted = 1`; status optionally set to "Unsealed" for readability before overwrite by soft-delete semantics.

When persisting a seal, save the actual calculation result (the one that passed). Never hardcode status.

### FR-10: Reconciliation History
Below the main reconciliation workflow, show a list/table of all non-deleted `bank_reconciliation_summary` rows for the current cooperative (optionally filtered by selected bank). Columns using existing fields only:
- Bank / Account (`bank_name`)
- Date Range (derived from `period_start` → `period_end`)
- Statement CR / Statement DR (`bank_total_cr`, `bank_total_dr`)
- System CR / System DR (`system_total_cr`, `system_total_dr`)
- Difference (computed CR diff + DR diff)
- Status (`status`)
- Transaction Count (can be derived from remittance count matching `reconciliation_summary_id` at render time, or stored implicitly)
- Sealed Date / Sealed By (`created_at`, `created_by`)

Clicking a history row populates the main form for inspection (read-only mode) and shows associated remittances.

### FR-11: Discrepancy Drill-Down
When reconciliation status is Discrepancy, provide a section listing all Approved remittances in the selected date range for the selected bank, using fields available on remittance + joined member:
- Date (`remittance_date`)
- Member (lookup via `member_id`)
- Reference / Description (`description`)
- Amount (signed `amount`)
- CR/DR indicator (positive = CR, negative = DR)
- Status (`status`)
- Loan/Payment context (from `transaction_type`, `category`, `loan_id`)
- Reconciliation state (`reconciliation_summary_id` → linked summary status)

### FR-12: Calendar-Based Date Selection
Replace the month dropdown + scattered date inputs with a single unified calendar date range picker component:
- Month navigation (prev/next)
- Click start date, click end date to select range
- Visual legend:
  - **Green**: Date appears in any sealed (non-deleted) reconciliation for the selected bank. Informational only; NOT a lock.
  - **Selected range highlight**: Currently chosen From/To (distinct visual state from green).
  - **Normal**: No reconciliation history.
- Because overlapping is allowed, user can still select a range that includes green (previously reconciled) dates.

### FR-13: Cohesive Page UX
Reorganize the page into a single coherent workflow (not duplicated or scattered):
1. **Header**: Title + short subtitle
2. **Bank selection**: Single dropdown to pick the account
3. **Date range**: Prominent "From [date] → To [date]" with calendar widget below
4. **Statement Totals**: Inputs for Bank CR, Bank DR
5. **System Totals**: Service-calculated System CR, System DR + CR Difference, DR Difference
6. **Status block**: Shows current status (Draft / Balanced / Discrepancy / Sealed)
7. **Action bar**: 
   - Primary: "Check Reconciliation" → always visible until Sealed
   - On Balanced + not Sealed: "Seal Reconciliation"
   - On Discrepancy: "Investigate Difference" (expands drill-down)
   - On Sealed + has unseal permission: "Unseal"
8. **History section**: Grid of past reconciliations; click to inspect
9. **Details/Drill-Down**: Expandable section or modal showing contributing records

### FR-14: UI Implementation Quality
- Remove the duplicate "Parameters" cards and duplicate `id="recon-month"` elements.
- Stop using `innerHTML`/`getElementById` as application state. Adopt a small in-memory state object that is rendered via a unified `render()` function pattern (consistent with other CoopLogNG screens).
- Stop parsing `.innerText` for numeric values under all circumstances.
- Keep inline styles only where the existing app uses them; use CSS classes where available.
- Do not introduce large frameworks.

### FR-15: Remove Obsolete Logic
- Remove `getReconciliationTotals` (old monthly function) from the service; keep ONLY `getReconciliationTotalsByDateRange` (renamed to `getReconciliationTotals` for clarity).
- Remove all references to `period_month`-driven logic from the UI and service.
- Remove hardcoded months array entirely.
- After confirming no callers remain, delete old-style stubs.

### FR-16: Accounting Pack Compatibility
Update the Bank Reconciliation mapping in the Accounting Pack:
- **Period column**: Build from `period_start` → `period_end` instead of `period_month`.
- **In-period detection**: Use date overlap logic: summary's `[period_start, period_end]` overlaps the pack's `[from, to]` range, instead of month-only match.
- All other existing columns (status, bank, CR/DR values, difference) continue to work from existing fields. No new fields invented.

### FR-17: Offline / Sync Behavior Preserved
- All writes continue through `saveDoc` → `enqueueWrite` path. Identity-only queue entries. Payload reloaded from IndexedDB at push time.
- `bank_reconciliation_summary` remains in all the existing sync-scan lists (reconcileUnsyncedQueue, scanAndEnqueueUnsynced, bulkEnqueueUnsynced). No changes to sync architecture.
- No realtime listeners. No admin SDK. No bypass of outbox.

## Non-Functional Requirements
- **NFR-1**: Seal operation for 500 remittances MUST complete in under 2x the time of a single remittance write (avoid per-remittance saveDoc overhead).
- **NFR-2**: History list loads 100 reconciliation summaries in under 1 second.
- **NFR-3**: Calendar renders 12 months with per-day green marking in under 200ms.
- **NFR-4**: All new code must use existing error boundaries (try/catch + toast + console.error).
- **NFR-5**: All new status values MUST pass Firestore validation; no schema rule changes (existing rule only checks presence of `period_month` which we still populate for backward compat).

## Constraints
- **Technical**: No new database fields/tables. Must use ONLY columns listed in TABLE_COLUMNS. No large frontend framework. No Firebase Admin SDK. No realtime listeners.
- **Business**: Preserve all existing accounting math for CR/DR classification (positive amount = CR, negative = DR, Approved status only, Internal Transfer bank excluded already). Overlapping reconciliations are allowed — never auto-reject based on date overlap alone.
- **Dependencies**: The app already ships with no test framework; tests will be added as a simple Node/ESM harness using the existing SQLite module if possible, or as a plain JS test file that can be run in the browser console / test page.

## Assumptions
- `period_month` can still be populated as a derived string (e.g., from period_start's YYYY-MM) to satisfy the Firestore write rule which requires `period_month` presence.
- Users with `admin` role continue to be the only ones who can unseal.
- `reconciliation_summary_id` on remittance pointing to a non-deleted summary means "this remittance is sealed". Overlapping reconciliations update this FK to the latest sealed summary that included the remittance. Audit history is preserved in bank_reconciliation_summary rows themselves.
- The ₦0.01 tolerance (strictly less than 0.01) for both CR and DR independently is the existing business rule and will be preserved.

## Acceptance Criteria

### AC-1: Authoritative Service — Single Calculation Engine
- **Type**: `rule`
- **Given**: Any screen or module needs reconciliation totals
- **When**: It calls for reconciliation data
- **Then**: It uses exactly one exported function from `services/data/reconciliation.js` and never does its own CR/DR math or query remittances directly for reconciliation purposes
- **Pass Condition**: Grep for `amount > 0` / `amount < 0` / `systemCr` / `systemDr` patterns outside reconciliation.js returns zero results, AND the old `getReconciliationTotals` (monthly LIKE version) function is deleted or unreachable
- **Evidence**: Code review of reconciliation.js + grep output + UI call sites

### AC-2: Dynamic Date Range — Daily Works
- **Type**: `rule`
- **Given**: Select same date for From and To (e.g., 2026-09-21 → 2026-09-21)
- **When**: Check Reconciliation is clicked
- **Then**: Only remittances with `remittance_date` = that exact date are included in system totals
- **Pass Condition**: Service-level test with seeded data confirms daily filtering matches expected CR/DR exactly
- **Evidence**: Test output for TR covering daily

### AC-3: Dynamic Date Range — Partial Month Works
- **Type**: `rule`
- **Given**: Select From=2026-09-11 To=2026-09-20
- **When**: Check is performed
- **Then**: Only remittances 09-11 through 09-20 inclusive contribute; Sep 1-10 and Sep 21-30 excluded
- **Pass Condition**: Test with seeded data for 30 days in Sept, each day one CR + one DR of ₦1; partial range returns ₦10 CR ₦10 DR
- **Evidence**: Test output

### AC-4: Dynamic Date Range — Full Month Works
- **Type**: `rule`
- **Given**: From=2026-09-01 To=2026-09-30
- **When**: Totals calculated
- **Then**: All September Approved remittances for the bank included (no filtering by month string format)
- **Pass Condition**: Same seeded Sept data; full range returns ₦30 CR ₦30 DR
- **Evidence**: Test output

### AC-5: Overlapping Ranges Allowed
- **Type**: `rule`
- **Given**: Reconciliation A (Sep 1-20) is already Sealed (summary row exists, is_deleted=0)
- **When**: User selects Sep 11-30 and goes through Check → Seal
- **Then**: Second seal succeeds; BOTH summary rows exist in bank_reconciliation_summary (is_deleted=0, different ids); Reconciliation A's bank_total_* and system_total_* values are unchanged
- **Pass Condition**: After Seal B, query for both summaries by id returns intact rows with original values; count = 2
- **Evidence**: Test output + DB dump

### AC-6: Overlapping Ranges — Previous Reconciliation Intact in History
- **Type**: `rule`
- **Given**: Scenario from AC-5
- **When**: History list is rendered
- **Then**: History shows BOTH entries with correct distinct dates, bank totals, system totals, and created_at/created_by
- **Pass Condition**: DOM inspection or history data structure contains both summaries with correct fields
- **Evidence**: Test + UI screenshot / rendered data dump

### AC-7: ₦0.01 Tolerance
- **Type**: `rule`
- **Given**: Bank CR = System CR + 0.009; Bank DR = System DR + 0.009
- **When**: Check performed
- **Then**: Status is Balanced (both diffs strictly < 0.01)
- **Pass Condition**: Service returns status Balanced
- **Evidence**: Test output

### AC-8: CR Discrepancy Detected
- **Type**: `rule`
- **Given**: Bank CR = System CR + 100; Bank DR matches
- **When**: Check performed
- **Then**: Status = Discrepancy; CR Difference = 100.00; DR Difference = 0.00
- **Pass Condition**: Service returns Discrepancy + correct numeric diffs
- **Evidence**: Test output

### AC-9: DR Discrepancy Detected
- **Type**: `rule`
- **Given**: Bank DR = System DR + 50; Bank CR matches
- **When**: Check performed
- **Then**: Status = Discrepancy; DR Difference = 50.00
- **Pass Condition**: Service returns Discrepancy + correct diff
- **Evidence**: Test output

### AC-10: Re-Verification Before Seal — Data Unchanged
- **Type**: `rule`
- **Given**: User performs Check, gets Balanced. Underlying data not modified.
- **When**: User clicks Seal
- **Then**: Service internally re-queries totals; they match; seal proceeds
- **Pass Condition**: Summary row created with correct totals; seal promise resolves successfully
- **Evidence**: Test output

### AC-11: Re-Verification Before Seal — Data Changed Between Check and Seal
- **Type**: `rule`
- **Given**: User performs Check at t1 (balances). Between t1 and t2 when Seal is clicked, a new Approved remittance is added that changes system totals.
- **When**: Seal is clicked
- **Then**: Seal rejects with error "Underlying data changed since last check; please re-check reconciliation." No summary row created. No remittances stamped.
- **Pass Condition**: Test simulates the race; seal throws and transaction count pre/post shows no new summary
- **Evidence**: Test output showing thrown error + DB state unchanged

### AC-12: Deterministic Duplicate Prevention — Same Range Twice
- **Type**: `rule`
- **Given**: Reconciliation for cooperative C, bank B, dates [D1,D2] already sealed (non-deleted)
- **When**: Attempt seal for identical (C, B, D1, D2)
- **Then**: Rejected with "This exact date range has already been reconciled."
- **Pass Condition**: saveReconciliationSummary throws; count of summaries for the 4-part key stays at 1
- **Evidence**: Test output

### AC-13: Seal Uses Correct Totals (Not DOM)
- **Type**: `rule`
- **Given**: Balanced reconciliation
- **When**: Seal is initiated
- **Then**: The saved summary's `system_total_cr` / `system_total_dr` come from a fresh DB query inside saveReconciliationSummary, not from parameters read off the UI
- **Pass Condition**: Code inspection shows saveReconciliationSignature signature and body does NOT accept pre-computed system totals; it takes only bank totals, date range, bank, cooperative, and performs its own query. OR: it takes a checkToken/hash and recomputes; either way UI-provided systemCr/systemDr are not saved
- **Evidence**: Code review of seal path + test that intentionally passes wrong systemCr to seal function and verifies correct values persisted

### AC-14: Unseal Correctly Uses Summary ID Predicate
- **Type**: `rule`
- **Given**: Summary REC-A (Sep 1-20) and REC-B (Sep 11-30) both sealed. Remittances in overlap (Sep 11-20) currently have `reconciliation_summary_id = REC-B.id`. Remittances Sep 1-10 have `reconciliation_summary_id = REC-A.id` (since they are only in REC-A).
- **When**: Unseal REC-B
- **Then**: (1) REC-B.is_deleted = 1; (2) ONLY remittances with reconciliation_summary_id = REC-B.id have it nulled (Sep 11-20 overlap); (3) Sep 1-10 remittances STILL carry REC-A.id UNCHANGED; (4) REC-A row untouched (is_deleted still 0)
- **Pass Condition**: SQL query after unseal confirms predicate-based clearing, not date-based
- **Evidence**: Test output per-remittance reconciliation_summary_id values before and after unseal

### AC-15: Seal Enforcement Blocks Edit of Sealed Remittance
- **Type**: `rule`
- **Given**: Remittance R has reconciliation_summary_id set to REC-A.id which exists and is_deleted=0
- **When**: updateRemittance(R.id, { amount: ... }) is called at the data service layer
- **Then**: Throws error "Cannot edit a reconciled remittance. Unseal the associated reconciliation first."
- **Pass Condition**: Test that edit call throws; no DB change to R.amount
- **Evidence**: Test output

### AC-16: Seal Enforcement Blocks Delete
- **Type**: `rule`
- **Given**: Same setup as AC-15
- **When**: deleteRemittance(R.id) called
- **Then**: Throws same-sealing error; R.is_deleted remains 0
- **Evidence**: Test output

### AC-17: Seal Enforcement Allows Edit of Non-Sealed Remittance In Same Date Range
- **Type**: `rule`
- **Given**: REC-A sealed (Sep 1-20). A new Pending remittance R2 is created with remittance_date = Sep 15 and approved → reconciliation_summary_id is NULL (because it was approved AFTER REC-A was sealed, so R2 was never included in any seal set)
- **When**: updateRemittance(R2.id, ...) called
- **Then**: Succeeds. Enforcement is FK-based, not date-based.
- **Evidence**: Test output

### AC-18: Status Correctly Persisted
- **Type**: `rule`
- **Given**: Balanced check → seal; discrepancy check (no seal); sealed; unsealed
- **When**: Each state saved
- **Then**: bank_reconciliation_summary.status reflects actual state ('Sealed' for persisted sealed rows; interim check states preserved in object returned from check function even if not persisted)
- **Pass Condition**: Query after seal returns status='Sealed'; check function returns status reflecting actual balance result
- **Evidence**: Tests + DB assertions

### AC-19: Calendar Shows Green for Previously Reconciled Dates
- **Type**: `rule`
- **Given**: REC-A sealed Sep 1-20 for bank "Main Bank". User selects bank "Main Bank".
- **When**: Calendar renders September
- **Then**: Days 1-20 of September have "previously reconciled" visual state (green tint/indicator). Day 21-30 normal. Green is informational; user can still select a new range encompassing green days.
- **Pass Condition**: UI DOM inspection or render data shows correct per-day flags
- **Evidence**: UI screenshot + rendered data

### AC-20: History Section Renders Correctly
- **Type**: `rule`
- **Given**: Multiple sealed reconciliation rows exist for a cooperative
- **When**: Reconciliation screen History section renders
- **Then**: Each row displays Bank, Date Range (period_start → period_end), Bank CR/DR, System CR/DR, Difference, Status, Created, Created By. Clicking a row opens inspection view without mutating data.
- **Pass Condition**: Rendered data matches DB values; count of rendered history rows equals count of non-deleted summaries in scope
- **Evidence**: Rendered output dump

### AC-21: Discrepancy Drill-Down Lists Contributing Records
- **Type**: `rule`
- **Given**: Bank CR differs from System CR by ₦5,000 (Discrepancy state)
- **When**: "Investigate Difference" is shown/expanded
- **Then**: A table of all Approved remittances in the date range for the bank appears, with Date, Member, Description, Amount, CR/DR, Status, Reconciliation State. Each row's data comes from actual DB remittance + member lookup (no fabricated data).
- **Pass Condition**: Number of drill-down rows = number of Approved remittances in the range; row data fields verified against DB
- **Evidence**: Test output comparing row count and sample rows

### AC-22: Accounting Pack Bank Reconciliation Sheet Continues to Work
- **Type**: `rule`
- **Given**: Reconciliation summaries exist with arbitrary date ranges (some daily, some partial month, some full)
- **When**: buildAccountingPack run with startDate/endDate that overlaps some of them
- **Then**: (1) Excel workbook contains Bank Reconciliation sheet; (2) Each overlapping summary is listed; (3) Period column shows full date range (start→end), not just YYYY-MM; (4) In-period flag computed correctly by overlap, not month match; (5) Difference column correctly computed from existing fields
- **Pass Condition**: Generated sheet headers and rows match the new mapping; no invented fields used
- **Evidence**: Accounting pack test output + sample sheet data dump

### AC-23: No New Fields Invented
- **Type**: `rule`
- **Given**: All changed files diffed
- **When**: Reviewer scans for any reference to non-existing DB columns (sealed_at, sealed_by, start_date, end_date, difference_cr, difference_dr, reconciliation_date, etc.)
- **Then**: No such references exist. All persistence uses columns defined in TABLE_COLUMNS only.
- **Pass Condition**: Grep for candidate invented columns across src/ returns no DB write hits
- **Evidence**: Grep output + code review

### AC-24: Old Monthly Logic Removed
- **Type**: `rule`
- **Given**: Post-cleanup codebase
- **When**: Search codebase for the old patterns: hardcoded `months` array, `period_month LIKE ?` style queries, `getReconciliationTotals` function without date-range signature
- **Then**: Old function deleted; no dead monthly engine code paths remain reachable
- **Evidence**: Codebase grep output

### AC-25: Offline Architecture Preserved
- **Type**: `rule`
- **Given**: Seal operation performed offline (no network)
- **When**: Ensuing sync push cycle runs
- **Then**: Summary row + updated remittance rows reach Firestore through outbox (identity-only, payload reloaded); sync queue drains; is_synced flags set to 1; no new sync mechanism introduced
- **Pass Condition**: Test/simulation shows items in sync_queue with correct collection_name/document_id after seal, before push
- **Evidence**: Sync queue dump after seal operation

### AC-26: UI No Longer Relies on innerText for Accounting Values
- **Type**: `rubric`
- **Dimension**: Reliance of UI on DOM text as source of numeric truth
- **Scale**: 1-5
- **Anchors**: 1 = seal still parses innerText / relies on displayed values as source of truth; 3 = seal uses service but check results still stored in hidden DOM elements read later; 5 = All calculations exclusively in in-memory state object or service returns; no numeric extraction from DOM at any point
- **Pass Threshold**: >= 4
- **Evidence**: Code review of Reconciliation.js event handlers; grep for innerText/innerHTML combined with parseFloat in reconciliation UI file

### AC-27: UI Cohesion and Structure
- **Type**: `rubric`
- **Dimension**: Page layout follows the single-workflow structure described in FR-13
- **Scale**: 1-5
- **Anchors**: 1 = Still has duplicate cards, duplicate IDs, scattered buttons/sections; 3 = Single logical flow but some inline-style bloat remains, calendar not fully integrated; 5 = Clean Header → Bank → Date Range (with calendar) → Statement → System → Status → Actions → History → Drill-Down structure; no duplicate IDs/DOM; uses in-memory state + single render function
- **Pass Threshold**: >= 4
- **Evidence**: Visual UI screenshot + DOM tree dump (showing no duplicate IDs)

### AC-28: Seal Performance (Batched Local Writes)
- **Type**: `rubric`
- **Dimension**: Seal avoids N+1 per-remittance saveDoc calls for the local DB stamp
- **Scale**: 1-3
- **Anchors**: 1 = Still loops saveDoc + enqueueWrite per remittance for BOTH IndexedDB writes AND sync; 2 = Local DB writes batched via runSql UPDATE or saveMany, but enqueueWrite still called per remittance (acceptable because enqueueWrite is already deduplicated/identity-only per document); 3 = Local DB batched AND enqueueWrite also uses bulk form where available
- **Pass Threshold**: >= 2
- **Evidence**: Code review of seal path in reconciliation.js

## Open Questions
- [ ] None. All schema questions resolved: existing fields are sufficient. Sealed By = `created_by`, Sealed At = `created_at`.
