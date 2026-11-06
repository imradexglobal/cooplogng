# PDF-to-Excel Conversion Plan

## Overview
Intelligent conversion of PDF bank statements into a structured Excel workbook for the CoopLogNG application, with bank detection, data extraction, and remittance processing capabilities.

## Phase 1: PDF Analysis and Bank Grouping

### 1.1 PDF Inspection
- List all PDF files to be processed
- For each PDF, determine:
  - Bank associated with the statement
  - Account number and account name where available
  - Statement period (start date - end date)
  - Whether text is selectable or scanned/image-based
  - Unique statement layout characteristics

### 1.2 Bank Grouping
- Group PDFs by bank name (GTBank, Access Bank, FirstBank, UBA, etc.)
- Within each bank, identify distinct accounts
- Multiple PDFs from same account → consolidate into one worksheet

### 1.3 Known Bank Formats
Since no OCR/PDF parsing exists currently, design must handle:
- **GTBank**: [Research needed from sample statements]
- **Access Bank**: [Research needed]
- **FirstBank**: [Research needed]
- **UBA**: [Research needed]
- Other banks as they appear

## Phase 2: Data Extraction Standards

### 2.1 Standardised Columns
| Column | Description |
|---|---|
| Transaction Date | Actual transaction date |
| Value Date | Value date, if available |
| Description | Full transaction narration |
| Reference | Transaction reference or ID, if available |
| Debit | Amount withdrawn or debited (numerical) |
| Credit | Amount deposited or credited (numerical) |
| Balance | Running account balance (numerical) |
| Account Name | Account holder's name |
| Account Number | Bank account number |
| Bank | Name of the bank |
| Source File | Original PDF filename |
| Source Page | Original PDF page number |

### 2.2 Extraction Rules
- Preserve complete transaction narration (do not truncate)
- Do not omit transactions spanning multiple lines/pages
- Do not mistake opening/closing/brought-forward balances for transactions
- Correctly distinguish debit from credit
- Preserve transaction dates accurately
- Do not invent missing details
- Do not silently correct suspicious figures
- Handle scanned PDFs using OCR
- Detect duplicate statements and overlapping periods
- Do not automatically remove duplicate-looking transactions - verify first
- Preserve original transaction order within each account

## Phase 3: Consolidation Rules

### 3.1 Multiple Statements Same Bank
- Append all transactions to same bank worksheet
- Maintain account identification columns
- Arrange chronologically within each account
- Detect overlapping statement periods
- Verify closing balance of earlier statement agrees with opening balance of subsequent statement
- Do NOT combine different accounts just because same bank

### 3.2 Excel Workbook Design
- One worksheet per bank
- Descriptive worksheet names
- Bold column headers
- Excel filters enabled
- Freeze header row
- Date formatting: DD MMM, YYYY
- Financial amounts: two decimal places + thousand separators
- Negative amounts represented correctly
- Suitable column widths
- Each worksheet is an Excel Table (for filter/sort/analyse)
- Add SUMMARY worksheet as FIRST sheet with:
  - Bank name
  - Number of accounts identified
  - Number of PDF files processed
  - Total number of transactions extracted
  - Total debits
  - Total credits
  - Statement periods covered
  - Extraction status and identified issues
  - Must NOT double-count transactions across overlapping statements

## Phase 4: Reconciliation and QA

### 4.1 Verification Steps
- Compare extracted transaction counts against source statements
- Verify opening and closing balances
- Recalculate running balances where statement provides info
- Check debit/credit amounts not reversed
- Check for missing pages and incomplete extraction
- Flag transactions that could not be reliably interpreted
- Verify every PDF has been accounted for

### 4.2 Quality Flags
- Mark transactions that could not be reliably interpreted
- Report overlapping statement periods
- Note any OCR failures or ambiguous readings
- Identify accounts with missing data

## Phase 5: Deliverables

### 5.1 Excel Workbook
- Consolidated workbook with all banks
- One worksheet per bank plus SUMMARY sheet

### 5.2 Processing Report
- Each PDF processed
- Identified bank
- Account identified
- Statement period

### 5.3 Exception Report
- Transactions requiring manual review
- Pages requiring manual review
- OCR failures or ambiguous readings
- Any detected issues or anomalies

## Technical Implementation Notes

### 5.4 Technology Stack
- **Python** with `pdfplumber` or `pymupdf` for PDF text extraction
- **Tesseract OCR** via `pytesseract` for scanned PDFs
- **Openpyxl** or **XlsxWriter** for Excel workbook creation
- **jsPDF** already available in the app for exporting (not for import)

### 5.5 Integration with CoopLogNG
- New feature: "Import Bank Statement" in the Remittance section
- User selects one or more PDF files
- System detects bank, extracts transactions
- User reviews uncertain extractions
- Valid transactions can be converted to remittances
- Uncertain transactions saved as "unknown payments" for manual review

### 5.6 Flow Diagram
```
User selects PDF(s)
    ↓
PDF Bank Detection ( classify bank based on headers, footers, account patterns )
    ↓
PDF Data Extraction (text/OCR based on bank format)
    ↓
Transaction Parsing (identify dates, amounts, descriptions, debits, credits)
    ↓
Balance Verification (check opening/closing balances)
    ↓
User Review Stage (flag uncertain extractions)
    ↓
Remittance Creation (convert verified transactions)
    ↓
Unknown Payments (save uncertain ones for manual review)
    ↓
Excel Export (consolidated workbook)
```

## Phase 6: Open Questions and Risks

### 6.1 Unknowns
- What PDF formats are actually in use? (Need to inspect sample statements)
- Does the app have OCR capabilities or need external tools?
- What level of automation is expected vs manual review?
- How to handle multiple accounts per bank statement?

### 6.2 Risks
- OCR accuracy for scanned statements
- Bank format variations within same bank
- Ambiguous transaction descriptions
- Overlapping statement periods
- Duplicate transactions across statements

### 6.3 Validation
- Must verify extracted data against original statements
- Cannot claim 100% accuracy without manual verification
- Exception report must list all items requiring review

## Next Steps
1. User provides sample PDF bank statements for analysis
2. Design bank-specific extraction parsers based on actual formats
3. Implement OCR pipeline for scanned PDFs
4. Build user review interface for uncertain extractions
5. Implement remittance creation from verified transactions
6. Test with actual bank statements from the cooperative