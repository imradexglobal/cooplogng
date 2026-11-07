from __future__ import annotations

import argparse
import csv
import datetime as dt
import decimal
import hashlib
import json
import os
import posixpath
import re
import shutil
import sqlite3
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(r"C:\Users\User\Documents\GitHub\cooplogng")
PROJECT = Path(r"C:\Users\User\Documents\OGSC Project")
SOURCE = PROJECT / "outputs" / "Consolidated_Bank_Statements_Complete.xlsx"
DB = PROJECT / "new.db"
OUT = PROJECT / "outputs" / "UBA_Remittance_Import_2026-11-07"
COOP = "OGSC"
BANK = "UBA"
ACTOR = "admin"
PSEUDO_MEMBER = "0000000000"
IMPORT_TAG = "OGSC-SiD9mFKs6g-UBAIMP-20261107"
EXPECTED_SOURCE_ROWS = 1495
EXPECTED_DEBITS = decimal.Decimal("102701401.55")
EXPECTED_CREDITS = decimal.Decimal("101822184.08")
CENT = decimal.Decimal("0.01")

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p": "http://schemas.openxmlformats.org/package/2006/relationships",
}

REMITTANCE_COLUMNS = [
    "id", "cooperative_id", "member_id", "amount", "bank_name", "description",
    "transaction_type", "category", "status", "remittance_date", "created_by",
    "created_at", "modified_by", "modified_at", "is_deleted", "is_synced",
    "sync_at", "deleted_at", "reconciliation_summary_id", "autogen", "loan_id",
    "isWithdrawalRequest", "isLoanRequest", "parent_remittance_id",
    "withdrawal_form_image", "withdrawal_form_images", "request_reference",
    "request_status_history", "requester_bank_details", "reviewer_comment",
    "rejection_reason", "submitted_by_role", "approved_by", "approved_at",
]
DETAIL_COLUMNS = [
    "id", "cooperative_id", "remittance_id", "enterprise_id", "amount",
    "auto_description", "loan_info", "created_by", "created_at", "modified_by",
    "modified_at", "is_synced", "is_deleted", "sync_at", "deleted_at",
]
LOAN_COLUMNS = [
    "id", "cooperative_id", "member_id", "enterprise_id", "principal_amount",
    "issued_date", "due_date", "status", "notes", "created_at", "created_by",
    "modified_at", "modified_by", "deleted_at", "is_synced", "is_deleted",
    "sync_at", "admin_fee_id", "duration_months", "remittance_id", "approved_at",
    "monthly_advice_amount",
]

FEE_PATTERNS = [
    r"\bstamp\s*duty\b", r"\bsms\s*charges?\b", r"\bsms\s*fee\b",
    r"\bbank\s*charges?\b", r"\bservice\s*charges?\b", r"\baccount\s*maintenance\b",
    r"\bstatement\s*charges?\b", r"\bcharges?\s*fee\s*for\s*ticket\b",
    r"\bfee\s*for\s*ticket\b", r"\bvat\s*(?:on\s*)?(?:bank\s*)?charges?\b",
    r"\bnibss\s*(?:fee|charge|levy)\b", r"\bcommission\s*(?:fee|charge)\b",
    r"\baccount\s*charge\b", r"\btransfer\s*charge\b", r"\btransaction\s*charge\b",
]
INTEREST_PATTERNS = [
    r"\bbank\s+interest\b", r"\binterest\s+(?:paid|earned|credited|credit)\b",
    r"\bcredit\s+interest\b", r"\binterest\s+on\s+(?:account|balance|deposit)\b",
    r"\binterest\s+on\s+(?:a\s+)?loan\b", r"\bint\.?\s*pd\b", r"\bint\.?\s*paid\b",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def db_fingerprint(path: Path) -> dict:
    files = {}
    for p in (path, Path(str(path) + "-wal")):
        if p.exists():
            files[p.name] = {"sha256": sha256(p), "size": p.stat().st_size}
    return files


def open_db(path: Path, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        conn = sqlite3.connect(str(path), timeout=30)
        conn.execute("PRAGMA query_only=ON")
    else:
        conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {name: conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in tables}


def table_hash(conn: sqlite3.Connection, table: str) -> str:
    cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
    h = hashlib.sha256()
    query = f'SELECT {",".join(chr(34)+c+chr(34) for c in cols)} FROM "{table}" ORDER BY rowid'
    for row in conn.execute(query):
        h.update(json.dumps(tuple(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def _excel_date(value: float) -> str:
    return (dt.datetime(1899, 12, 30) + dt.timedelta(days=value)).isoformat(sep=" ", timespec="seconds")


def parse_xlsx(path: Path) -> list[dict]:
    """Read workbook cached values via the XLSX XML package, without resaving source."""
    with zipfile.ZipFile(path, "r") as z:
        names = set(z.namelist())
        workbook = ET.fromstring(z.read("xl/workbook.xml"))
        relroot = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rels = {rel.attrib["Id"]: rel.attrib["Target"] for rel in relroot}
        shared = []
        if "xl/sharedStrings.xml" in names:
            ssroot = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in ssroot.findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        style_root = ET.fromstring(z.read("xl/styles.xml")) if "xl/styles.xml" in names else None
        custom_formats = {}
        if style_root is not None:
            for fmt in style_root.findall("m:numFmts/m:numFmt", NS):
                custom_formats[int(fmt.attrib["numFmtId"])] = fmt.attrib.get("formatCode", "")
        builtin_date_formats = {14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47}
        date_style_indexes = set()
        if style_root is not None:
            xfs = style_root.find("m:cellXfs", NS)
            if xfs is not None:
                for style_index, xf in enumerate(xfs):
                    num_fmt_id = int(xf.attrib.get("numFmtId", "0"))
                    fmt = custom_formats.get(num_fmt_id, "").lower()
                    if num_fmt_id in builtin_date_formats or any(token in fmt for token in ("yy", "dd", "mm/", "dd/")):
                        date_style_indexes.add(style_index)

        def column_number(ref: str) -> int:
            letters = re.match(r"[A-Z]+", ref).group(0)
            n = 0
            for letter in letters:
                n = n * 26 + ord(letter) - 64
            return n

        def cell_value(cell: ET.Element):
            kind = cell.attrib.get("t")
            if kind == "inlineStr":
                return "".join(t.text or "" for t in cell.iter(f"{{{NS['m']}}}t"))
            v = cell.find("m:v", NS)
            if v is None:
                return None
            raw = v.text or ""
            if kind == "s":
                return shared[int(raw)]
            if kind == "b":
                return raw == "1"
            if kind in ("str", "d", "e"):
                return raw
            try:
                num = float(raw)
            except (TypeError, ValueError):
                return raw
            if kind == "d":
                return raw
            style = int(cell.attrib.get("s", "0"))
            if style in date_style_indexes:
                return _excel_date(num)
            return int(num) if num.is_integer() else num

        result = []
        sheets_node = workbook.find("m:sheets", NS)
        for sheet in sheets_node:
            target = rels[sheet.attrib[f"{{{NS['r']}}}id"]]
            if target.startswith("/"):
                sheet_path = target.lstrip("/")
            else:
                sheet_path = posixpath.normpath(posixpath.join("xl", target))
            root = ET.fromstring(z.read(sheet_path))
            out_rows = []
            data_node = root.find("m:sheetData", NS)
            if data_node is not None:
                for row in data_node.findall("m:row", NS):
                    cells = [(column_number(c.attrib["r"]), cell_value(c)) for c in row.findall("m:c", NS)]
                    width = max((i for i, _ in cells), default=0)
                    values = [None] * width
                    for i, value in cells:
                        values[i - 1] = value
                    if any(v is not None for v in values):
                        out_rows.append({"row": int(row.attrib["r"]), "values": values})
            result.append({"name": sheet.attrib["name"], "rows": out_rows})
        return result


def norm(value) -> str:
    text = str(value or "").lower()
    text = text.translate(str.maketrans({"’": "'", "–": "-", "—": "-"}))
    text = __import__("unicodedata").normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def as_decimal(value, field: str) -> decimal.Decimal:
    if value in (None, ""):
        return decimal.Decimal("0")
    try:
        return decimal.Decimal(str(value)).quantize(CENT)
    except decimal.InvalidOperation as exc:
        raise ValueError(f"Non-numeric {field}: {value!r}") from exc


def amount_text(value: decimal.Decimal) -> str:
    return format(value.quantize(CENT), ".2f")


def date_iso(value) -> tuple[str, str]:
    if isinstance(value, dt.datetime):
        d = value.date()
    elif isinstance(value, dt.date):
        d = value
    else:
        text = str(value or "").strip()
        try:
            d = dt.datetime.fromisoformat(text.replace("Z", "+00:00")).date()
        except ValueError:
            d = dt.date.fromisoformat(text[:10])
    ymd = d.isoformat()
    return ymd, f"{ymd}T00:00:00.000Z"


def row_get(row: dict, index: dict[str, int], key: str):
    pos = index.get(key)
    if pos is None or pos >= len(row["values"]):
        return None
    return row["values"][pos]


def active_member_candidates(description: str, members: list[dict]) -> list[dict]:
    words = set(norm(description).split())
    candidates = []
    for m in members:
        first_tokens = [x for x in norm(m.get("first_name")).split() if len(x) >= 3 and x not in {"blank", "unknown"}]
        last_tokens = [x for x in norm(m.get("last_name")).split() if len(x) >= 3 and x not in {"blank", "unknown"}]
        if first_tokens and last_tokens and any(x in words for x in first_tokens) and any(x in words for x in last_tokens):
            candidates.append(m)
    return candidates


def name_label(m: dict) -> str:
    return " ".join(str(m.get(k) or "").strip() for k in ("first_name", "middle_name", "last_name") if str(m.get(k) or "").strip())


def classify(row: dict, candidates: list[dict]) -> tuple[str, str, str, str, str]:
    text = norm(row["bank_description"])
    # Explicit financial institution levies/fees are classed as financial expense,
    # including a positive reversal; do not force these through member accounts.
    if any(re.search(pat, text) for pat in FEE_PATTERNS):
        return "Financial & Banking Expenses", "Finance Expense", "", "bank_fee", "Bank fee/levy identified directly in statement narration."
    if row["signed_amount"] > 0 and any(re.search(pat, text) for pat in INTEREST_PATTERNS):
        return "Other Income", "Other Income", "", "bank_income", "Bank interest credit identified directly in statement narration."
    if len(candidates) == 1:
        if row["signed_amount"] > 0:
            return "Member Deposit", "Member Liability", "Ordinary Savings", "member_match", "Unique exact first/last-name token match to an active database member; positive bank credit allocated to Ordinary Savings as instructed."
        return "Member Loan", "Loan Asset", "Ordinary Loan", "member_match", "Unique exact first/last-name token match to an active database member; bank debit allocated to Ordinary Loan as instructed. Loan term is absent from the statement and remains unspecified."
    if len(candidates) > 1:
        return "Unknown Payments", "Suspense", "", "ambiguous_member", "Multiple existing members match the bank narration; no member is selected. Held in Suspense."
    return "Unknown Payments", "Suspense", "", "no_member_match", "No unique active member match or clearly identified bank fee/income classification; held in Suspense rather than assigned by assumption."


def create_mapping(conn: sqlite3.Connection, workbook_sheets: list[dict]) -> tuple[list[dict], dict]:
    by_name = {s["name"]: s for s in workbook_sheets}
    sheet_name = "UBA 2272760240"
    if sheet_name not in by_name:
        raise ValueError(f"Expected statement worksheet {sheet_name!r} not found")
    stmt = by_name[sheet_name]
    header_row = next((r for r in stmt["rows"] if r["row"] == 11), None)
    if not header_row:
        raise ValueError("Transaction header row 11 missing")
    headers = [str(v or "").strip() for v in header_row["values"]]
    index = {name: i for i, name in enumerate(headers)}
    required_headers = {"Transaction Date", "Transaction Description", "Reference / Transaction ID", "Debit", "Credit", "Balance"}
    if not required_headers.issubset(index):
        raise ValueError(f"Missing required statement columns: {required_headers - set(index)}")
    metadata = {r["row"]: r["values"] for r in stmt["rows"] if r["row"] in (5,)}
    metadata_row = metadata.get(5, [])
    if len(metadata_row) < 5:
        raise ValueError("Statement opening/closing balance metadata row is incomplete")
    opening = as_decimal(metadata_row[1], "opening balance")
    expected_closing = as_decimal(metadata_row[4], "closing balance")

    members = [dict(r) for r in conn.execute(
        "SELECT id,first_name,middle_name,last_name,registration_no,status FROM members "
        "WHERE cooperative_id=? AND is_deleted='0' AND lower(status)='active'", (COOP,)
    )]
    banks = {r[0] for r in conn.execute("SELECT bank_name FROM bank WHERE cooperative_id=? AND is_deleted='0'", (COOP,))}
    if BANK not in banks:
        raise ValueError(f"Active bank {BANK!r} missing for cooperative {COOP}")
    enterprises = {r["account_name"]: dict(r) for r in conn.execute(
        "SELECT id,account_name,account_type FROM enterprise WHERE cooperative_id=? AND is_deleted='0'", (COOP,)
    )}
    for name, typ in (("Ordinary Savings", "savings"), ("Ordinary Loan", "loan")):
        e = enterprises.get(name)
        if not e or str(e["account_type"] or "").lower() != typ:
            raise ValueError(f"Expected active {typ} enterprise {name!r} not found")
    admin = conn.execute("SELECT username FROM users WHERE cooperative_id=? AND username=? AND is_deleted='0'", (COOP, ACTOR)).fetchone()
    if not admin:
        raise ValueError(f"App audit identity {ACTOR!r} is missing/inactive")

    entries = []
    signatures = Counter()
    total_debits = decimal.Decimal("0.00")
    total_credits = decimal.Decimal("0.00")
    closing = None
    for row in stmt["rows"]:
        if row["row"] <= 11:
            continue
        raw_date = row_get(row, index, "Transaction Date")
        raw_desc = row_get(row, index, "Transaction Description")
        debit = as_decimal(row_get(row, index, "Debit"), "Debit")
        credit = as_decimal(row_get(row, index, "Credit"), "Credit")
        balance = as_decimal(row_get(row, index, "Balance"), "Balance")
        if raw_date is None and raw_desc is None and debit == 0 and credit == 0:
            continue
        if (debit > 0 and credit > 0) or (debit == 0 and credit == 0):
            raise ValueError(f"Invalid source debit/credit sides at Excel row {row['row']}")
        if not raw_date:
            raise ValueError(f"Missing date at Excel row {row['row']}")
        ymd, date_app = date_iso(raw_date)
        description = str(raw_desc or "").strip()
        if not description:
            raise ValueError(f"Missing narration at Excel row {row['row']}")
        reference = str(row_get(row, index, "Reference / Transaction ID") or "").strip()
        signed = (credit - debit).quantize(CENT)
        candidates = active_member_candidates(description, members)
        item = {
            "source_sheet": sheet_name,
            "excel_row": row["row"],
            "bank_date": ymd,
            "date_app": date_app,
            "bank_description": description,
            "reference": reference,
            "debit": debit,
            "credit": credit,
            "signed_amount": signed,
            "balance": balance,
            "candidate_members": candidates,
        }
        tx, category, enterprise_name, disposition, rationale = classify(item, candidates)
        item.update({"transaction_type": tx, "category": category, "enterprise_name": enterprise_name,
                     "match_disposition": disposition, "rationale": rationale})
        if disposition == "member_match":
            item["member"] = candidates[0]
            item["member_id"] = candidates[0]["id"]
            item["member_name"] = name_label(candidates[0])
            item["registration_no"] = candidates[0].get("registration_no") or ""
            item["enterprise_id"] = enterprises[enterprise_name]["id"]
        else:
            item["member"] = None
            item["member_id"] = PSEUDO_MEMBER
            item["member_name"] = ""
            item["registration_no"] = ""
            item["enterprise_id"] = ""
        item["candidate_labels"] = " | ".join(
            f"{name_label(m)} (reg. {m.get('registration_no') or 'n/a'})" for m in candidates
        )
        item["database_description"] = description + (f" | Ref: {reference}" if reference else "")
        item["remittance_id"] = f"{IMPORT_TAG}-R{row['row']:04d}"
        item["detail_id"] = f"{item['remittance_id']}-D1" if item["member"] else ""
        item["loan_id"] = f"{item['remittance_id']}-L1" if item["enterprise_name"] == "Ordinary Loan" else ""
        total_debits += debit
        total_credits += credit
        signatures[(ymd, description, reference, debit, credit)] += 1
        closing = balance
        entries.append(item)

    if len(entries) != EXPECTED_SOURCE_ROWS:
        raise ValueError(f"Expected {EXPECTED_SOURCE_ROWS} statement rows, parsed {len(entries)}")
    if total_debits != EXPECTED_DEBITS or total_credits != EXPECTED_CREDITS:
        raise ValueError(f"Workbook totals mismatch: debit={total_debits}, credit={total_credits}")
    if any(n > 1 for n in signatures.values()):
        dupes = [k for k, n in signatures.items() if n > 1]
        raise ValueError(f"Duplicate statement signatures detected; do not deduplicate/append automatically: {len(dupes)}")
    prev = opening
    for item in entries:
        expected_balance = (prev - item["debit"] + item["credit"]).quantize(CENT)
        if expected_balance != item["balance"]:
            raise ValueError(f"Running balance mismatch at Excel row {item['excel_row']}: expected {expected_balance}, got {item['balance']}")
        prev = item["balance"]
    if closing != expected_closing:
        raise ValueError(f"Closing balance mismatch: statement metadata {expected_closing}, extracted {closing}")

    # Confirm the workbook's own summary and review sheet declare successful reconciliation.
    summary_rows = by_name.get("Conversion Summary", {}).get("rows", [])
    if not any(r["values"] and r["values"][0] == "Total transactions extracted" and int(r["values"][1]) == EXPECTED_SOURCE_ROWS for r in summary_rows):
        raise ValueError("Conversion Summary does not confirm 1,495 extracted transactions")
    review = by_name.get("Reconciliation & Review", {}).get("rows", [])
    review_statuses = [str(r["values"][4]) for r in review if len(r["values"]) > 4 and r["values"][0] in {
        "Transaction count", "Opening balance", "Total debits", "Total credits", "Closing balance", "Running-balance sequence", "Extraction exceptions", "Exact duplicate rows"
    }]
    if not review_statuses or any(s != "PASS" for s in review_statuses):
        raise ValueError(f"Workbook reconciliation checks are not all PASS: {review_statuses}")
    return entries, {"opening_balance": amount_text(opening), "closing_balance": amount_text(closing),
                    "debit_total": amount_text(total_debits), "credit_total": amount_text(total_credits)}


def describe_entries(entries: list[dict], totals: dict, db_before: dict, source_hash: str, db_hashes: dict) -> dict:
    counts = Counter((r["transaction_type"], r["category"], r["match_disposition"]) for r in entries)
    by_type = Counter(r["transaction_type"] for r in entries)
    matched_credit = [r for r in entries if r["enterprise_name"] == "Ordinary Savings"]
    matched_debit = [r for r in entries if r["enterprise_name"] == "Ordinary Loan"]
    suspicious = [r for r in entries if r["match_disposition"] in ("ambiguous_member", "no_member_match")]
    return {
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source_file": str(SOURCE), "source_sha256": source_hash,
        "target_database": str(DB), "target_db_fingerprint_before": db_hashes,
        "cooperative_id": COOP, "bank": BANK, "audit_actor": ACTOR,
        "source_sheet": "UBA 2272760240", "source_transactions": len(entries),
        "source_rows_included": [min(r["excel_row"] for r in entries), max(r["excel_row"] for r in entries)],
        "statement_totals": totals, "original_database_counts": db_before,
        "mapping_counts": {"by_type_category_disposition": {" | ".join(k): v for k, v in sorted(counts.items())},
                           "by_transaction_type": dict(by_type), "matched_savings_detail_rows": len(matched_credit),
                           "matched_loan_detail_rows": len(matched_debit), "loan_records_to_create": len(matched_debit),
                           "unmatched_or_ambiguous_suspense_rows": len(suspicious)},
        "append_only_scope": "Insert new remittance rows for every statement transaction; insert one remittance_detail per uniquely matched member transaction; insert a loan record for each uniquely matched debit. No existing records are updated or deleted.",
        "term_and_child_policy": "Imported member-loan detail carries loanData with the statement date and principal, durationMonths=0, no due date, and no charges/guarantors because those values are absent from the statement. No interest/admin/form-fee children or payment advice are invented.",
    }


def write_crosswalk(entries: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "source_sheet", "excel_row", "bank_date", "date_app", "bank_description", "reference",
        "debit", "credit", "signed_amount", "statement_balance", "candidate_count",
        "candidate_members", "member_name", "registration_no", "member_id", "enterprise_name",
        "enterprise_id", "transaction_type", "category", "match_disposition", "rationale",
        "remittance_id", "detail_id", "loan_id", "database_description",
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in entries:
            row = dict(r)
            row.update({"debit": amount_text(r["debit"]), "credit": amount_text(r["credit"]),
                        "signed_amount": amount_text(r["signed_amount"]), "statement_balance": amount_text(r["balance"]),
                        "candidate_count": len(r["candidate_members"]), "candidate_members": r["candidate_labels"],
                        "database_description": r["database_description"]})
            w.writerow(row)


def make_report(entries: list[dict], totals: dict, plan: dict, backup: str | None = None, applied: dict | None = None) -> str:
    by_type = Counter((r["transaction_type"], r["category"]) for r in entries)
    dispositions = Counter(r["match_disposition"] for r in entries)
    matched_sav = [r for r in entries if r["enterprise_name"] == "Ordinary Savings"]
    matched_loan = [r for r in entries if r["enterprise_name"] == "Ordinary Loan"]
    suspense = [r for r in entries if r["category"] == "Suspense"]
    out = [
        "# UBA statement remittance import — 7 November 2026",
        "",
        "## Scope and source verification",
        f"- Source: `{SOURCE}` (sheet `UBA 2272760240`; bank UBA; account ending 0240).",
        f"- Statement period: 1 January–14 October 2026; all {len(entries):,} dated transaction rows are included exactly once.",
        f"- Source statement debits: NGN {totals['debit_total']}; credits: NGN {totals['credit_total']}; opening balance NGN {totals['opening_balance']}; closing balance NGN {totals['closing_balance']}.",
        "- Workbook’s reconciliation and running-balance checks passed; all source dates/amounts were parseable, every row had exactly one non-zero side, and no duplicate source signatures were found.",
        "",
        "## Mapping rules applied",
        "- A positive credit with one unique active exact first/last-name token match is `Member Deposit` / `Member Liability` and has one `Ordinary Savings` detail.",
        "- A negative debit with one unique active exact first/last-name token match is `Member Loan` / `Loan Asset` and has one `Ordinary Loan` detail plus a loan record.",
        "- Explicit bank levies/fees are `Financial & Banking Expenses` / `Finance Expense`; explicit UBA interest credits are `Other Income` / `Other Income`.",
        "- No unique member or supported bank fee/income classification is `Unknown Payments` / `Suspense` with the reserved `0000000000` cooperative ID. Ambiguous identities are not assigned.",
        "- Every new header has bank `UBA`, status `Approved`, signed amount = credit minus debit, and remittance/created/modified timestamps set to the statement date at UTC midnight. Its app comment/description is the statement narration, followed by ` | Ref: <Reference / Transaction ID>` when present.",
        "- For imported ordinary loans, the statement contains no term, guarantor, or fee-selection information. Loan records use duration 0 / no due date, and no interest, admin-fee, form-fee, payment-advice, or other synthetic child transactions are added.",
        "",
        "## Planned / completed counts",
        f"- Existing database remittances before import: {plan['original_database_counts']['remittance']:,}.",
        f"- New statement remittance headers: {len(entries):,}.",
        f"- New member savings details: {len(matched_sav):,}; new ordinary-loan details and loan records: {len(matched_loan):,}.",
        f"- Suspense headers: {len(suspense):,} ({dispositions['no_member_match']:,} no unique member; {dispositions['ambiguous_member']:,} ambiguous member match).",
        "",
        "| Transaction type | Category | Rows |",
        "|---|---|---:|",
    ]
    for (tx, cat), n in sorted(by_type.items()):
        out.append(f"| {tx} | {cat} | {n:,} |")
    if backup:
        out += ["", "## Database safety and verification", f"- Verified pre-import backup: `{backup}`."]
    if applied:
        out += [f"- `PRAGMA integrity_check`: `{applied['integrity_check']}`.",
                f"- Remittances after append: {applied['remittance_count_after']:,}; remittance details: {applied['detail_count_after']:,}; loans: {applied['loan_count_after']:,}.",
                f"- Original remittance/detail/loan content hashes unchanged: `{applied['original_tables_unchanged']}`.",
                f"- All imported row-to-source checks passed: `{applied['every_source_row_represented']}`."]
    else:
        out += ["", "This is the pre-import plan. The database has not been changed yet."]
    out += ["", "The row-level audit crosswalk records every source row, source narration/reference, disposition, target member (if any), target remittance/detail/loan IDs, and the exact database description.", ""]
    return "\n".join(out)


def build_db_rows(entries: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    rems, details, loans = [], [], []
    for r in entries:
        amount = amount_text(r["signed_amount"])
        rem = {
            "id": r["remittance_id"], "cooperative_id": COOP, "member_id": r["member_id"],
            "amount": amount, "bank_name": BANK, "description": r["database_description"],
            "transaction_type": r["transaction_type"], "category": r["category"], "status": "Approved",
            "remittance_date": r["date_app"], "created_by": ACTOR, "created_at": r["date_app"],
            "modified_by": ACTOR, "modified_at": r["date_app"], "is_deleted": "0", "is_synced": "0",
            "sync_at": None, "deleted_at": None, "reconciliation_summary_id": None, "autogen": "0",
            "loan_id": None, "isWithdrawalRequest": "0", "isLoanRequest": "0", "parent_remittance_id": None,
            "withdrawal_form_image": None, "withdrawal_form_images": None, "request_reference": None,
            "request_status_history": None, "requester_bank_details": None, "reviewer_comment": None,
            "rejection_reason": None, "submitted_by_role": None, "approved_by": None, "approved_at": None,
        }
        rems.append(rem)
        if r["member"]:
            ent_name = r["enterprise_name"]
            detail = {
                "id": r["detail_id"], "cooperative_id": COOP, "remittance_id": r["remittance_id"],
                "enterprise_id": r["enterprise_id"], "amount": amount,
                "auto_description": f"{r['transaction_type']} - {ent_name}", "loan_info": None,
                "created_by": ACTOR, "created_at": r["date_app"], "modified_by": ACTOR,
                "modified_at": r["date_app"], "is_synced": "0", "is_deleted": "0",
                "sync_at": None, "deleted_at": None,
            }
            if ent_name == "Ordinary Loan":
                ymd = r["bank_date"]
                loan_info = {
                    "loanData": {
                        "principalAmount": abs(float(r["signed_amount"])),
                        "durationMonths": 0,
                        "issueDate": ymd,
                        "dueDate": "",
                        "status": "Active",
                        "notes": "System Import; statement does not state loan term.",
                    },
                    "charges": [],
                    "guarantors": [],
                }
                detail["loan_info"] = json.dumps(loan_info, ensure_ascii=False, separators=(",", ":"))
                loan = {
                    "id": r["loan_id"], "cooperative_id": COOP, "member_id": r["member_id"],
                    "enterprise_id": r["enterprise_id"], "principal_amount": amount_text(abs(r["signed_amount"])),
                    "issued_date": r["date_app"], "due_date": "", "status": "Active",
                    "notes": "System Import; statement does not state loan term.",
                    "created_at": r["date_app"], "created_by": ACTOR, "modified_at": r["date_app"],
                    "modified_by": ACTOR, "deleted_at": None, "is_synced": "0", "is_deleted": "0",
                    "sync_at": None, "admin_fee_id": None, "duration_months": "0",
                    "remittance_id": r["remittance_id"], "approved_at": None, "monthly_advice_amount": "0",
                }
                loans.append(loan)
            details.append(detail)
    return rems, details, loans


def validate_schema(conn: sqlite3.Connection) -> None:
    for table, need in (("remittance", REMITTANCE_COLUMNS), ("remittance_detail", DETAIL_COLUMNS), ("loans", LOAN_COLUMNS)):
        actual = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
        missing = set(need) - actual
        if missing:
            raise ValueError(f"Database table {table} missing expected columns: {sorted(missing)}")


def apply_import(entries: list[dict], plan: dict, plan_path: Path) -> dict:
    rems, details, loans = build_db_rows(entries)
    current_fingerprint = db_fingerprint(DB)
    if current_fingerprint != plan["target_db_fingerprint_before"]:
        raise ValueError("Target database changed after planning; refusing to import against a different database state")
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = DB.with_name(f"new.db.before-uba-remittance-import-{stamp}.bak")
    if backup.exists():
        raise FileExistsError(f"Backup already exists: {backup}")
    source_hash = sha256(DB)
    src = open_db(DB, readonly=True)
    dst = sqlite3.connect(str(backup), timeout=30)
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()
    if sha256(DB) != source_hash:
        raise ValueError("Database main-file hash changed during backup; import not started")
    check = open_db(backup, readonly=True)
    try:
        backup_integrity = check.execute("PRAGMA integrity_check").fetchone()[0]
        backup_counts = table_counts(check)
    finally:
        check.close()
    if backup_integrity != "ok" or backup_counts != plan["original_database_counts"]:
        raise ValueError("Backup integrity/count verification failed; import not started")

    conn = open_db(DB)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        validate_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        if db_fingerprint(DB) != plan["target_db_fingerprint_before"]:
            raise ValueError("Target database changed before write transaction; refusing import")
        old_hashes = {t: table_hash(conn, t) for t in ("remittance", "remittance_detail", "loans")}
        old_counts = table_counts(conn)
        for table, id_values in (("remittance", [x["id"] for x in rems]),
                                 ("remittance_detail", [x["id"] for x in details]),
                                 ("loans", [x["id"] for x in loans])):
            if id_values:
                placeholders = ",".join("?" for _ in id_values)
                existing = conn.execute(f'SELECT id FROM "{table}" WHERE id IN ({placeholders})', id_values).fetchall()
                if existing:
                    raise ValueError(f"Import ID collision in {table}: {existing[0][0]}")
        for table, columns, rows in (("remittance", REMITTANCE_COLUMNS, rems),
                                     ("remittance_detail", DETAIL_COLUMNS, details),
                                     ("loans", LOAN_COLUMNS, loans)):
            if not rows:
                continue
            sql = f'INSERT INTO "{table}" ({",".join(chr(34)+c+chr(34) for c in columns)}) VALUES ({",".join("?" for _ in columns)})'
            conn.executemany(sql, [tuple(row.get(k) for k in columns) for row in rows])
        if conn.execute("SELECT COUNT(*) FROM remittance").fetchone()[0] != old_counts["remittance"] + len(rems):
            raise ValueError("Remittance row count did not increase by exactly the statement row count")
        if conn.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0] != old_counts["remittance_detail"] + len(details):
            raise ValueError("Detail row count did not increase by exactly the planned child-detail count")
        if conn.execute("SELECT COUNT(*) FROM loans").fetchone()[0] != old_counts["loans"] + len(loans):
            raise ValueError("Loan row count did not increase by exactly the planned loan count")
        for expected in rems:
            got = conn.execute(
                "SELECT cooperative_id,member_id,amount,bank_name,description,transaction_type,category,status,remittance_date,created_at,modified_at "
                "FROM remittance WHERE id=?", (expected["id"],)
            ).fetchone()
            want = tuple(expected[k] for k in ("cooperative_id", "member_id", "amount", "bank_name", "description", "transaction_type", "category", "status", "remittance_date", "created_at", "modified_at"))
            if tuple(got) != want:
                raise ValueError(f"Imported header validation failed: {expected['id']}")
        for detail in details:
            got = conn.execute("SELECT remittance_id,enterprise_id,amount,loan_info FROM remittance_detail WHERE id=?", (detail["id"],)).fetchone()
            want = tuple(detail[k] for k in ("remittance_id", "enterprise_id", "amount", "loan_info"))
            if tuple(got) != want:
                raise ValueError(f"Imported detail validation failed: {detail['id']}")
        for loan in loans:
            got = conn.execute("SELECT member_id,enterprise_id,principal_amount,issued_date,due_date,status,duration_months,remittance_id FROM loans WHERE id=?", (loan["id"],)).fetchone()
            want = tuple(loan[k] for k in ("member_id", "enterprise_id", "principal_amount", "issued_date", "due_date", "status", "duration_months", "remittance_id"))
            if tuple(got) != want:
                raise ValueError(f"Imported loan validation failed: {loan['id']}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    verify = open_db(DB, readonly=True)
    try:
        integrity = verify.execute("PRAGMA integrity_check").fetchone()[0]
        after_counts = table_counts(verify)
        new_hashes = {t: table_hash(verify, t) for t in ("remittance", "remittance_detail", "loans")}
        original_unchanged = True
        for table in ("remittance", "remittance_detail", "loans"):
            old_ids = [r[0] for r in sqlite3.connect(str(backup)).execute(f'SELECT id FROM "{table}" ORDER BY rowid')]
            # Compare original rows byte-for-byte via the restored backup table hash restricted to its existing IDs.
            old_conn = open_db(backup, readonly=True)
            try:
                old_table_hash = table_hash(old_conn, table)
            finally:
                old_conn.close()
            current_original_hash = hashlib.sha256()
            cols = [r[1] for r in verify.execute(f'PRAGMA table_info("{table}")')]
            if old_ids:
                placeholders = ",".join("?" for _ in old_ids)
                q = f'SELECT {",".join(chr(34)+c+chr(34) for c in cols)} FROM "{table}" WHERE id IN ({placeholders}) ORDER BY rowid'
                for row in verify.execute(q, old_ids):
                    current_original_hash.update(json.dumps(tuple(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8")); current_original_hash.update(b"\n")
            if current_original_hash.hexdigest() != old_table_hash:
                original_unchanged = False
        imported = verify.execute("SELECT COUNT(*) FROM remittance WHERE id LIKE ? AND bank_name=?", (IMPORT_TAG + "%", BANK)).fetchone()[0]
        imported_sum = verify.execute("SELECT SUM(CAST(amount AS REAL)) FROM remittance WHERE id LIKE ?", (IMPORT_TAG + "%",)).fetchone()[0]
        if integrity != "ok" or imported != len(entries) or not original_unchanged:
            raise ValueError(f"Post-import validation failed: integrity={integrity}, imported={imported}, originals_unchanged={original_unchanged}")
    finally:
        verify.close()
    # Include the verified backup and post-write counts in a durable import record.
    result = {
        "backup_path": str(backup), "backup_sha256": sha256(backup), "backup_integrity": backup_integrity,
        "integrity_check": integrity, "original_tables_unchanged": original_unchanged,
        "every_source_row_represented": imported == len(entries), "source_rows": len(entries),
        "imported_signed_total_numeric": round(imported_sum or 0, 2),
        "remittance_count_before": old_counts["remittance"], "remittance_count_after": after_counts["remittance"],
        "detail_count_before": old_counts["remittance_detail"], "detail_count_after": after_counts["remittance_detail"],
        "loan_count_before": old_counts["loans"], "loan_count_after": after_counts["loans"],
        "target_db_fingerprint_after": db_fingerprint(DB),
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Append every UBA statement row to OGSC new.db with a traceable row-level crosswalk.")
    parser.add_argument("--apply", action="store_true", help="Back up and append after full source/database validation. Default only writes a plan and crosswalk.")
    args = parser.parse_args()
    if not SOURCE.is_file() or not DB.is_file():
        raise FileNotFoundError(f"Missing source or target: {SOURCE} / {DB}")
    OUT.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(SOURCE)
    before_fp = db_fingerprint(DB)
    conn = open_db(DB, readonly=True)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Target integrity check is not ok: {integrity}")
        validate_schema(conn)
        counts_before = table_counts(conn)
        entries, totals = create_mapping(conn, parse_xlsx(SOURCE))
        table_hashes_before = {t: table_hash(conn, t) for t in ("remittance", "remittance_detail", "loans")}
        ids = {"remittance": {r[0] for r in conn.execute("SELECT id FROM remittance")},
               "remittance_detail": {r[0] for r in conn.execute("SELECT id FROM remittance_detail")},
               "loans": {r[0] for r in conn.execute("SELECT id FROM loans")}}
        for r in entries:
            if r["remittance_id"] in ids["remittance"]:
                raise ValueError(f"Would duplicate existing remittance ID {r['remittance_id']}")
            if r["detail_id"] and r["detail_id"] in ids["remittance_detail"]:
                raise ValueError(f"Would duplicate existing detail ID {r['detail_id']}")
            if r["loan_id"] and r["loan_id"] in ids["loans"]:
                raise ValueError(f"Would duplicate existing loan ID {r['loan_id']}")
            if r["member"]:
                valid_member = conn.execute("SELECT 1 FROM members WHERE id=? AND cooperative_id=? AND is_deleted='0' AND lower(status)='active'", (r["member_id"], COOP)).fetchone()
                if not valid_member:
                    raise ValueError(f"Mapped member is not active in target cooperative: {r['member_id']}")
    finally:
        conn.close()
    if sha256(SOURCE) != source_hash:
        raise ValueError("Source workbook changed during planning")
    plan = describe_entries(entries, totals, counts_before, source_hash, before_fp)
    plan["original_core_table_hashes"] = table_hashes_before
    plan_path = OUT / "import_plan.json"
    crosswalk_path = OUT / "statement_row_crosswalk.csv"
    report_path = OUT / "import_report.md"
    write_crosswalk(entries, crosswalk_path)
    plan_path.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    result = None
    backup_path = None
    if args.apply:
        # Re-read and confirm the saved plan describes the same live pre-import database.
        saved_plan = json.loads(plan_path.read_text(encoding="utf-8"))
        if db_fingerprint(DB) != saved_plan["target_db_fingerprint_before"]:
            raise ValueError("Target changed since the stored plan; re-plan before import")
        result = apply_import(entries, saved_plan, plan_path)
        backup_path = result["backup_path"]
        plan["apply_result"] = result
        plan_path.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    report_path.write_text(make_report(entries, totals, plan, backup_path, result), encoding="utf-8")
    print(json.dumps({
        "mode": "apply" if args.apply else "plan",
        "source_rows": len(entries), "statement_totals": totals,
        "counts": plan["mapping_counts"], "crosswalk": str(crosswalk_path),
        "plan": str(plan_path), "report": str(report_path), "apply_result": result,
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
