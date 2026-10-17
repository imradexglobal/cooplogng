# MASTER AGENT PROMPT

## CoopLogNG — Accounting Pack Investigation, Accounting Data Model Analysis & Excel Report Implementation

### OBJECTIVE

Study the **existing CoopLogNG application, database structure, data-collection logic, transaction workflows, and existing reports** before making any changes.

The goal is to add a new report called:

> **Accounting Pack**

The Accounting Pack must allow the user to select a **date range** and then generate **one Excel workbook** containing multiple accounting/audit-related worksheets.

There should be **NO preview screen** for the Accounting Pack.

The workbook should be generated directly after the user selects the date range and requests the report.

---

# 1. VERY IMPORTANT — INVESTIGATE BEFORE CODING

Do NOT immediately implement the Accounting Pack based on the report names listed later in this prompt.

First, thoroughly study the existing application.

The current database data may contain incorrect, incomplete, historical, test, or inconsistent values.

**Do not use incorrect existing values as proof of how the accounting system is supposed to work.**

The purpose of this investigation is to understand:

* how the application is designed
* how financial data is collected
* how transactions are generated
* how transactions are stored
* how member balances are calculated
* how loans are recorded
* how remittances work
* how enterprise transactions work
* how withdrawals work
* how charges work
* how penalties work
* how income is recorded
* how expenses are recorded
* how internal/generated transactions are represented
* how cooperative-level transactions differ from member transactions
* how existing reports calculate their figures
* which database fields are authoritative
* which fields are derived
* which fields may be historical/legacy
* which values should NOT be used for accounting calculations

Study the **application logic and workflow**, not just the database schema.

---

# 2. BUSINESS LOGIC MUST NOT BE CHANGED

This task is primarily a:

> **Reporting and accounting-data extraction task.**

Do NOT change existing:

* transaction logic
* loan calculations
* repayment calculations
* remittance calculations
* member balance logic
* enterprise logic
* permission logic
* cooperative scoping
* authentication
* synchronization
* database schema
* financial calculations used by existing operational screens

unless a change is absolutely required for the Accounting Pack.

If something appears incorrect in the existing system, investigate and document it rather than silently changing the business logic.

The Accounting Pack should consume the existing application's authoritative data and business rules.

---

# 3. UNDERSTAND THE DATABASE FROM THE APPLICATION BACKWARD

Do not assume:

> database field = accounting meaning.

Instead trace the complete path:

```text
User Action
   ↓
Application Workflow
   ↓
Business Logic
   ↓
Transaction Generation
   ↓
Database Record
   ↓
Existing Balance Calculation
   ↓
Existing Report
```

For important financial figures, determine exactly where the number originates.

For example:

```text
Loan submitted
↓
Loan record created
↓
Charges calculated
↓
Remittance/generated transaction created
↓
Member account affected
↓
Balance calculation
↓
Existing report
```

Understand each step before deciding how that information belongs in the Accounting Pack.

---

# 4. IMPORTANT ACCOUNTING INTERPRETATION

The following are **investigation guidance**, not assumptions that must blindly be implemented.

You must verify these concepts against the actual application.

## 4.1 Internal/generated transactions

In CoopLogNG, an internal/generated transaction does NOT necessarily mean an actual bank transaction.

Examples can include:

* loan charges
* loan-related charges
* withdrawal-related generated values
* dues
* penalties
* other system-generated values
* internally generated adjustments

These transactions may still have accounting consequences.

For example, an internally generated transaction could contribute to:

* an asset
* a liability
* income
* expense
* member balance
* receivable
* payable

Therefore:

> Do NOT classify transactions simply as "bank" or "not bank."

Determine their accounting meaning from the application's business logic.

---

# 5. REMITTANCE DETAILS — INVESTIGATE CAREFULLY

One of the most important parts of this investigation is understanding:

* `remittance`
* `remittance_details`
* member-related transactions
* admin/cooperative transactions
* enterprise-related transactions
* generated transactions

The current understanding is:

### Member-related transactions

Member-related transactions have data in `remittance_details`.

### Remittance-only transactions

A remittance that has no member remittance detail may represent an administrative/cooperative-level transaction.

However:

**Do not assume this is always true. Verify it throughout the codebase and database relationships.**

---

# 6. MEMBER REMITTANCE SIGN CONVENTION

Investigate and verify the existing sign convention.

The current intended interpretation is:

```text
Positive remittance_detail amount
    = credit to member account

Negative remittance_detail amount
    = debit from member account
```

Therefore, for a member account:

```text
Member Net Position
=
SUM(all applicable positive member credits)
+
SUM(all applicable negative member debits)
```

Because negative values offset positive values.

However:

**Verify this against the actual application's existing balance calculations.**

Do not simply assume the sign convention from this prompt.

---

# 7. MEMBER LIABILITY — DO NOT BLINDLY USE REMITTANCE AMOUNT

There is an important accounting concern that must be investigated.

The current intended idea is:

> Member liability should potentially be derived from the aggregate of member savings-related enterprise amounts in `remittance_details`, rather than simply using the parent `remittance.amount`.

Reason:

A parent remittance amount may contain values affected by:

* dues
* charges
* loan charges
* penalties
* withdrawals
* other deductions
* generated transactions

Therefore:

```text
remittance.amount
```

may NOT represent the actual amount owed to members.

The intended concept is closer to:

```text
Member Liability
=
Net member savings/contribution balance
```

where applicable member savings enterprises are aggregated from the relevant `remittance_details`.

Conceptually:

```text
Positive member savings credits
+
Negative member savings debits
=
Net member savings liability
```

But this must be **verified against the application's actual enterprise definitions, workflows, and balance calculations**.

Do not implement this calculation until you have established:

1. Which enterprise types represent member savings.
2. Which enterprise types do NOT represent member savings.
3. Whether the same enterprise can be used for different purposes.
4. Whether withdrawals correctly appear as negative member entries.
5. Whether generated charges incorrectly appear in the same fields.
6. Whether historical records follow the same structure.
7. Whether existing member-balance calculations already implement this logic.
8. Whether any other tables must be included.

If the investigation shows that the proposed method is incorrect, use the method supported by the application's actual business logic and document the conclusion.

---

# 8. ACCOUNTING CLASSIFICATION MUST BE DERIVED

Do not force every transaction into:

* income
* expense
* asset
* liability
* bank

simply because the database has a transaction.

Determine what each transaction represents.

For example:

### Member savings

Potentially:

> Liability to members

### Loan principal outstanding

Potentially:

> Asset / receivable

### Loan interest

Potentially:

> Income

### Penalties

Potentially:

> Income

### Cooperative expense

Potentially:

> Expense

### Cash received

Potentially:

> Cash/bank asset

But these are accounting concepts that must be mapped against the actual CoopLogNG implementation and the cooperative's accounting treatment.

Do not invent classifications where the application does not contain sufficient evidence.

---

# 9. STUDY EXISTING REPORTS

Before creating the Accounting Pack, inspect every existing financial report that is relevant.

Determine:

* how dates are filtered
* whether date filtering uses transaction date, posting date, creation date, or another field
* how deleted transactions are handled
* how approved/pending transactions are handled
* how cooperative filtering works
* how member filtering works
* how enterprise filtering works
* how loans are included
* how loan charges are included
* how withdrawals are included
* how penalties are included
* how revenue is treated
* how expenses are treated
* how balances are calculated

Compare existing reports with the underlying database records.

The purpose is to identify the application's **authoritative financial logic**.

---

# 10. DATE RANGE

The Accounting Pack must have:

```text
Start Date
End Date
```

The selected date range must be applied consistently across all applicable workbook sheets.

However, investigate whether some reports require:

### Transaction-period logic

For example:

```text
01/01/2026 – 31/12/2026
```

versus:

### Balance-at-date logic

For example:

```text
Member balance as at 31/12/2026
```

These are not necessarily the same calculation.

The agent must distinguish between:

* transactions occurring during the period
* opening balances
* closing balances
* cumulative balances
* outstanding loan balances
* member liabilities as at the end date

Do not accidentally produce a "period transaction total" where an "as-at closing balance" is required.

---

# 11. ACCOUNTING PACK WORKBOOK

Add:

> **Accounting Pack**

to the existing Reports list.

When selected:

```text
Start Date: [ date ]
End Date:   [ date ]

[ Generate Accounting Pack ]
```

No preview is required.

The system should generate:

```text
CoopLogNG_Accounting_Pack_YYYY-MM-DD_to_YYYY-MM-DD.xlsx
```

or follow the application's existing report naming convention.

---

# 12. ONE EXCEL WORKBOOK

The Accounting Pack must generate exactly:

> **ONE Excel workbook**

The workbook should contain multiple worksheets.

Do NOT generate 20 separate Excel files.

The exact sheets must be determined after studying the application.

The following is a **candidate list only**:

```text
Trial Balance Data
General Ledger
Cash Book
Bank Book
Member Contributions
Loan Register
Loan Repayments
Interest Income
Penalty Income
Other Income
Expenses
Assets Register
Liabilities Register
Receivables
Payables
Member Balances
Bank Reconciliation
Journal / Adjustments
Opening Balances
Transaction Audit Trail
Period-End Balances
Account Mapping
```

You are NOT required to create all 22.

If investigation shows that some are:

* meaningless
* duplicate
* unsupported by the database
* better combined
* better renamed
* better split
* unnecessary for an accountant

then modify the workbook structure accordingly.

The final workbook should be **useful to a professional accountant/auditor**, not merely large.

---

# 13. ACCOUNTING PACK SHOULD BE DATA-DRIVEN

The workbook should contain enough information for an accountant to independently construct financial statements.

The goal is:

```text
CoopLogNG
    ↓
Accounting Pack
    ↓
Accountant/Auditor
    ↓
Final Financial Statements
```

The workbook should therefore expose the underlying evidence rather than hide everything behind a final calculated figure.

Where appropriate, include columns such as:

```text
Date
Transaction ID
Reference
Cooperative ID
Member ID
Member Name
Enterprise
Enterprise Type
Transaction Type
Description
Debit
Credit
Amount
Status
Source
Loan ID
Account
Created By
Approved By
Created At
Modified At
```

Only include fields that actually exist and are meaningful in CoopLogNG.

Do not fabricate values.

---

# 14. GENERAL LEDGER

If supported by the application's transaction model, the General Ledger should provide a detailed accounting view of transactions.

It should allow the accountant to trace:

```text
Account
    ↓
Transaction
    ↓
Source record
```

Include sufficient identifiers to trace the transaction back into CoopLogNG.

---

# 15. TRIAL BALANCE DATA

The Trial Balance sheet should be based on actual accounting classifications derived from the application's data.

At minimum, where supported:

```text
Account
Debit
Credit
Balance
```

Potentially:

```text
Account Code
Account Name
Account Type
Debit
Credit
Net Balance
```

But do NOT create arbitrary account codes unless the application already has them or a clearly documented mapping is established.

If CoopLogNG does not currently have a formal chart of accounts, investigate whether an **Account Mapping** sheet is necessary.

---

# 16. ACCOUNT MAPPING

If the application does not have a formal accounting chart of accounts, create a useful mapping layer in the workbook rather than changing the application's business logic.

For example:

```text
CoopLogNG Source
↓
Accounting Classification
↓
Accounting Account
```

Example conceptually:

```text
Member Savings
→ Liability
→ Member Deposits/Savings

Loan Principal Outstanding
→ Asset
→ Loans Receivable

Loan Interest
→ Income
→ Interest Income
```

These are examples only.

Use the actual application's terminology and verified transaction types.

---

# 17. AUDIT TRACEABILITY

A professional auditor should be able to trace important figures.

Design the workbook so that:

```text
Financial total
↓
Account total
↓
Transaction
↓
Source record
```

can be followed.

Where practical, include:

* source table
* source ID
* transaction ID
* member ID
* loan ID
* remittance ID
* remittance detail ID
* enterprise ID

This is extremely important.

---

# 18. DELETED / VOIDED / CANCELLED TRANSACTIONS

Investigate how CoopLogNG represents:

* deleted
* voided
* cancelled
* reversed
* pending
* approved

transactions.

Do not silently include or exclude them.

Follow the application's existing financial rules.

If excluded from accounting totals, consider whether the Audit Trail should still show them.

The accountant/auditor may need to know that they existed.

---

# 19. RECONCILIATION / CONTROL CHECKS

The Accounting Pack should include useful control information where the existing data supports it.

Examples:

### Trial Balance control

```text
Total Debits
Total Credits
Difference
```

Expected:

```text
Difference = 0
```

If it does not balance, **do not hide the problem**.

Show the difference.

### Member balance control

Potentially:

```text
Total member credits
- Total member debits
= Net member position
```

### Loan control

Potentially:

```text
Opening loan balance
+ New loans
- Principal repayments
= Closing loan balance
```

Only implement controls that are consistent with the application's actual loan model.

---

# 20. DATA QUALITY WARNINGS

Because existing database data may contain incorrect or historical records, the Accounting Pack should not silently pretend everything is perfect.

If practical, include a:

> **Data Quality / Exceptions**

worksheet.

Possible exceptions:

* missing cooperative ID
* missing member ID where one is expected
* missing transaction date
* unknown enterprise
* orphaned remittance detail
* transaction referencing missing loan
* duplicate transaction identifier
* invalid sign/value
* unsupported transaction type
* accounting classification unavailable
* debit/credit mismatch
* other anomalies discovered during investigation

This is particularly valuable for auditors.

Do not modify the underlying data merely to make the report balance.

---

# 21. COOPERATIVE SCOPING

This is critical.

The Accounting Pack must respect the same cooperative isolation rules as the rest of CoopLogNG.

Never combine financial records belonging to different cooperatives.

Every calculation should be scoped appropriately by:

```text
cooperative_id
```

where applicable.

Investigate whether any existing report fails to apply this filtering and ensure the new Accounting Pack does not repeat that problem.

---

# 22. DO NOT USE A GENERIC ACCOUNTING TEMPLATE

Do NOT simply copy an accounting-report template from another application.

Do NOT assume:

```text
remittance = revenue
```

Do NOT assume:

```text
remittance = cash
```

Do NOT assume:

```text
all positive amounts = income
```

Do NOT assume:

```text
all negative amounts = expense
```

Do NOT assume:

```text
internal transaction = non-accounting transaction
```

Do NOT assume:

```text
remittance.amount = member liability
```

Instead, determine the accounting meaning from the actual CoopLogNG workflows.

---

# 23. INVESTIGATION REPORT BEFORE IMPLEMENTATION

Before writing the Accounting Pack code, produce an internal investigation report containing:

### A. Database Structure

List relevant tables and relationships.

### B. Transaction Sources

Explain where each financial transaction originates.

### C. Member Accounting Flow

Explain how member credits/debits affect balances.

### D. Loan Accounting Flow

Explain how loan principal, repayments, interest and charges are represented.

### E. Remittance Flow

Explain:

```text
remittance
→ remittance_details
→ member account
```

### F. Enterprise Classification

Explain how enterprises determine the meaning of transactions.

### G. Existing Report Calculations

Document important existing calculations.

### H. Accounting Classification

Propose how the application's actual transaction types map into:

```text
Asset
Liability
Income
Expense
Equity/Fund
Cash/Bank
Receivable
Payable
```

### I. Member Liability Calculation

Explicitly determine the correct method based on the application.

### J. Proposed Accounting Pack Sheets

Explain why each sheet is needed.

Only after this investigation should implementation begin.

---

# 24. IMPLEMENTATION PHASES

Do NOT rewrite the entire reporting system in one operation.

Work in phases.

## PHASE 1 — Investigation

Study:

* source code
* database schema
* existing reports
* financial workflows
* remittance logic
* member balance logic
* loan logic
* enterprise logic

Produce findings.

**Do not modify application behavior yet.**

---

## PHASE 2 — Accounting Model Design

Based on the investigation:

* define transaction classifications
* define accounting sources
* define date handling
* define opening/closing balance logic
* define member liability logic
* define required workbook sheets
* define workbook columns
* define control checks

Still avoid changing existing business logic.

---

## PHASE 3 — Accounting Pack Generator

Implement:

```text
Reports
→ Accounting Pack
→ Start Date
→ End Date
→ Generate
```

Generate one `.xlsx` workbook.

---

## PHASE 4 — Validation

Test against known transactions.

Test:

### Member savings

```text
Credit
+
Debit
=
Net member position
```

### Withdrawals

Verify that withdrawals correctly affect member balances and accounting classification.

### Loans

Verify:

* loan principal
* repayments
* interest
* charges
* outstanding balance

### Penalties

Verify classification and totals.

### Internal/generated transactions

Verify they are not incorrectly treated as bank transfers.

### Cooperative isolation

Verify no records from another cooperative appear.

### Date boundaries

Test:

```text
Start date
End date
```

including transactions exactly on both boundaries.

### Empty periods

Generate a pack for a period with no transactions.

It should still produce a useful workbook.

### Accounting controls

Verify relevant debit/credit and reconciliation checks.

---

# 25. EXCEL QUALITY

The workbook should be professional and accountant-friendly.

Where practical:

* freeze header rows
* enable filters
* use meaningful sheet names
* format dates consistently
* format currency/amount columns consistently
* use proper numeric Excel values rather than text
* include totals where appropriate
* include report period
* include cooperative name
* include generation date/time
* include clear headers
* avoid unnecessary decorative formatting

Do not over-design it.

The priority is:

> **accuracy + traceability + usability.**

---

# 26. NO PREVIEW

The Accounting Pack does not require a preview.

Do not create:

```text
Preview → Confirm → Generate
```

unless the existing report architecture absolutely requires it.

Preferred:

```text
Select date range
↓
Generate Accounting Pack
↓
Excel file created/downloaded
```

---

# 27. IMPORTANT — DO NOT CLAIM "100% ACCOUNTING COMPLIANCE"

The goal is to make the data:

> **accurate, traceable, internally consistent, and useful to accountants and auditors.**

Do not claim that the resulting workbook is automatically compliant with every accounting standard or statutory requirement.

Different cooperatives may have different:

* accounting policies
* reporting requirements
* chart of accounts
* statutory requirements
* presentation conventions

The application should therefore provide reliable underlying accounting data and transparent calculations.

---

# 28. FINAL VALIDATION QUESTIONS

Before considering the task complete, verify:

1. Did you study the actual database schema?
2. Did you study how each relevant table is populated?
3. Did you study the application code that creates transactions?
4. Did you study existing balance calculations?
5. Did you study remittance and remittance details?
6. Did you verify the positive/negative member transaction convention?
7. Did you verify the correct member liability calculation?
8. Did you distinguish internal/generated transactions from actual bank transactions?
9. Did you distinguish member transactions from cooperative/admin transactions?
10. Did you understand enterprise classifications?
11. Did you identify the authoritative source for each accounting figure?
12. Did you preserve existing business logic?
13. Did you preserve cooperative isolation?
14. Did you handle opening and closing balances correctly?
15. Did you handle date boundaries correctly?
16. Can an accountant trace totals back to source transactions?
17. Can an auditor identify exceptions?
18. Does the workbook contain only useful sheets?
19. Does the workbook generate as one Excel file?
20. Does the Trial Balance/control information expose discrepancies instead of hiding them?

---

# 29. FINAL AGENT REPORT

When finished, provide:

### Investigation Summary

What was discovered about the CoopLogNG accounting/data model.

### Accounting Interpretation

Explain how the existing transactions were interpreted.

### Member Liability

Explain the verified calculation and why it was chosen.

### Workbook Structure

List every worksheet created and its purpose.

### Files Changed

List all files modified/created.

### Business Logic

Confirm that existing business logic was preserved.

### Tests

List tests performed and results.

### Known Limitations

Clearly identify anything that requires an accountant's policy decision or additional data.

### Accounting Risks

Identify any areas where the database/application does not contain enough information to make a definitive accounting classification.

---

# MOST IMPORTANT INSTRUCTION

**Study first. Implement second.**

Do not assume the proposed report list is correct.

Do not assume the current database values are correct.

Do not redesign CoopLogNG's financial logic.

Use the existing application workflow and data model as the primary source of truth.

The objective is to make CoopLogNG capable of producing a **professional, traceable Accounting Pack from its actual operational data**, so that an accountant or auditor can use the workbook as the underlying accounting evidence when preparing the cooperative's formal financial statements.
