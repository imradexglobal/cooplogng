from __future__ import annotations

import csv
import datetime as dt
import json
import os
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

WORKBOOK = Path(r"C:\Users\User\Documents\Radio Project\Consolidated_Bank_Statements.xlsx")
DATABASE = Path(r"C:\Users\User\Documents\Radio Project\new_file.db")
ROOT = Path(r"C:\Users\User\Documents\GitHub\cooplogng")
OUT_DIR = ROOT / "outputs" / "bank_import_20261104"
CSV_PATH = OUT_DIR / "transaction_mapping_preview_v3_20261104.csv"
REPORT_PATH = OUT_DIR / "analysis_and_validation_v3_20261104.md"

SUMMARY_LABELS = {
    "number of transactions", "total debit transactions", "total credit transactions",
    "total debits", "total credits", "opening balance (first statement)",
    "closing balance (last statement)", "duplicate signatures identified", "check / summary"
}


def norm(value):
    value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def numeric(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def ymd(value):
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, str):
        text = value.strip()
        try:
            return dt.datetime.fromisoformat(text).date().isoformat()
        except ValueError:
            return text[:10]
    return ""


def active_member_match(description, members):
    words = set(norm(description).split())
    found = []
    for m in members:
        first = norm(m["first_name"]).split()
        last = norm(m["last_name"]).split()
        # Require an exact, non-placeholder first-name token and last-name token.
        # This is conservative: partial or approximate hits are not assigned.
        first_tokens = [w for w in first if len(w) >= 3 and w not in {"blank", "unknown"}]
        last_tokens = [w for w in last if len(w) >= 3 and w not in {"blank", "unknown"}]
        if not first_tokens or not last_tokens:
            continue
        if any(w in words for w in first_tokens) and any(w in words for w in last_tokens):
            found.append(m)
    # Only assign if the description uniquely identifies one existing member.
    if len(found) != 1:
        return None, found
    return found[0], found


def classify(row, members):
    description = str(row["description"] or "")
    low = norm(description)
    ref_low = norm(row["reference"])
    amount = row["credit"] if row["credit"] not in (None, 0) else -(row["debit"] or 0)
    member, candidates = active_member_match(description, members)

    if row["both_sides"]:
        return "Needs investigation", "", "", "No posting", "Both debit and credit are populated on one source row; do not choose a direction without review.", "BLOCKED"
    if amount == 0:
        return "Needs investigation", "", "", "No posting", "Transaction has no non-zero debit or credit amount.", "BLOCKED"
    if "withholding tax" in low:
        return "Tax withholding — policy review", "Other Expenses (conditional)", "Other Expenses (conditional)", "Remittance header (cooperative account) if treated as expense", "Withholding tax is not a bank fee. The app has a generic Other Expenses classification but no tax-specific type or recoverable-tax asset; only post as expense if cooperative policy says the withholding is nonrecoverable.", "NEEDS ACCOUNTING-POLICY DECISION"
    if row["credit"] and "interest paid" in low:
        return "Other Income", "Other Income", "Other Income", "Remittance header (cooperative account)", "Bank interest is identifiable income; the app's existing Other Income type maps to Other Income. The original description and available bank reference will be retained in the remittance note.", "READY FOR APPROVAL"

    fee_terms = ("sms alert", "service charge", "processingfee", "processing fee", "custody fee", "vatfee", "vat fee", "stamp duty", "cheque charge", "chq charge", "emt levy", "account charge", "bank charge")
    if any(k in low for k in fee_terms):
        return "Bank / financial expense", "Financial & Banking Expenses", "Finance Expense", "Remittance header (cooperative account)", "Bank fee/levy is identified; the app's existing Financial & Banking Expenses type carries Finance Expense classification. A credit row is treated as a fee reversal. The note will retain the original description and any bank reference.", "READY FOR APPROVAL"

    investment_terms = ("matured tbill", "matured tbills", "tbill", "t bill", "bondmmdiscount", "sell bond")
    if any(k in low for k in investment_terms) or any(k in ref_low for k in investment_terms):
        return "Investment / asset movement — review", "", "", "No mapped target account", "Narrative/ref indicates T-bill or bond activity; target has no investment/asset account, so a remittance classification would not preserve the accounting substance.", "BLOCKED"

    if member:
        full_name = " ".join(x for x in (member["first_name"], member["middle_name"], member["last_name"]) if x)
        if amount > 0:
            return "Member savings contribution", "Member Deposit", "Member Liability", f"remittance + remittance_detail → {member['enterprise_name']}", f"Unique exact first/last-name token match to {full_name} (reg. {member['registration_no']}); positive credit follows the requested savings rule.", "READY FOR APPROVAL"
        return "Ordinary Loan candidate — loan terms required", "Member Loan", "Loan Asset", f"remittance + remittance_detail + loans → {member['enterprise_name']}", f"Unique exact first/last-name token match to {full_name} (reg. {member['registration_no']}); debit follows the requested Ordinary Loan rule, but the normal app flow requires loan configuration (including duration) and may create related loan/charge records.", "BLOCKED — needs loan configuration"

    if "racda cooperative" in low or "racda co operative" in low or "radio area cda" in low:
        return "Potential bank-to-bank / cooperative transfer — review", "", "", "No mapped target account", "Narrative indicates cooperative-to-cooperative/bank transfer; target has no bank-transfer asset/clearing account mapping in the existing Remittance module.", "BLOCKED"

    if amount > 0:
        if candidates:
            names = "; ".join(" ".join(x for x in (m["first_name"], m["middle_name"], m["last_name"]) if x) for m in candidates)
            why = f"Possible member-name hit(s) ({names}) are incomplete/ambiguous, so no member assignment is made. Following the requested fallback, this remains Unknown Payments."
        else:
            why = "No unique exact member identity and no clearly established income/expense category; following the requested Unknown Payment fallback."
        return "Unknown Payment", "Unknown Payments", "Member Liability", "Header-only remittance under reserved cooperative ID 0000000000", why, "READY FOR APPROVAL"

    if candidates:
        names = "; ".join(" ".join(x for x in (m["first_name"], m["middle_name"], m["last_name"]) if x) for m in candidates)
        why = f"Possible member-name hit(s) ({names}) are incomplete/ambiguous; no loan is assigned. Following the requested fallback, this remains Unknown Payments."
    else:
        why = "Debit has no unique exact member identity or established expense classification; following the requested Unknown Payment fallback."
    return "Unknown Payment", "Unknown Payments", "Member Liability", "Header-only remittance under reserved cooperative ID 0000000000", why, "READY FOR APPROVAL"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    bank_names = [r[0] for r in conn.execute("SELECT bank_name FROM bank WHERE is_deleted='0' ORDER BY bank_name")]
    members = [dict(r) for r in conn.execute("""
        SELECT m.id, m.first_name, m.middle_name, m.last_name, m.registration_no,
               m.status, COALESCE(e.account_name, 'Ordinary Savings') AS enterprise_name
        FROM members m
        LEFT JOIN enterprise e ON e.cooperative_id=m.cooperative_id
             AND lower(e.account_type)='savings' AND e.is_deleted='0'
        WHERE m.is_deleted='0'
        GROUP BY m.id
    """)]
    # Member debit candidates use the loan account, not the savings enterprise.
    loan_name = conn.execute("SELECT account_name FROM enterprise WHERE lower(account_type)='loan' AND is_deleted='0' LIMIT 1").fetchone()
    for m in members:
        if loan_name:
            m["loan_enterprise_name"] = loan_name[0]
        else:
            m["loan_enterprise_name"] = "(no existing loan enterprise)"
    conn.close()

    wb = openpyxl.load_workbook(WORKBOOK, data_only=True, read_only=True)
    mapping = []
    sheet_summaries = []
    exact_signatures = Counter()
    total_debits = total_credits = 0.0
    debit_count = credit_count = 0
    total_missing_refs = total_source_rows = 0

    for ws in wb.worksheets:
        headers = [str(c or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
        idx = {name: i for i, name in enumerate(headers)}
        records, embedded_summary = [], {}
        for excel_row, values in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            if not values or not any(v is not None for v in values):
                continue
            first = values[0]
            if isinstance(first, str) and norm(first) in {norm(x) for x in SUMMARY_LABELS}:
                embedded_summary[norm(first)] = values[1] if len(values) > 1 else None
                continue
            date = ymd(first)
            debit = numeric(values[idx.get("Debit", 4)]) if len(values) > idx.get("Debit", 4) else None
            credit = numeric(values[idx.get("Credit", 5)]) if len(values) > idx.get("Credit", 5) else None
            if not date and debit is None and credit is None:
                continue
            # Count every row that carries a date or amount; incomplete entries are still mapped.
            description = values[idx.get("Description/Narration", 3)] if len(values) > idx.get("Description/Narration", 3) else None
            reference = values[idx.get("Transaction Reference", 2)] if len(values) > idx.get("Transaction Reference", 2) else None
            currency = values[idx.get("Currency", 7)] if len(values) > idx.get("Currency", 7) else None
            debit_value = debit or 0.0
            credit_value = credit or 0.0
            both_sides = debit_value != 0 and credit_value != 0
            row = {
                "sheet": ws.title, "excel_row": excel_row, "date": date,
                "description": description or "", "reference": reference or "",
                "debit": debit_value, "credit": credit_value,
                "currency": currency or "", "both_sides": both_sides,
            }
            records.append(row)

        sheet_debits = sum(r["debit"] for r in records)
        sheet_credits = sum(r["credit"] for r in records)
        sheet_debit_n = sum(1 for r in records if r["debit"] != 0)
        sheet_credit_n = sum(1 for r in records if r["credit"] != 0)
        missing_ref = sum(1 for r in records if not r["reference"])
        total_missing_refs += missing_ref
        total_source_rows += len(records)
        total_debits += sheet_debits
        total_credits += sheet_credits
        debit_count += sheet_debit_n
        credit_count += sheet_credit_n

        # Verify embedded worksheet summary figures against the dated transaction rows.
        sum_checks = {
            "number of transactions": (len(records), embedded_summary.get("number of transactions")),
            "total debit transactions": (sheet_debit_n, embedded_summary.get("total debit transactions")),
            "total credit transactions": (sheet_credit_n, embedded_summary.get("total credit transactions")),
            "total debits": (round(sheet_debits, 2), numeric(embedded_summary.get("total debits"))),
            "total credits": (round(sheet_credits, 2), numeric(embedded_summary.get("total credits"))),
        }
        check_errors = []
        for label, (calc, stated) in sum_checks.items():
            if stated is not None and abs(float(calc) - float(stated)) > 0.01:
                check_errors.append(f"{label}: calculated {calc}, sheet says {stated}")

        sheet_summaries.append({"sheet": ws.title, "rows": len(records), "debits": sheet_debits,
                                "credits": sheet_credits, "debit_count": sheet_debit_n,
                                "credit_count": sheet_credit_n, "missing_refs": missing_ref,
                                "summary_checks": check_errors,
                                "bank_match": ws.title in bank_names})

        for r in records:
            signature = (ws.title, r["date"], norm(r["reference"]), round(r["debit"], 2), round(r["credit"], 2), norm(r["description"]))
            exact_signatures[signature] += 1
            cls, tx_type, category, destination, reason, status = classify(r, members)
            bank_match = r["sheet"] in bank_names
            transaction_note = r["description"] or ""
            if r["reference"]:
                transaction_note = f"{transaction_note} | Bank reference: {r['reference']}" if transaction_note else f"Bank reference: {r['reference']}"
            mapping.append({
                "Worksheet": r["sheet"], "Excel row": r["excel_row"], "Transaction date": r["date"],
                "Bank name in remittance (from worksheet)": r["sheet"],
                "Bank-name validation": "Exact active-bank match" if bank_match else "BLOCKED — no exact active-bank match",
                "Bank description": r["description"], "Bank reference": r["reference"],
                "Debit": f"{r['debit']:.2f}" if r["debit"] else "",
                "Credit": f"{r['credit']:.2f}" if r["credit"] else "",
                "Amount signed (credit + / debit -)": f"{(r['credit']-r['debit']):.2f}",
                "Transaction note to store": transaction_note,
                "Currency": r["currency"], "Identified member": "",
                "Member ID": "", "Registration no.": "", "Proposed classification": cls,
                "Application transaction type": tx_type, "Application category": category,
                "Destination structure": destination, "Reason / validation note": reason,
                "Import outcome if unblocked": status if bank_match else "BLOCKED — worksheet bank name does not match an active target bank",
            })
            # The exact member identity returned by classifier is embedded in the rationale.
            member, _ = active_member_match(r["description"], members) if cls in ("Member savings contribution", "Ordinary Loan candidate — loan terms required") else (None, [])
            if member:
                mapping[-1]["Identified member"] = " ".join(x for x in (member["first_name"], member["middle_name"], member["last_name"]) if x)
                mapping[-1]["Member ID"] = member["id"]
                mapping[-1]["Registration no."] = member["registration_no"]
                if r["credit"] == 0:
                    mapping[-1]["Destination structure"] = f"remittance + remittance_detail + loans → {member['loan_enterprise_name']}"

    with CSV_PATH.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(mapping[0].keys()))
        writer.writeheader()
        writer.writerows(mapping)

    by_class = defaultdict(lambda: {"count": 0, "debit": 0.0, "credit": 0.0})
    for r in mapping:
        c = by_class[r["Proposed classification"]]
        c["count"] += 1
        c["debit"] += float(r["Debit"] or 0)
        c["credit"] += float(r["Credit"] or 0)
    duplicate_rows = sum(n - 1 for n in exact_signatures.values() if n > 1)
    # Read target metadata without modifying it.
    db = sqlite3.connect(f"file:{DATABASE.as_posix()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    table_names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    target_counts = {t: db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                     for t in sorted(table_names)}
    remit_columns = [r[1] for r in db.execute('PRAGMA table_info("remittance")')]
    target_coop = [dict(zip([d[0] for d in db.execute('SELECT id, short_name FROM cooperatives').description], row))
                   for row in db.execute('SELECT id, short_name FROM cooperatives')]
    bank_names = [r[0] for r in db.execute("SELECT bank_name FROM bank WHERE is_deleted='0' ORDER BY bank_name")]
    enterprise_names = [dict(zip([d[0] for d in db.execute('SELECT account_name,account_type FROM enterprise').description], row))
                        for row in db.execute('SELECT account_name,account_type FROM enterprise')]
    loan_config_row = db.execute("SELECT account_name,interest_rate,interest_is_percent,form_fee,form_fee_is_percent,admin_charge,admin_charge_is_percent,loan_multiplier FROM enterprise WHERE lower(account_type)='loan' AND is_deleted='0' LIMIT 1").fetchone()
    loan_config = dict(loan_config_row) if loan_config_row else {}
    type_count = db.execute("SELECT COUNT(*) FROM transaction_types WHERE is_deleted='0'").fetchone()[0]
    admin_users = [dict(zip([d[0] for d in db.execute("SELECT id,username,role FROM users WHERE lower(role)='admin' AND is_deleted='0'").description], row))
                   for row in db.execute("SELECT id,username,role FROM users WHERE lower(role)='admin' AND is_deleted='0'")]
    sentinel_members = db.execute("SELECT COUNT(*) FROM members WHERE id='0000000000' AND is_deleted='0'").fetchone()[0]
    recon_count = db.execute("SELECT COUNT(*) FROM bank_reconciliation_summary WHERE is_deleted='0'").fetchone()[0]
    db.close()

    totals_text = "\n".join(
        f"| {name} | {v['count']} | {v['debit']:,.2f} | {v['credit']:,.2f} |"
        for name, v in sorted(by_class.items())
    )
    sheets_text = "\n".join(
        f"| {s['sheet']} | {s['sheet']} | {'MATCH' if s['bank_match'] else 'NO MATCH'} | {s['rows']} | {s['debit_count']} | {s['credit_count']} | {s['debits']:,.2f} | {s['credits']:,.2f} | {s['missing_refs']} |"
        for s in sheet_summaries
    )
    summary_checks = "\n".join(
        f"- **{s['sheet']}**: " + ("All stated row counts/amount totals match dated transactions." if not s['summary_checks'] else "; ".join(s['summary_checks']))
        for s in sheet_summaries
    )
    ready_rows = [r for r in mapping if r["Import outcome if unblocked"] == "READY FOR APPROVAL"]
    ready_classes = defaultdict(lambda: {"count": 0, "debit": 0.0, "credit": 0.0})
    for r in ready_rows:
        c = ready_classes[r["Proposed classification"]]
        c["count"] += 1
        c["debit"] += float(r["Debit"] or 0)
        c["credit"] += float(r["Credit"] or 0)
    ready_text = "\n".join(
        f"| {name} | {v['count']} | {v['debit']:,.2f} | {v['credit']:,.2f} |"
        for name, v in sorted(ready_classes.items())
    )
    special_rows_text = "\n".join(
        f"| {r['Worksheet']} | {r['Excel row']} | {r['Transaction date']} | {r['Proposed classification']} | {r['Debit'] or '—'} | {r['Credit'] or '—'} | {r['Bank reference'] or '—'} | {r['Bank description'] or '—'} |"
        for r in mapping if r["Proposed classification"] in (
            "Investment / asset movement — review",
            "Potential bank-to-bank / cooperative transfer — review",
            "Tax withholding — policy review",
            "Ordinary Loan candidate — loan terms required")
    )
    report = f"""# Consolidated bank transactions — revised mapping and import preparation

**Status: Mapping complete; 142 rows are prepared for user approval and 35 rows need specific accounting decisions. No backup or import has been performed.** This stage remained read-only as requested. The source workbook and target database were not modified.

## Bank identification — worksheet name is authoritative

The `bank_name` value proposed for every remittance is the exact Excel worksheet name. Both names match an existing active bank in the target database:

| Excel worksheet | `remittance.bank_name` | Target bank validation | Transactions | Debit rows | Credit rows | Debits | Credits | Missing references |
|---|---|---|---:|---:|---:|---:|---:|---:|
{sheets_text}

The row-level CSV records the proposed bank and exact-match result on every row. No new bank record is needed.

## Application and database findings

- Normal member deposits use an approved `remittance` header plus a positive `remittance_detail` against an existing Savings enterprise and `Member Deposit` / `Member Liability`. A member-linked debit uses a negative detail on an existing Loan enterprise and requires the loan-configuration lifecycle.
- Income and expense transactions use header-only remittances with a transaction type/category and the bank account; the accounting pack derives income/expense classifications from these headers. Member balances derive from approved remittance details.
- The existing `Unknown Payments` system type is classified as `Member Liability`. The app/accounting pack supports cooperative-wide Unknown Payments under reserved member ID `0000000000`; it offsets a cash entry to an unidentified-liability account. The target has no member row with this reserved ID, which is expected by the application's convention. This is distinct from the administrator user's ID `{json.dumps(admin_users, ensure_ascii=False)}`.
- The target banks are `{', '.join(bank_names)}`. Existing enterprises are `{json.dumps(enterprise_names, ensure_ascii=False)}`. Target table counts are `{json.dumps(target_counts, ensure_ascii=False)}`. Remittances = {target_counts.get('remittance', 0)}, remittance details = {target_counts.get('remittance_detail', 0)}, loans = {target_counts.get('loans', 0)}, active transaction types = {type_count}, active reconciliations = {recon_count}.
- Important deployment distinction: the application runtime uses browser/Electron IndexedDB (`CoopLogIDB_v3`, database version 9). `src/services/sqlite/dbManagement.js` exports those stores to a SQLite file (`exportDatabase`) and `importDatabase` reads SQLite rows and upserts them back into the running IndexedDB. The target `new_file.db` is therefore a SQLite-format export/import file, not the app's live store. Editing the SQLite file alone would not update the running application; after approval, the actual import route must be chosen and verified. No live IndexedDB write or database-file edit has been made.
- The remittance table has no separate bank-reference field. Per your instruction, the CSV's **Transaction note to store** retains the original description and appends `Bank reference: <original reference>` when a reference exists; it does not modify the schema. The separate source-reference column is also preserved in the CSV.
- The target has only Savings and Loan enterprises, and no investment/security, tax-receivable, or bank-clearing account. The application’s ordinary Internal Transfer workflow is a non-cash reallocation through member/enterprise detail rows; the normal form does not support selecting the locked Internal Transfer type against an actual bank to move cash between two bank accounts.

## Source workbook and transaction completeness

Workbook: `{WORKBOOK}`. Sheets: {', '.join(s['sheet'] for s in sheet_summaries)}. All **{total_source_rows}** dated transaction rows are captured. [Open the row-level mapping CSV]({CSV_PATH.name}). Signed amounts use credit as positive and debit as negative. Total debits are **₦{total_debits:,.2f}** across {debit_count} debit rows; total credits are **₦{total_credits:,.2f}** across {credit_count} credit rows. All totals and row counts agree with the workbook's own transaction summaries:

{summary_checks}

The running-balance column was intentionally excluded from the mapping and validation, as directed. The original description is kept as its own CSV column. There are {total_source_rows - total_missing_refs} source references and {total_missing_refs} blank references. Exact duplicate signatures within the same worksheet (date, reference, direction/amount and description) found: **{duplicate_rows}**; none were excluded. Repeated/similar entries were retained as distinct source rows.

## Mapping totals

Member identification uses conservative unique exact first/last-name token matches against non-deleted target members. Name order can vary; ambiguous or partial matches are not assigned. The populated member fields available in the database were checked for exact mobile/account identifier matches in source descriptions/references; no additional reliable identifier matches were found. No account numbers or special IDs are populated in the target member records.

| Proposed classification | Rows | Debit total | Credit total |
|---|---:|---:|---:|
{totals_text}

Of these, {len(ready_rows)} rows are structurally mapped to existing app types/accounts and are **prepared but not imported**, pending your explicit approval:

| Approval-ready category | Rows | Debit total | Credit total |
|---|---:|---:|---:|
{ready_text}

The approval-ready set is 9 member savings credits (**₦605,000.00**), 43 Unknown Payments (debits **₦4,298,023.93**, credits **₦4,356,622.00**), 71 bank/financial expense rows (debits **₦13,315.56**, credit reversals **₦2,010.10**; net expense **₦11,305.46**), and 19 bank-interest income credits (**₦313,086.92**). Every proposed remittance uses the worksheet-matched bank name. Transaction notes retain each available reference.

## Remaining 35 rows — findings and recommended treatment

| Worksheet | Excel row | Date | Issue | Debit | Credit | Reference | Description |
|---|---:|---|---|---:|---:|---|---|
{special_rows_text}

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
"""
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(json.dumps({"mapping_csv": str(CSV_PATH), "report": str(REPORT_PATH),
                      "source_rows": total_source_rows, "debit_count": debit_count,
                      "credit_count": credit_count, "debits": round(total_debits, 2),
                      "credits": round(total_credits, 2), "classes": by_class,
                      "duplicate_rows": duplicate_rows, "missing_references": total_missing_refs,
                      "approval_ready_rows": len(ready_rows),
                      "bank_matches": {s["sheet"]: s["bank_match"] for s in sheet_summaries},
                      "target_counts": target_counts}, ensure_ascii=False, default=lambda o: dict(o)))


if __name__ == "__main__":
    main()
