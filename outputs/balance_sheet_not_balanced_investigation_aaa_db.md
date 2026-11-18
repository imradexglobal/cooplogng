# Balance Sheet investigation — cleaned `aaa.db`

**Database:** `C:\Users\USER\Downloads\aaa.db`  
**Period:** 2026-01-01 to 2026-11-17  
**Scope:** Read-only investigation; no database or source-code changes were made during this investigation.

## Executive conclusion

The trial balance is balanced. The Balance Sheet is not balanced because the Balance Sheet presentation currently omits three account buckets that are included in the trial balance:

1. **Unallocated Payment Clearing** — asset: **58,112,010.89**
2. **Unidentified Receipts Liability** — liability: **46,444,154.00**
3. **Opening Balance Equity** — debit balance within equity: **-25,514,640.59**

The omitted amounts reconcile exactly to the Balance Sheet difference:

```text
Omitted asset
less omitted liability and equity

58,112,010.89 - (46,444,154.00 - 25,514,640.59)
= 37,182,497.48
```

The Balance Sheet currently reports the opposite sign:

```text
Assets less Liabilities & Equity = -37,182,497.48
```

Therefore, this is a **Balance Sheet classification/presentation omission**, not a new debit-credit error in the transaction ledger.

## Trial balance proof

The cleaned database produces:

| Trial-balance control | Debit | Credit | Difference | Status |
|---|---:|---:|---:|---|
| Opening | 118,501,893.00 | 118,501,893.00 | 0.00 | PASS |
| 2026 period | 113,063,050.35 | 113,063,050.35 | 0.00 | PASS |
| Closing | 229,722,710.27 | 229,722,710.27 | 0.00 | PASS |

The period result also agrees with the Income & Expenditure statement:

```text
Income                 3,754,350.00
Less expenditure         259,844.55
Net surplus            3,494,505.45
```

The income and expenditure control passes, so the problem is not the calculation of the period surplus.

## Balance Sheet currently shown by the app

### Assets currently included

| Section | Amount |
|---|---:|
| Cash and bank | 4,081,658.36 |
| Loans receivable | 141,754,555.88 |
| Cooperative assets | -12,323,483.19 |
| **Total assets shown** | **133,512,731.05** |

### Liabilities and equity currently included

| Section | Amount |
|---|---:|
| Member savings | 167,200,223.08 |
| Other liabilities / Coop Due | 500.00 |
| Retained earnings brought forward | 0.00 |
| Surplus for the period | 3,494,505.45 |
| **Total liabilities and equity shown** | **170,695,228.53** |

```text
133,512,731.05 - 170,695,228.53
= -37,182,497.48
```

## Accounts omitted from the Balance Sheet

### 1. Unallocated Payment Clearing — asset: 58,112,010.89

This is an asset-type clearing account. It is included in the trial balance but the current Balance Sheet grouping only includes buckets for:

- bank;
- loans;
- ordinary assets; and
- cooperative assets.

The `unallocatedPayment` bucket is therefore left out of the Balance Sheet even though it remains in the trial balance.

It should be presented under Assets, preferably as:

```text
Unallocated member payments / payment clearing     58,112,010.89
```

This is not necessarily a normal operating asset. It is a clearing balance that requires follow-up, but it must still be shown until the underlying payments are allocated or corrected.

### 2. Unidentified Receipts Liability — 46,444,154.00

This is a liability-type account included in the trial balance but not included in the current Balance Sheet liability grouping.

It should be presented under Liabilities as:

```text
Unidentified receipts liability                     46,444,154.00
```

This is a legitimate liability presentation until the receipts are matched to members or another correct account. It should not be deleted merely to make the Balance Sheet balance.

### 3. Opening Balance Equity — debit balance: -25,514,640.59

The `Opening Balance Equity` account is a debit balance, shown by the signed Balance Sheet calculation as **-25,514,640.59**. It is present in the trial balance but the current Balance Sheet only adds:

- retained earnings brought forward; and
- current-period surplus.

It does not include the separate `openingEquity` bucket.

It should be presented within Equity as a separately labelled negative line:

```text
Opening balance equity                         (25,514,640.59)
```

The negative balance should be investigated against the opening-balance migration and supporting 2025 closing records. It should be shown transparently, not hidden in retained earnings.

## Exact corrected Balance Sheet reconciliation

If the three omitted accounts are included in the appropriate sections:

```text
Assets:
  Current assets shown                         133,512,731.05
  Add Unallocated Payment Clearing              58,112,010.89
  Corrected total assets                       191,624,741.94

Liabilities and equity:
  Current total shown                          170,695,228.53
  Add Unidentified Receipts Liability           46,444,154.00
  Add Opening Balance Equity                   (25,514,640.59)
  Corrected liabilities and equity              191,624,741.94

Corrected balance check                                  0.00
```

## Separate warnings that do not cause this Balance Sheet difference

The database still has separate subledger-quality warnings:

- **C5 Member accounts versus trial balance:** `-209,919,947.00`
- **C6 Loan register versus loan accounts:** `-46,911,094.00`
- **242 individually unbalanced derived entries**
- **51 loan movements not attributed to an individual loan record**

These should be investigated separately. They do not explain the exact Balance Sheet difference as directly as the three omitted account buckets do. The exact `-37,182,497.48` difference is fully explained by the omitted asset, liability, and opening-equity buckets above.

## Recommended correction

The source transactions should not be deleted and the trial-balance formula should not be changed. The correction belongs in the Balance Sheet grouping logic:

```text
Assets:
  include bucket === 'unallocatedPayment'

Liabilities:
  include bucket === 'unidentifiedReceipt'

Equity:
  include bucket === 'openingEquity'
```

The report should continue to show the negative Opening Balance Equity line and the two clearing accounts with clear labels. This will make the Balance Sheet foot to the already-balanced trial balance while preserving the unresolved balances for audit follow-up.

## Final answer

Your trial balance is balanced because all posted account buckets are included in the trial-balance totals. Your Balance Sheet is not balanced because the current presentation omitted three of those buckets. The database is not missing a balancing transaction for this specific difference.

Once the Balance Sheet includes:

- Unallocated Payment Clearing;
- Unidentified Receipts Liability; and
- Opening Balance Equity;

it will balance at **191,624,741.94** on both sides without changing any transaction data.
