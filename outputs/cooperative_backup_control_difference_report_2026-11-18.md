# Cooperative control-difference study

**Cooperative:** Odogunyan Grammar School Staff Cooperative (OGSC)  
**Backup examined:** `C:\Users\USER\Downloads\cooperative_backup_2026-11-18T00-46.db`  
**Report period reproduced:** 2026-01-01 to 2026-11-17  
**Scope:** Read-only analysis; no database records were changed.

## Executive conclusion

The app is showing the correct arithmetic for the data currently in the backup:

```text
Opening Dr less Cr       119,828,993.00 - 120,295,393.00 = -466,400.00
2026 period Dr less Cr   113,051,290.35 - 113,063,050.35 = -11,760.00
Closing Dr less Cr        230,994,050.27 - 231,472,210.27 = -478,160.00
```

Therefore:

```text
-466,400.00 + -11,760.00 = -478,160.00
```

This is a source-data / posting problem, not a report-formatting or rounding problem. The app's Accounting Pack code deliberately discloses postings that do not form complete double entries instead of inserting a balancing plug.

## Cause 1 — opening balance imbalance: -466,400.00

The 2025-12-31 opening column contains legacy/internal postings that were not converted into the app's opening-balance transaction types or do not have matching counterpart legs. The entry-proof reconciliation groups the opening imbalance as follows:

| Source shape still present at 2025-12-31 | Net effect on Dr less Cr |
|---|---:|
| 11 legacy `Member Loan` entries | +706,700.00 |
| 21 `Loan Charges` entries | -579,100.00 |
| 1 `Savings Withdrawal` entry | +25,000.00 |
| 5 legacy `Member Deposit` entries | -679,000.00 |
| 1 `Internal Transfer` entry | +60,000.00 |
| **Opening imbalance** | **-466,400.00** |

By contrast, the rows correctly marked `Opening Member Loan`, `Opening Member Savings`, and `Opening Bank Balance` are balanced by the app's opening-equity logic. The problem is the remaining legacy rows, not the arithmetic of the trial-balance report.

## Cause 2 — current-period imbalance: -11,760.00

The entire 2026-period difference is one transaction:

- **Remittance ID:** `OGSC-20261115000654-0001-AFD50358`
- **Date:** 2026-05-15
- **Member:** `Oluwatoyin Agbenla` (member ID `OGSC-1f64F5Hs0000000028`)
- **Description:** `2025 Dividend Returned`
- **Header:** `11,760.00`
- **Bank:** `Internal Transfer`
- **Current classification:** `Member Loan` / `Loan Asset`
- **Only detail leg:** `11,760.00` to `Ordinary Loan`

Because the header is an internal transfer, the app does not create a cash leg. Because it is classified as a loan asset and has only one detail leg, the resulting entry is a single-sided loan posting. Its control effect is **-11,760.00**.

This row is especially significant because an earlier available backup (`cooperative_backup_2026-10-31T04-34.db`) shows the corresponding dividend-return transaction as `Member Deposit` / `Member Liability`, although its detail still points to `Ordinary Loan`. That historical comparison indicates the current `Member Loan` classification should not be accepted without checking the original dividend/loan schedule.

## Other findings relevant to cleanup

The reproduced Accounting Pack reports 280 unbalanced derived entries overall, but only the one dated 2026-05-15 contributes to the displayed 2026 period difference. It also reports 160 one-legged non-cash exceptions, 51 loan-detail movements not traceable to a loan record, and 419 negative profit-and-loss headers. These are data-quality warnings that should be reviewed, but they do not all add directly to the displayed -478,160.00.

The app's own control results for this reproduction are:

- C1 closing integrity: **-478,160.00 — REVIEW**
- C2 opening integrity: **-466,400.00 — REVIEW**
- C18 ledger debit/credit footing: **-11,760.00 — REVIEW**
- C17 individually unbalanced entries: **280 — REVIEW**
- Cash continuity, income detail, expense detail, liability detail, and cash-flow closing: **PASS**

## Safe correction procedure

1. Preserve the downloaded backup as the audit source and create a separate working copy before editing anything.
2. Review every 2025-12-31 row listed above against the 2025 closing trial balance, bank statements, member savings schedule, loan register, and supporting vouchers. Where a row is genuinely brought forward, convert it to the correct `Opening Member Savings`, `Opening Member Loan`, or `Opening Bank Balance` structure so the app can create the corresponding opening-equity leg. Where it is a real transaction, restore both sides of the transaction rather than relabelling it merely to make the report foot.
3. For remittance `OGSC-20261115000654-0001-AFD50358`, verify whether the 11,760.00 is a returned dividend, a loan repayment, or a transfer between member accounts. Then correct both the header classification and detail account together. If it is a member-liability return, use the appropriate savings/member-liability account; if it is a loan adjustment, use a properly paired loan transaction and document the reason. Do not change only the category while leaving the detail on the wrong enterprise.
4. Rebuild the report and confirm that opening difference is zero or is supported by a separately approved opening-balance suspense journal, the 2026 period difference is zero or consists only of documented unresolved entries, and the member/loan subledgers agree to the general ledger.
5. Do not fix this by editing the displayed totals, changing retained earnings, deleting rows, or inserting an unexplained balancing amount. That would hide the underlying member and loan errors.

## Bottom line

The displayed **-478,160.00** is the sum of two identifiable problems: **-466,400.00** inherited from incomplete/misclassified 2025-12-31 opening postings and **-11,760.00** from the single-sided 2026-05-15 `2025 Dividend Returned` entry. Correct those source postings with supporting documents, then regenerate the trial balance.
