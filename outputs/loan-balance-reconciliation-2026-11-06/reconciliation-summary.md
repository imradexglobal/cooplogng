# Loan balance precision reconciliation preview

**Source:** `cooperative_backup_2026-11-06T13-24.db`  
**Cooperative:** The Muslim Stars Association (TMSA)  
**SHA-256:** `fb7f5902d93ef30bed415e911334ffa0e7319391ce828d5858efc809180d18e4`  
**Database integrity:** `ok` (SQLite integrity check; source opened read-only)

## Proposed scope

Balances were recalculated from non-deleted details of Approved remittances, grouped by member and active enterprise with `account_type = Loan`, matching the app's account-balance approach. Numeric values were summed with decimal arithmetic. The app's `loans` table is empty in this extract, so the approved-remittance ledger is the source of these balances.

- **320** candidate member/loan-account corrections total: **58** balances with absolute value under ₦1 (clear to zero), and **262** balances above ₦1 with a fractional-naira part (move only that fraction, leaving a whole-naira balance).
- **204** members are affected.
- Each row in the CSV represents one proposed Approved remittance with **amount 0**, date **2026-11-06**, bank **Internal Transfer**, header type **Internal Transfer**, category **Transfer**, and two equal/opposite details: Ordinary Savings `-1 × loan_detail_delta`, and the target Loan enterprise `loan_detail_delta`.
- These header values match the app's mixed Savings+Loan internal-transfer classification (`Internal Transfer` / `Transfer`).
- Description: `Loan balance precision reconciliation — Ordinary Savings offset`.
- If applied as proposed, each loan-account balance becomes exactly zero for under-₦1 rows or a whole-naira value for larger rows.

## Ordinary Savings safety check

To avoid overdrawing a member's Ordinary Savings, proposed rows are marked **READY** only if that member's combined savings balance remains nonnegative after all proposed corrections. **314 rows for 199 members are READY. 6 rows for 5 members are HOLD** because their combined adjustment would make Ordinary Savings negative. The CSV includes each member's before/after savings balance and the individual proposed detail amounts.

The five held members are registration numbers: **128, 232, 263, 264, 35**. Their rows must not be posted without your decision on funding.

## Amount checks

- Net loan-detail delta across all 320 rows: **₦125.46** (the balancing Ordinary Savings delta is **₦-125.46**).
- Net loan-detail delta in READY rows: **₦122.36**; balancing savings delta: **₦-122.36**.
- Net loan-detail delta in HOLD rows: **₦3.1**; balancing savings delta: **₦-3.1**.
- Every proposed remittance header sums to zero and each pair of details nets to zero.

## Data precision observation

The source extract's current Approved remittance-detail values and resulting candidate loan balances show at most **two decimal places**; no existing 3+ decimal residual (such as ₦0.12987) was found in the audited live ledger. The audit therefore identifies kobo fractions present in this backup, rather than additional sub-kobo fractions.

## Enterprise accounts with candidates

- Accrued Profit: 46
- COT: 27
- Contingency Loan: 2
- Development Due: 1
- General Purchase: 31
- Investment: 12
- Ordinary Loan: 129
- Special Investment: 10
- Special Item: 62

## Files and next step

- `proposed-remittances.csv` is the row-by-row review preview. It is not an import file and no database has been changed.
- The original `.db` file remains untouched. After you confirm the READY-only scope and decide what to do with HOLD rows, a reconciled **copy** can be created and verified before delivery.
