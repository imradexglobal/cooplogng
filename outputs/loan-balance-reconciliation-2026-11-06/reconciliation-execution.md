# Reconciliation execution report

**Source backup:** `cooperative_backup_2026-11-06T13-24.db`  
**Source SHA-256:** `fb7f5902d93ef30bed415e911334ffa0e7319391ce828d5858efc809180d18e4`  
**Output database copy:** `cooperative_backup_2026-11-06_RECONCILED_READY_2026-11-06.db`  
**Output SHA-256:** `aa7ca71ce08201501a2d37704f069d568188ca8e6956d9fbd9aae1cd34204982`  
**Cooperative:** The Muslim Stars Association (TMSA)

Applied exactly **314 READY remittances**. The **6 HOLD rows were not applied**.

Each new remittance is Approved, dated `2026-11-06T00:00:00.000Z`, uses bank `Internal Transfer`, transaction type `Internal Transfer`, category `Transfer`, amount `0`, and description `Loan balance precision reconciliation — Ordinary Savings offset`. Each has exactly two detail rows: Ordinary Savings `-loan_delta`, and the target Loan enterprise `loan_delta`. All 314 remittances are marked unsynced and have one parent sync-queue entry each, consistent with the app's remittance-save/sync model.

- New headers: **314**
- New detail rows: **628**
- Parent sync queue entries: **314**
- Net loan detail delta: **₦122.36**
- Net Ordinary Savings detail delta: **₦-122.36**
- Header and paired-detail reconciliation: **balanced**
- Output SQLite integrity check: **ok**
- Original source SHA-256 after processing: **fb7f5902d93ef30bed415e911334ffa0e7319391ce828d5858efc809180d18e4** (unchanged)

The row-level mapping, balances before/after, detail amounts, and new remittance/detail IDs are in `applied-remittance-manifest.csv`. No values in the original backup were changed.
