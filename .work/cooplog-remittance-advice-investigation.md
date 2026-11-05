# Cooplog Remittance Advice: Investigation and Implementation Design

Date: 2026-11-04
Scope: Implement calculated Remittance Advice across current Remittance entry, historical remittance views, and the Payment Advice report while preserving stored raw advice.

## Stage 1 — Existing workflow findings

### Advice storage and retrieval

- Raw advice is held in the SQLite `payment_advise` table (schema declared in `src/services/sqlite/constants.js`). Its relevant columns are `id`, `cooperative_id`, `member_id`, `enterprise_id`, `amount`, timestamps/audit fields, and soft-delete/sync fields.
- `fetchMemberPaymentAdvise(memberId)` in `src/services/data/members.js` selects active advice rows by member (`is_deleted = 0`). The query does not currently include cooperative ID, relying on member IDs to be globally unique.
- Member forms and the Payment Advice screen save amounts with `updateMemberPaymentAdvice`; member creation/update also serializes `payment_advise`. Loan approval can set an installment amount as advice. The Remittance calculation must remain read-only with respect to these raw rows.
- Multiple active rows are possible; the Remittance screen currently sums matching rows by enterprise. Other paths sometimes use last-write mapping, so a shared calculator must explicitly aggregate raw values consistently.

### Enterprise categories and settings

- `enterprise` fields: `account_type` (including Savings and Loan), `compulsory_due`, `compulsory_amount`, `is_penalty`, and `revenue` (`src/services/data/enterprises.js`, schema in `src/services/sqlite/constants.js`).
- Compulsory amount is explicitly `compulsory_amount`; there is no need for a new field.
- Existing display logic recognizes loan by lower-cased `account_type`, and identifies due/penalty using flags. Revenue is a separate flag.
- Required precedence is Penalty, Compulsory Due, Revenue, Loan, Savings. Conflicting flags can be resolved deterministically using this order; runtime data should be checked before implementation and the chosen logic covered with tests.

### Current Remittance workflow

- Selecting a member calls `loadMemberBalances` in `src/screens/Remittance/remittancePage.js`.
- New-remittance balances call `buildAccountBalance(cooperativeId, user)` with no cutoff; historical/edit form balances pass `{date, ts, id}` for the selected remittance.
- Advice is then fetched independently with `fetchMemberPaymentAdvise` and aggregated into `paymentAdvise[enterprise_id]`.
- `src/screens/Remittance/remittanceRender.js` (initial render) and `src/screens/Remittance/remittanceEventListeners.js` (table refresh) render Enterprise, Opening, Advise, Input, Closing. Advise currently reads `paymentAdvise[e.id]`; zero renders as `-`, otherwise two locale-formatted decimals. It also keeps rows visible if advice is non-zero.
- Opening and Closing are distinct from Advice. Closing is Opening plus the current typed detail amount for financially active records.
- On member change, balances and advice are reloaded. Auto Share separately loads raw advice and uses the shared allocator; integrating computed advice should be evaluated so it does not continue using stale/raw loan advice.

### Balance calculations and historical ordering

- Canonical implementation is `buildAccountBalance` in `src/services/data/balance.js`.
- Its stated total order is **remittance_date (or created_at fallback) → created_at → id**. `compareCutoff` compares these values, using local date normalization, then string comparison for timestamp and ID.
- With a cutoff, `buildAccountBalance` excludes the selected item and every later item (`pastCutoff(..., false)` excludes comparison >= 0), leaving the opening balance immediately before the selected remittance. Only status `Approved` contributes. Member scoping is applied; enterprise revenue treatment excludes pure-revenue entries from member balances but includes dues/penalties even when also revenue-flagged.
- This is the existing authoritative transaction convention to reuse for historical loan advice. It is not simply date plus ID: created_at is the tie-breaker before ID. Same-day ordering must preserve that established convention.
- Loan repayment amounts are already represented in enterprise balance from approved remittance details, so the same account balance should be used rather than introducing another loan ledger engine. Negative balances/adjustments need care: advice formula is clamped to nonnegative before MIN(raw, balance), per requirements.

### Save, approval, history, and sync

- Remittance detail rows carry `enterprise_id`, signed `amount`, and optional `loan_info`; persistence and approval logic are in `src/services/data/remittances.js` and loan operations in `src/services/data/loans.js`.
- Approved-only balances protect pending transactions from affecting advice. Existing approval creates/updates loan records and may update payment advice; computed advice must not write back to `payment_advise`.
- SQLite/offline data and sync include `payment_advise`; no schema migration should be needed. Use existing query/service APIs and do not touch sync representation.
- Remittance history sorts newest-first by date, created_at, then ID in `remittancePage.js`; the balance engine uses the same order ascending for cutoff comparisons.

### Reports and print/export surfaces

- `Payment Advice` report is `payment_advise` in `src/services/reports/reportTypes.js`, built by `getPaymentAdviseData` in `src/services/reports/memberReports.js`. It currently aggregates raw active advice by member and enterprise; this must be changed to current-context calculated advice.
- The general Remittance list, schedule, EOD, accounting, and history exports report posted remittance transactions, not the advice column itself; they should not acquire advice calculations unless an advice value is actually shown.
- Payment Advice member screen (`src/screens/PaymentAdvice.js`) edits raw advice and also displays member account balances. It is not the same as the remittance distribution panel. Ensure raw inputs remain editable/stored as raw amounts; calculated display semantics should only be applied where advice is being presented as advice, per requested scope.
- Individual remittance preview is loaded through `loadRemittanceToForm` in `remittanceEventListeners.js`; the Remittance table is visible there. `src/components/TransactionModal.js` and `src/screens/Remittance/remittanceModal.js` are transaction detail/review modals and compute opening balances with the same cutoff for relevant withdrawals. No distinct advice-specific print generator was located in the inspected paths. The Payment Advice report's normal preview/export/print pipeline in `Reports.js` should use the same calculated result it previews.
- The Remittance history Excel export (`remittanceExport.js`) exports transaction headers, not the distribution detail or Advise column. Confirm whether another print route exists before implementation; do not claim it contains Advise absent evidence.

## Stage 2 — Findings summary

Current Advise is a per-enterprise sum of active raw advice records and is shown identically for new and historical remittances. Current loan balances are available from `buildAccountBalance` with no cutoff; historical opening balances for a selected remittance are available from the same service with `{date, ts, id}`. Existing report data uses raw advice and needs integration. Enterprise configuration already supplies every required classification and the compulsory amount.

## Stage 3 — Calculation design

Implement a shared read-only advice calculator in existing data/service architecture. Inputs: cooperative ID, member ID, enterprise rows, raw advice rows, context (`CURRENT` or `HISTORICAL`), and optional selected remittance cutoff (`date`, `ts`, `id`). Preload/reuse raw advice, enterprises and balance result where possible.

For each enterprise, aggregate active raw advice rows by enterprise (sum amounts). Then apply deterministic precedence:

1. `is_penalty` truthy → 0.
2. `compulsory_due` truthy → nonnegative `compulsory_amount`.
3. `revenue` truthy → nonnegative `compulsory_amount`.
4. `account_type` Loan → `max(0, min(rawAdvice, applicableBalance))`; CURRENT uses no cutoff, HISTORICAL uses the selected remittance cutoff via `buildAccountBalance`.
5. Otherwise → raw advice unchanged (ordinary savings and any other unclassified category retain stored advice, unless actual category review indicates a separate type).

CURRENT applies to new remittances and the Payment Advice report. HISTORICAL applies when opening an existing remittance and uses the selected entry's opening balance. Non-loan categories do not depend on balance context. The calculated map is presentation-only and must never be persisted.

Integration points anticipated: shared calculator; Remittance member load/change and historical record load; table render/refresh; Auto Share if it consumes advice for allocation; Payment Advice report builder. Maintain the existing `buildAccountBalance` as the sole authoritative balance engine.

## Investigation items resolved / limitations

- Existing selected-remittance loading sets `id`, `remittance_date`, and `created_at` before invoking `loadMemberBalances`; that function passes `{date, ts, id}` to the existing balance builder. Thus the historical calculated advice receives the immediate-pre-remittance balance and excludes the selected transaction itself.
- Enterprise settings/schema confirm `account_type`, `compulsory_due`, `compulsory_amount`, `is_penalty`, and `revenue`. The required precedence has been implemented and unit-tested. The local source inspection cannot inspect live cooperative data to report how frequently conflicting flags occur.
- The implementation intentionally preserves the established string comparison of `created_at` and `id` in `buildAccountBalance`; it does not invent a different sequence order. Dedicated multi-remittance database integration tests are not yet present; cutoff behavior is inherited from the canonical builder rather than duplicated.
- The project has no dedicated advice test script in `package.json`; the new tests can be run directly with `node --test tests/advice.test.mjs`.


## Implementation and verification status

Implemented the shared pure function in `src/services/data/advice.js` and exported it from the existing data service barrel. Remittance member loading now passes the existing `buildAccountBalance` result to this function; because historical records already load that builder with `{date, ts, id}`, the same existing cutoff governs historical loan advice. Auto Share now consumes the computed current/applicable advice map. The Payment Advice report preloads remittances and reuses them while calculating each member's current balances, then uses the shared calculation output for preview/export/print data. These changes do not write to raw advice rows.

Added `tests/advice.test.mjs`: all five focused tests pass (Savings raw amount and aggregation; Loan above/equal/below/zero/negative balance caps; Compulsory Due and Revenue settings; Penalty precedence; deleted-row filtering and raw-row immutability). `node --check` passes for all changed JavaScript modules and the test file. `git diff --check` reported no whitespace errors.

The production build could not complete in this run: `npm.cmd run build` failed while Vite/esbuild attempted to read the project config, with `Cannot read directory "../../..": Access is denied` and failure to resolve the existing `vite.config.js`. This is an environment access limitation, not an observed syntax error. The build should be rerun in a terminal context with access to the project directory.

Remaining limitation: there is no discovered dedicated printed individual-remittance distribution/Advice template in the inspected source paths. The Remittance history export contains header transaction information only. The Payment Advice report pipeline receives the calculated values, but verification of a generated PDF/browser print requires a runnable application environment. No database migration was introduced.

## Follow-up fixes (2026-11-04)

- Confirmed Cooplog loan-account balances are signed negative. Updated Loan Advice to cap against `abs(outstanding account balance)`, so a raw advice of 100 with a ledger balance of -20 yields 20, while -150 yields 100. Expanded the regression test for these signed values; the focused suite passes.
- Added a `Total Advise` footer row directly under the Advise column in Remittance Distribution.
- Ledger Summary (tab 2) now displays the filtered period's aggregate Debit and Credit totals above the respective desktop columns, plus equivalent total cards on mobile. Totals honor the active member/month/year filters and exclude enterprise accounts hidden by permissions.
- Syntax checks for the changed modules passed, and `git diff --check` reported no whitespace issues. Full production build remains unverified because of the previously noted local Vite/esbuild access-denied error.
