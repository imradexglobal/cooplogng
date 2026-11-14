# Trial-balance difference investigation

**Cooperative:** Odogunyan Grammar School Staff Cooperative (OGSC)  
**Report period:** 2026-01-01 to 2026-11-13  
**Database examined:** `C:\Users\USER\Downloads\nneeww.db`  
**Scope:** Read-only inspection; no database records were changed.

## Executive conclusion

The two differences are not independent errors and are not caused by rounding:

```text
Opening control difference                         -25,856,259.00
Add: net 2026 suspense / unresolved activity        +7,889,058.71
                                                   ----------------
Closing control difference                         -17,967,200.29
```

Therefore, the closing difference is the opening imbalance carried forward, partially offset by the net suspense postings made during the reporting period.

The report is behaving consistently with its stated basis: it intentionally leaves the control difference visible because the source data contains postings that do not form complete double-entry transactions.

## Arithmetic verification from the pasted trial balance

### Opening balances

| | Amount |
|---|---:|
| Total opening debit balances | 94,866,452.41 |
| Total opening credit balances | 120,722,711.41 |
| Opening debit less credit | **-25,856,259.00** |

### Closing balances

| | Amount |
|---|---:|
| Total closing debit balances | 154,388,135.57 |
| Total closing credit balances | 172,355,335.86 |
| Closing debit less credit | **-17,967,200.29** |

The totals and differences agree exactly with the pasted Accounting Pack extract.

## Database evidence

The SQLite database contains 2,293 remittance headers and 1,189 remittance detail rows. Among non-deleted remittances:

- 2,285 are approved; 8 are pending.
- Approved 2026 suspense activity contains **765 rows**.
- The approved suspense activity totals:
  - Positive postings: 65,271,554.00
  - Negative postings: -57,382,495.29
  - Net: **+7,889,058.71**
- Every one of those 765 suspense rows has member ID **`0000000000`**, which is a placeholder/unmapped member rather than a real member account.
- The suspense rows have `transaction_type = Unknown Payments` and are not linked to a member or loan (`loan_id` is blank).
- The Accounting Pack's `Unknown Payments` closing debit of **9,164,111.18** is consistent with the net suspense amount combined with the separately signed unknown-payment activity: 7,889,058.71 - (-1,275,052.47) = 9,164,111.18.

The database also contains 8 pending Loan Asset records totaling -2,981,500.00. They are not included in this report because the report basis includes only approved, non-deleted remittances; they should not be posted until properly approved and classified.

## What is actually wrong

There are two layers of problem:

### 1. Opening balances were imported unbalanced

At 2025-12-31, the opening balances already have 25,856,259.00 more credits than debits. This is a historical/import opening-balance problem, not a 2026 period-result problem. The 2026 net surplus/(deficit) of -10,234.54 is far too small to explain it.

Possible causes include historical transactions imported without their counterpart, opening balances loaded directly into member/loan/bank accounts without the corresponding equity or opening-suspense entry, or transactions whose sign/category was interpreted incorrectly during extraction.

### 2. 2026 contains unresolved bank transactions

The 765 suspense/unknown-payment rows are approved and included in the report, but they do not identify the correct member, loan, savings account, income, expense, or transfer account. They therefore cannot be posted as complete double entries. The report correctly leaves their control effect visible instead of silently balancing it.

Several large examples require immediate review, including:

- 5,000,000.00 received on 2026-02-10, description beginning `TNF-ODOGUNYAN GRAMM SCH`.
- -5,000,000.00 on 2026-03-01, described as an RSA loan payment for ELNUYI LTD.
- -3,000,603.75 on 2026-05-06, described as Dividend/AGM expenditure for SAKIRAT TINUOLA OLUNU.
- -3,000,000.00 on 2026-09-29, described as an ordinary-loan payment for GOLDEN HEART HOSPITAL.
- 2,200,000.00 on 2026-08-14, described as a transfer to the cooperative.

These examples are not automatically errors; they are high-value items that cannot remain in `0000000000` suspense without documentary classification.

## Recommended correction procedure

1. **Make a verified backup copy of `nneeww.db`** before any correction. Keep the original read-only as the audit source.

2. **Resolve the opening imbalance first.** Reconstruct the 2025-12-31 opening ledger from the source bank statements, member savings schedules, loan schedules, and asset records. Do not simply edit the report totals. If the historical evidence is incomplete, post the unexplained opening amount to a clearly named `Opening Balance Suspense` account with an approval note, rather than hiding it in retained earnings.

3. **Work through the 765 suspense rows.** For each row, use the bank statement, transfer reference, member name, loan schedule, payment advice, and supporting voucher to assign:
   - the correct member;
   - the correct loan or savings product;
   - the correct bank account; and
   - the correct transaction category.

4. **Post both sides of every correction.** Examples:
   - member savings received: Dr bank / Cr member savings;
   - loan repayment: Dr bank / Cr loan receivable, with any interest or fee split separately;
   - loan disbursement: Dr loan receivable / Cr bank;
   - bank charge: Dr finance expense / Cr bank;
   - internal bank transfer: Dr destination bank / Cr source bank;
   - genuine unidentified receipt or payment: use a named suspense account, with a transaction-level explanation and follow-up owner.

5. **Do not approve the eight pending loan-asset rows merely to make the report balance.** Approve or reject them based on loan documentation, then classify their corresponding bank movements.

6. **Regenerate the Accounting Pack and confirm that:**
   - opening difference is zero or separately supported by an approved opening-suspense journal;
   - current-period suspense is zero or equals only documented unresolved items;
   - total debits equal total credits; and
   - bank balances agree to bank statements and member/loan subledgers agree to the general ledger.

## Important warning

Do not fix this by changing `Retained Earnings`, changing report formulas, deleting suspense rows, or forcing the trial balance to zero. That would conceal the underlying missing classifications and could make member balances, loan balances, and bank reconciliation incorrect. The proper fix is transaction-level classification plus a separately documented opening-balance reconciliation.

## Bottom line

- **-25,856,259.00** is the unbalanced opening position inherited at 2025-12-31.
- **+7,889,058.71** is the net effect of 2026 suspense/unknown-payment postings.
- **-17,967,200.29** is the mathematically correct closing control difference resulting from those two facts.
- The balance will be solved when the opening balances are reconciled and the 765 placeholder suspense transactions are either correctly classified or formally supported in a named suspense account.
