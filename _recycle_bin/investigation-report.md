# Accounting Pack Investigation Report (A–J)

### A. Database Structure
- 28 tables in `sampledata.db`; all fields stored as `TEXT`.
- No foreign‑key constraints; relationships are by `cooperative_id` and denormalised IDs only.
- Key tables: `remittance` (2,677 approved rows), `remittance_detail` (2,676 rows), `enterprise` (6 rows), `members` (1,171 rows), `loans` (13 rows), `transaction_types` (23 rows with 14 classification values), `bank` (3 rows).
- `is_deleted` may be `NULL`, `'0'`, or `'1'`; the model treats `NULL` as non‑deletion and `'1'` as deleted.

### B. Transaction Sources
- Originate from the app's remittance header (`remittance`) → detail rows (`remittance_detail`).
- Member legs flow via `enterpriseAccount()` derived from `enterprise.account_type` (Savings/Loan) and `revenue`/`is_penalty`/`compulsory_due` flags.
- Classification leg applied when header category is Income/Expense/Cooperative Asset; internal‑transfer postings carry `bank_name "Internal Transfer"` → non‑cash memo only.
- No new tables or columns created.

### C. Member Accounting Flow
- `enterpriseAccount()` maps each enterprise to a bucket (`loan`, `asset`, `expenseEnt`, `revenueEnt`, `due`, `savings`, `liability`, `equityEnt`).
- Member legs post `|amount|` to that account with side per the account's normal balance (savings/liability = credit‑normal, loan/asset = debit‑normal).
- Stored `members.account_balance`/`account_balance_total` are unreliable (21 of 1,171 null); correct method: derive from posted `remittance_detail` amounts with `enterpriseAccount()` bucket mapping.

### D. Loan Accounting Flow
- `loans.remittance_id` links to a remittance; `loans.admin_fee_id` optional.
- Detail rows carry `loan_info`; `loanAccountAmount` is the negated sum of detail movements attributed to the loan.
- Opening `+ disbursements − principal repaid = closing` roll‑forward (C14).
- Cooperative pseudo‑member `0000000000` excluded from member counts.
- Loan‑register outstanding derived from underlying postings, not a stored balance.

### E. Remittance Flow
- `remittance` (header + bank leg) → `remittance_detail` (member/enterprise leg).
- Bank name decides cash vs internal‑transfer: `Internal Transfer` is non‑cash memo.
- `Approved` status = `Status` column; `approved_by` does not exist in schema; approval evidenced by status alone.

### F. Enterprise Classification
- `enterprise.account_type` (Savings/Loan) drives bucket via `enterpriseAccount()`.
- `revenue` TRUE/FALSE, `compulsory_due`/`is_penalty` flag `due` bucket.
- `transaction_types.classification` supplies the authoritative 14‑class vocabulary; `remittance.category` is a coarse subset (8 values). Internal‑transfer rows excluded from cash/income.

### G. Existing Report Calculations
- Trial balance opening/period/closing balances from remittance detail cumulative sums.
- Controls C1–C15: C1 closing‑difference integrity, C2 opening‑difference, C3 posting‑completeness, C4 cash‑book continuity, C5 member‑vs‑TB, C6 loan‑register vs loan accounts, C7 income detail, C8 expense detail, C9 internal‑transfer memo, C10 cooperative pseudo‑member, C11 unattributed loan movements, C12 capitalised‑asset separation, C13 one‑legged non‑cash entries, C14 loan receivable roll‑forward, C15 gross member credits less debits.
- Exception severity: High/Medium/Low (786 rows: High 24, Medium 234, Low 528). Soft‑delete NULL treated as non‑deletion (3 rows). No balancing “plug” figure.
- **Unknown Payments** (payments whose owner is not yet identified) are listed as a separate finding on the Data Quality Exceptions sheet, with an explanation that the payment awaits owner reassignment; they do not affect the control totals.

### H. Accounting Classification
- INCOME_CATS = {Revenue, Operating Income, Loan Income, Other Income}; EXPENSE_CATS = 14 categories including Welfare/Finance/Operating; COOP_ASSET_CATS = {Asset, Fixed Asset}; NON_POSTING_CATS = {Transfer}. 
- The category "Suspense" has been retired; any payments that the bookkeeper cannot assign to a member or enterprise are now classified as **"Unknown Payment"** and reported separately on the Data Quality Exceptions sheet. 
- If the owner is identified in the future, the payment can be reassigned to the appropriate member or enterprise account. 
- RECOGNISED_CATS = union of INCOME_CATS, EXPENSE_CATS, COOP_ASSET_CATS, NON_POSTING_CATS, and MEMBER_CATS = {Member Liability, Loan Asset, Liability, Equity}. 
- `writeTable` keys map category → bucket (e.g. Income → `income`, Expense → `expense`, MEMBER_CATS entries → loan/liability/equity/savings). 
- Unrecognised categories that are not "Unknown Payment" are reported as unknown on the Data Quality Exceptions sheet, with an explanation that the payment awaits owner identification.

### I. Member Liability Calculation
- `buildAccountBalance` accumulates `openingNet + periodNet` across MEMBER_BUCKETS ['savings','due','liability','equityEnt','asset','loan'] to produce `memberClosingTotal`.
- Stored DB `account_balance`/`account_balance_total` are **not** authoritative (21 nulls out of 1,171). Correct calculation derives liability from posted remittance_detail amounts with `enterpriseAccount()` bucket mapping.

### J. Proposed Accounting Pack Sheets
- 14 sheets in fixed order: Cover & Basis | Control Checks | Trial Balance | General Ledger | Cash & Bank Book | Member Accounts | Loan Register | Loan Movements | Income Detail | Expense Detail | Account Mapping | Bank Reconciliation | Transaction Audit Trail | Data Quality Exceptions.
- Cover sheet advertises the 14‑sheet list; headers frozen, filters enabled, totals on GL/TB/Member sheets; exception summary on Exceptions sheet.
- No preview step; direct download `CoopLogNG_Accounting_Pack_<start>_to_<end>.xlsx`.
- Generation date/time on header.