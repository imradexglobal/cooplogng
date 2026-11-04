# Consolidated bank transactions — revised mapping and import preparation

**Status: Mapping complete; 142 rows are prepared for user approval and 35 rows need specific accounting decisions. No backup or import has been performed.** This stage remained read-only as requested. The source workbook and target database were not modified.

## Bank identification — worksheet name is authoritative

The `bank_name` value proposed for every remittance is the exact Excel worksheet name. Both names match an existing active bank in the target database:

| Excel worksheet | `remittance.bank_name` | Target bank validation | Transactions | Debit rows | Credit rows | Debits | Credits | Missing references |
|---|---|---|---:|---:|---:|---:|---:|---:|
| FCMB | FCMB | MATCH | 79 | 51 | 28 | 24,864,905.10 | 27,590,097.02 | 43 |
| Fidelity Bank | Fidelity Bank | MATCH | 98 | 51 | 47 | 8,701,878.50 | 4,696,622.00 | 98 |

The row-level CSV records the proposed bank and exact-match result on every row. No new bank record is needed.

## Application and database findings

- Normal member deposits use an approved `remittance` header plus a positive `remittance_detail` against an existing Savings enterprise and `Member Deposit` / `Member Liability`. A member-linked debit uses a negative detail on an existing Loan enterprise and requires the loan-configuration lifecycle.
- Income and expense transactions use header-only remittances with a transaction type/category and the bank account; the accounting pack derives income/expense classifications from these headers. Member balances derive from approved remittance details.
- The existing `Unknown Payments` system type is classified as `Member Liability`. The app/accounting pack supports cooperative-wide Unknown Payments under reserved member ID `0000000000`; it offsets a cash entry to an unidentified-liability account. The target has no member row with this reserved ID, which is expected by the application's convention. This is distinct from the administrator user's ID `[{"id": "RACDA-3b80020c-26c0-4b28-a7e3-11684d063ade", "username": "RACDA", "role": "admin"}]`.
- The target banks are `FCMB, Fidelity Bank`. Existing enterprises are `[{"account_name": "Ordinary Savings", "account_type": "Savings"}, {"account_name": "Ordinary Loan", "account_type": "Loan"}]`. Target table counts are `{"app_settings": 0, "bank": 2, "bank_reconciliation_summary": 0, "cooperatives": 1, "enterprise": 2, "feedback": 0, "loan_guarantors": 0, "loans": 0, "members": 84, "membership_request": 0, "notifications": 0, "payment_advise": 0, "remittance": 0, "remittance_detail": 0, "sync_queue": 0, "sync_state": 1, "transaction_types": 0, "users": 1}`. Remittances = 0, remittance details = 0, loans = 0, active transaction types = 0, active reconciliations = 0.
- Important deployment distinction: the application runtime uses browser/Electron IndexedDB (`CoopLogIDB_v3`, database version 9). `src/services/sqlite/dbManagement.js` exports those stores to a SQLite file (`exportDatabase`) and `importDatabase` reads SQLite rows and upserts them back into the running IndexedDB. The target `new_file.db` is therefore a SQLite-format export/import file, not the app's live store. Editing the SQLite file alone would not update the running application; after approval, the actual import route must be chosen and verified. No live IndexedDB write or database-file edit has been made.
- The remittance table has no separate bank-reference field. Per your instruction, the CSV's **Transaction note to store** retains the original description and appends `Bank reference: <original reference>` when a reference exists; it does not modify the schema. The separate source-reference column is also preserved in the CSV.
- The target has only Savings and Loan enterprises, and no investment/security, tax-receivable, or bank-clearing account. The application’s ordinary Internal Transfer workflow is a non-cash reallocation through member/enterprise detail rows; the normal form does not support selecting the locked Internal Transfer type against an actual bank to move cash between two bank accounts.

## Source workbook and transaction completeness

Workbook: `C:\Users\User\Documents\Radio Project\Consolidated_Bank_Statements.xlsx`. Sheets: FCMB, Fidelity Bank. All **177** dated transaction rows are captured. [Open the row-level mapping CSV](transaction_mapping_preview_v3_20261104.csv). Signed amounts use credit as positive and debit as negative. Total debits are **₦33,566,783.60** across 102 debit rows; total credits are **₦32,286,719.02** across 75 credit rows. All totals and row counts agree with the workbook's own transaction summaries:

- **FCMB**: All stated row counts/amount totals match dated transactions.
- **Fidelity Bank**: All stated row counts/amount totals match dated transactions.

The running-balance column was intentionally excluded from the mapping and validation, as directed. The original description is kept as its own CSV column. There are 36 source references and 141 blank references. Exact duplicate signatures within the same worksheet (date, reference, direction/amount and description) found: **0**; none were excluded. Repeated/similar entries were retained as distinct source rows.

## Mapping totals

Member identification uses conservative unique exact first/last-name token matches against non-deleted target members. Name order can vary; ambiguous or partial matches are not assigned. The populated member fields available in the database were checked for exact mobile/account identifier matches in source descriptions/references; no additional reliable identifier matches were found. No account numbers or special IDs are populated in the target member records.

| Proposed classification | Rows | Debit total | Credit total |
|---|---:|---:|---:|
| Bank / financial expense | 71 | 13,315.56 | 2,010.10 |
| Investment / asset movement — review | 11 | 21,224,081.66 | 16,000,000.00 |
| Member savings contribution | 9 | 0.00 | 605,000.00 |
| Ordinary Loan candidate — loan terms required | 1 | 2,000,053.75 | 0.00 |
| Other Income | 19 | 0.00 | 313,086.92 |
| Potential bank-to-bank / cooperative transfer — review | 4 | 6,000,000.00 | 11,010,000.00 |
| Tax withholding — policy review | 19 | 31,308.70 | 0.00 |
| Unknown Payment | 43 | 4,298,023.93 | 4,356,622.00 |

Of these, 142 rows are structurally mapped to existing app types/accounts and are **prepared but not imported**, pending your explicit approval:

| Approval-ready category | Rows | Debit total | Credit total |
|---|---:|---:|---:|
| Bank / financial expense | 71 | 13,315.56 | 2,010.10 |
| Member savings contribution | 9 | 0.00 | 605,000.00 |
| Other Income | 19 | 0.00 | 313,086.92 |
| Unknown Payment | 43 | 4,298,023.93 | 4,356,622.00 |

The approval-ready set is 9 member savings credits (**₦605,000.00**), 43 Unknown Payments (debits **₦4,298,023.93**, credits **₦4,356,622.00**), 71 bank/financial expense rows (debits **₦13,315.56**, credit reversals **₦2,010.10**; net expense **₦11,305.46**), and 19 bank-interest income credits (**₦313,086.92**). Every proposed remittance uses the worksheet-matched bank name. Transaction notes retain each available reference.

## Remaining 35 rows — findings and recommended treatment

| Worksheet | Excel row | Date | Issue | Debit | Credit | Reference | Description |
|---|---:|---|---|---:|---:|---|---|
| FCMB | 4 | 2024-12-31 | Tax withholding — policy review | 12.96 | — | — | Withholding Tax for -1028059677 |
| FCMB | 6 | 2025-01-31 | Tax withholding — policy review | 17.60 | — | — | Withholding Tax for -1028059677 |
| FCMB | 8 | 2025-02-28 | Tax withholding — policy review | 15.99 | — | — | Withholding Tax for -1028059677 |
| FCMB | 10 | 2025-03-31 | Tax withholding — policy review | 17.81 | — | — | Withholding Tax for -1028059677 |
| FCMB | 12 | 2025-04-30 | Tax withholding — policy review | 17.34 | — | — | Withholding Tax for -1028059677 |
| FCMB | 14 | 2025-05-07 | Potential bank-to-bank / cooperative transfer — review | — | 5000000.00 | NIP/250507152645000075192004 | NIP FRM RACDA COOPERATIVE SOCIETY-NIPRADIO ARE |
| FCMB | 16 | 2025-05-22 | Investment / asset movement — review | 4781849.32 | — | 2020033785-SELL-BONDMMDISCOUNT | — |
| FCMB | 19 | 2025-05-22 | Investment / asset movement — review | 21815.07 | — | 2020033785-SELL-BONDMMDISCOUNT | — |
| FCMB | 22 | 2025-05-31 | Tax withholding — policy review | 1757.28 | — | — | Withholding Tax for -1028059677 |
| FCMB | 26 | 2025-06-30 | Tax withholding — policy review | 159.57 | — | — | Withholding Tax for -1028059677 |
| FCMB | 28 | 2025-07-31 | Tax withholding — policy review | 166.13 | — | — | Withholding Tax for -1028059677 |
| FCMB | 30 | 2025-08-21 | Investment / asset movement — review | — | 5000000.00 | — | MATURED_TBILL_21_08_2025 |
| FCMB | 31 | 2025-08-31 | Tax withholding — policy review | 1410.33 | — | — | Withholding Tax for -1028059677 |
| FCMB | 33 | 2025-09-30 | Tax withholding — policy review | 3560.80 | — | — | Withholding Tax for -1028059677 |
| FCMB | 35 | 2025-10-31 | Tax withholding — policy review | 3634.64 | — | — | Withholding Tax for -1028059677 |
| FCMB | 40 | 2025-11-30 | Tax withholding — policy review | 3583.55 | — | — | Withholding Tax for -1028059677 |
| FCMB | 42 | 2025-12-31 | Tax withholding — policy review | 3748.09 | — | — | Withholding Tax for -1028059677 |
| FCMB | 44 | 2026-01-31 | Tax withholding — policy review | 3771.30 | — | — | Withholding Tax for -1028059677 |
| FCMB | 47 | 2026-02-05 | Investment / asset movement — review | 4813013.70 | — | 2020251407-SELL-BONDMMDISCOUNT | — |
| FCMB | 50 | 2026-02-05 | Investment / asset movement — review | 18698.63 | — | 2020251407-SELL-BONDMMDISCOUNT | — |
| FCMB | 54 | 2026-02-26 | Potential bank-to-bank / cooperative transfer — review | — | 6000000.00 | NIP/260226123830175000084068 | NIP FRM RACDA COOPERATIVE SOCIETY-NIPRADIO ARE |
| FCMB | 56 | 2026-03-05 | Investment / asset movement — review | 5775616.44 | — | 2020280441-SELL-BONDMMDISCOUNT | — |
| FCMB | 59 | 2026-03-05 | Investment / asset movement — review | 22438.36 | — | 2020280441-SELL-BONDMMDISCOUNT | — |
| FCMB | 61 | 2026-03-31 | Tax withholding — policy review | 1127.55 | — | — | Withholding Tax for -1028059677 |
| FCMB | 63 | 2026-04-30 | Tax withholding — policy review | 608.73 | — | — | Withholding Tax for -1028059677 |
| FCMB | 65 | 2026-05-07 | Investment / asset movement — review | — | 5000000.00 | — | MATURED_TBILLS_07_05_2026 |
| FCMB | 68 | 2026-05-31 | Tax withholding — policy review | 2367.70 | — | — | Withholding Tax for -1028059677 |
| FCMB | 70 | 2026-06-04 | Investment / asset movement — review | — | 6000000.00 | — | MATURED_TBILLS_04_06_2026 |
| FCMB | 72 | 2026-06-18 | Investment / asset movement — review | 5767389.04 | — | 2020377572-SELL-BONDMMDISCOUNT | — |
| FCMB | 75 | 2026-06-18 | Investment / asset movement — review | 23261.10 | — | 2020377572-SELL-BONDMMDISCOUNT | — |
| FCMB | 77 | 2026-06-30 | Tax withholding — policy review | 3502.38 | — | — | Withholding Tax for -1028059677 |
| FCMB | 79 | 2026-07-31 | Tax withholding — policy review | 1828.95 | — | — | Withholding Tax for -1028059677 |
| Fidelity Bank | 18 | 2026-02-26 | Potential bank-to-bank / cooperative transfer — review | 6000000.00 | — | — | Nip/Radio Area Cda(Ikorodu South) B/O Racda Co-Ope |
| Fidelity Bank | 51 | 2026-04-14 | Ordinary Loan candidate — loan terms required | 2000053.75 | — | — | Nip/Yalokwu Patrick Onuwa |
| Fidelity Bank | 72 | 2026-07-03 | Potential bank-to-bank / cooperative transfer — review | — | 10000.00 | — | Upf070260703181333002292011167|Racda Co Operative |

### 11 T-bill/bond rows — do not misclassify as expense or income

The eight FCMB debits form four pairs under `SELL-BONDMMDISCOUNT` references: ₦4,803,664.39 on 2025-05-22 (`2020033785`); ₦4,831,712.33 on 2026-02-05 (`2020251407`); ₦5,798,054.80 on 2026-03-05 (`2020280441`); and ₦5,790,650.14 on 2026-06-18 (`2020377572`). Each pair is one larger debit plus a smaller debit on the same reference. Three later `MATURED_TBILL` credits are ₦5,000,000 on 2025-08-21, ₦5,000,000 on 2026-05-07, and ₦6,000,000 on 2026-06-04. Their timing/amounts plausibly correspond to the first three debit groups. The last debit group has no maturity credit in the workbook.

This indicates investment purchase/settlement and maturity proceeds, not ordinary expenses or automatically-earned income. The data alone does not establish whether each smaller same-reference debit is additional investment cost or a charge, and the security statement/certificate is needed to distinguish principal from earned discount/interest. **Recommendation:** hold these 11 rows from import until an investment schedule confirms cost, fees and maturity income and an appropriate existing investment-asset posting is identified. The target has no such enterprise/account; the existing Fixed Asset type would misstate a treasury investment.

### Four potential bank/cooperative transfer rows

The Fidelity Bank **₦6,000,000 debit on 2026-02-26** matches the FCMB **₦6,000,000 credit on the same date** (FCMB ref `NIP/260226123830175000084068`): this is a strong inter-bank transfer pair. The FCMB **₦5,000,000 credit on 2025-05-07** and Fidelity Bank **₦10,000 credit on 2026-07-03** are described as cooperative-origin transfers but have no outgoing counterpart in these sheets. The ordinary app Internal Transfer flow is non-cash and requires member/enterprise detail legs; it does not provide a supported bank-to-bank cash-transfer posting for these actual-bank rows.

**Recommendation:** do not label these as income, expense or Unknown Payments. Confirm the source/counterpart for the ₦5,000,000 and ₦10,000 receipts, and either identify an existing supported posting path for bank-to-bank transfers or keep the four rows out of the import. The exact ₦6,000,000 pair is identified, but the usual UI does not provide a valid bank-to-bank Internal Transfer entry.

### 19 withholding-tax rows — accounting policy required

The 19 FCMB debits total **₦31,308.70** and are described as withholding tax. This is not a bank fee. The app has a generic existing `Other Expenses` type, but no tax-specific type or tax-receivable/withholding-asset account. **Recommendation:** use the existing `Other Expenses` classification only if the cooperative's policy treats this withholding as a nonrecoverable expense. If it is recoverable tax against income, the existing target has no suitable asset account and these rows must remain outside the import until a supported account is identified.

### One identified member debit — loan duration/terms absent

The **₦2,000,053.75 debit** on Fidelity Bank, 2026-04-14, uniquely matches member Patrick Yalokwu (registration no. 28) and is therefore mapped to the existing Ordinary Loan enterprise as a candidate. The loan enterprise is configured with fixed interest **₦10** (`interest_is_percent=0`) and zero form/admin charges; it has no loan-duration setting. There are no existing loan records in the target. The remittance UI's new-loan configuration starts at duration 0 and requires a duration before posting; the approved workflow can also generate related loan/charge records.

**Recommendation:** do not invent duration or terms. Confirm whether this was genuinely a loan disbursement and provide its established duration/terms; otherwise specify the correct treatment. Until confirmed, do not import this row as a loan.

## Approval / next step

All 177 source rows are accounted for in the CSV; no duplicate was dropped. **142 rows are prepared for approval, while the 35 above remain outside the import pending decisions.** Your continuation instruction requires read-only mode and explicit approval before backup/import. No database backup has been created, no source or target data has been changed, and no transaction has been imported. After you confirm the unresolved treatments and explicitly approve the intended import scope, the next steps are backup → import through the selected supported app path → post-import verification.
