from __future__ import annotations
import csv
import datetime as dt
import decimal
import hashlib
import json
import sqlite3
from pathlib import Path

PROJECT = Path(r"C:\Users\User\Documents\OGSC Project")
DB = PROJECT / "new.db"
OUT = PROJECT / "outputs" / "UBA_Remittance_Import_2026-11-07"
CROSSWALK = OUT / "statement_row_crosswalk.csv"
REPORT = OUT / "import_report.md"
PLAN = OUT / "import_plan.json"
AUDIT = OUT / "amount_split_audit.csv"
PREFIX = "OGSC-SiD9mFKs6g-UBAIMP-20261107-R"
CHILD_SUFFIX = "-FEE-SPLIT"
COOP = "OGSC"
BANK = "UBA"
ACTOR = "admin"
PSEUDO_MEMBER = "0000000000"
FEE_AMOUNT = decimal.Decimal("53.75")
THOUSAND = decimal.Decimal("1000.00")
EXPECTED_TOTAL = 117
EXPECTED_LOAN = 52
EXPECTED_SUSPENSE = 65
CENT = decimal.Decimal("0.01")
REMITTANCE_COLUMNS = [
    "id", "cooperative_id", "member_id", "amount", "bank_name", "description", "transaction_type", "category", "status",
    "remittance_date", "created_by", "created_at", "modified_by", "modified_at", "is_deleted", "is_synced", "sync_at", "deleted_at",
    "reconciliation_summary_id", "autogen", "loan_id", "isWithdrawalRequest", "isLoanRequest", "parent_remittance_id",
    "withdrawal_form_image", "withdrawal_form_images", "request_reference", "request_status_history", "requester_bank_details",
    "reviewer_comment", "rejection_reason", "submitted_by_role", "approved_by", "approved_at",
]


def dec(value) -> decimal.Decimal:
    return decimal.Decimal(str(value)).quantize(CENT)


def amt(value: decimal.Decimal) -> str:
    return f"{value.quantize(CENT):.2f}"


def hash_query(conn, query, params=()) -> str:
    h = hashlib.sha256()
    for row in conn.execute(query, params):
        h.update(json.dumps(tuple(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def backup_db() -> Path:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = DB.with_name(f"new.db.before-uba-53-75-split-{stamp}.bak")
    source = sqlite3.connect(DB, timeout=30)
    backup = sqlite3.connect(target)
    try:
        source.backup(backup)
        backup.commit()
    finally:
        backup.close()
        source.close()
    check = sqlite3.connect(target)
    try:
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Backup failed integrity check")
    finally:
        check.close()
    return target


def main() -> None:
    with CROSSWALK.open("r", newline="", encoding="utf-8-sig") as f:
        cross_rows = list(csv.DictReader(f))
        cross_fields = list(cross_rows[0].keys())
    by_id = {r["remittance_id"]: r for r in cross_rows}
    if len(by_id) != len(cross_rows) or len(cross_rows) != 1495:
        raise ValueError("The statement crosswalk must have exactly 1,495 unique remittances")

    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Target database integrity check failed before split")
        all_headers = conn.execute("SELECT * FROM remittance WHERE id LIKE ?", (PREFIX + "%",)).fetchall()
        if len(all_headers) != 1495:
            raise ValueError(f"Expected 1,495 imported headers, found {len(all_headers)}")
        targets = []
        for header in all_headers:
            r = dict(header)
            if r["id"] not in by_id or r["bank_name"] != BANK or r["cooperative_id"] != COOP:
                raise ValueError(f"Imported remittance does not match the statement crosswalk: {r['id']}")
            original = dec(r["amount"])
            if original >= 0:
                continue
            absolute = abs(original)
            base = (absolute // THOUSAND) * THOUSAND
            residual = (absolute - base).quantize(CENT)
            if residual != FEE_AMOUNT:
                continue
            child_id = r["id"] + CHILD_SUFFIX
            if conn.execute("SELECT 1 FROM remittance WHERE id=?", (child_id,)).fetchone():
                raise ValueError(f"Expense child ID already exists: {child_id}")
            details = [dict(x) for x in conn.execute("SELECT * FROM remittance_detail WHERE remittance_id=? AND is_deleted='0'", (r["id"],))]
            loans = [dict(x) for x in conn.execute("SELECT * FROM loans WHERE remittance_id=? AND is_deleted='0'", (r["id"],))]
            children = conn.execute("SELECT id FROM remittance WHERE parent_remittance_id=? AND is_deleted='0'", (r["id"],)).fetchall()
            if children:
                raise ValueError(f"Unexpected existing child remittance on split parent {r['id']}: {children[0]['id']}")
            linked_loan_children = []
            for loan in loans:
                linked_loan_children.extend(conn.execute("SELECT id FROM remittance WHERE loan_id=? AND is_deleted='0'", (loan["id"],)).fetchall())
            if linked_loan_children:
                raise ValueError(f"Unexpected existing child linked to loan {loans[0]['id']}")
            cross = by_id[r["id"]]
            statement_comment = cross["bank_description"].strip() + (f" | Ref: {cross['reference'].strip()}" if cross["reference"].strip() else "")
            if r["description"] != statement_comment:
                raise ValueError(f"Comment/reference mismatch for {r['id']}")
            if r["remittance_date"] != r["created_at"] or r["remittance_date"] != r["modified_at"]:
                raise ValueError(f"Existing date fields do not match for {r['id']}")

            if r["transaction_type"] == "Member Loan":
                if r["category"] != "Loan Asset" or len(details) != 1 or len(loans) != 1:
                    raise ValueError(f"Matched loan structure unexpected for {r['id']}: details={len(details)} loans={len(loans)}")
                d, loan = details[0], loans[0]
                if dec(d["amount"]) != original or dec(loan["principal_amount"]) != absolute:
                    raise ValueError(f"Existing detail/loan principal does not match parent amount for {r['id']}")
                loan_info = json.loads(d["loan_info"] or "{}")
                if dec(loan_info.get("loanData", {}).get("principalAmount")) != absolute:
                    raise ValueError(f"loan_info principal does not match loan record for {r['id']}")
                target_kind = "Member Loan"
            elif r["category"] == "Suspense" and r["transaction_type"] == "Unknown Payments":
                if details or loans:
                    raise ValueError(f"Suspense row unexpectedly has member details/loan for {r['id']}")
                target_kind = "Suspense"
            else:
                raise ValueError(f"Unexpected transaction classification on eligible amount {r['id']}: {r['transaction_type']} / {r['category']}")

            targets.append({
                "parent": r, "before": original, "base": base, "fee": FEE_AMOUNT, "child_id": child_id,
                "details": details, "loans": loans, "kind": target_kind, "comment": statement_comment,
                "crosswalk": cross,
            })

        if len(targets) != EXPECTED_TOTAL:
            raise ValueError(f"Expected {EXPECTED_TOTAL} rows with a NGN 53.75 remainder, found {len(targets)}")
        if sum(x["kind"] == "Member Loan" for x in targets) != EXPECTED_LOAN or sum(x["kind"] == "Suspense" for x in targets) != EXPECTED_SUSPENSE:
            raise ValueError("Eligible-row classification counts changed; refusing to split")
        if sum(bool(x["loans"]) for x in targets) != EXPECTED_LOAN:
            raise ValueError("Expected exactly 52 linked member loans")

        rem_before = hash_query(conn, "SELECT * FROM remittance ORDER BY rowid")
        detail_before = hash_query(conn, "SELECT * FROM remittance_detail ORDER BY rowid")
        loan_before = hash_query(conn, "SELECT * FROM loans ORDER BY rowid")
        counts_before = {
            "remittance": conn.execute("SELECT COUNT(*) FROM remittance").fetchone()[0],
            "details": conn.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0],
            "loans": conn.execute("SELECT COUNT(*) FROM loans").fetchone()[0],
        }
        original_imported_sum = sum((dec(r["amount"]) for r in all_headers), decimal.Decimal("0.00"))
    finally:
        conn.close()

    backup = backup_db()
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        # Revalidate candidate state inside the write transaction.
        for t in targets:
            cur = conn.execute("UPDATE remittance SET amount=? WHERE id=? AND amount=?", (amt(-t["base"]), t["parent"]["id"], t["parent"]["amount"]))
            if cur.rowcount != 1:
                raise ValueError(f"Parent amount changed concurrently: {t['parent']['id']}")
            for d in t["details"]:
                cur = conn.execute("UPDATE remittance_detail SET amount=?,loan_info=? WHERE id=? AND amount=?",
                                   (amt(-t["base"]), _loan_info_with_base(d["loan_info"], t["base"]), d["id"], d["amount"]))
                if cur.rowcount != 1:
                    raise ValueError(f"Loan detail changed concurrently: {d['id']}")
            for loan in t["loans"]:
                cur = conn.execute("UPDATE loans SET principal_amount=? WHERE id=? AND principal_amount=?",
                                   (amt(t["base"]), loan["id"], loan["principal_amount"]))
                if cur.rowcount != 1:
                    raise ValueError(f"Loan record changed concurrently: {loan['id']}")
            p = t["parent"]
            child = {
                "id": t["child_id"], "cooperative_id": COOP, "member_id": PSEUDO_MEMBER,
                "amount": amt(-t["fee"]), "bank_name": BANK, "description": t["comment"],
                "transaction_type": "Financial & Banking Expenses", "category": "Finance Expense",
                "status": p["status"], "remittance_date": p["remittance_date"],
                "created_by": ACTOR, "created_at": p["remittance_date"], "modified_by": ACTOR,
                "modified_at": p["remittance_date"], "is_deleted": "0", "is_synced": "0",
                "sync_at": None, "deleted_at": None, "reconciliation_summary_id": None,
                "autogen": "1", "loan_id": None, "isWithdrawalRequest": "0", "isLoanRequest": "0",
                "parent_remittance_id": p["id"], "withdrawal_form_image": None, "withdrawal_form_images": None,
                "request_reference": None, "request_status_history": None, "requester_bank_details": None,
                "reviewer_comment": None, "rejection_reason": None, "submitted_by_role": None,
                "approved_by": None, "approved_at": None,
            }
            sql = f"INSERT INTO remittance ({','.join(chr(34)+c+chr(34) for c in REMITTANCE_COLUMNS)}) VALUES ({','.join('?' for _ in REMITTANCE_COLUMNS)})"
            conn.execute(sql, tuple(child.get(k) for k in REMITTANCE_COLUMNS))

        # Ensure every statement outflow remains exactly represented by parent + expense child.
        for t in targets:
            rows = conn.execute("SELECT id,amount,transaction_type,category,bank_name,description,status,remittance_date,created_at,modified_at,autogen,parent_remittance_id FROM remittance WHERE id=? OR id=? ORDER BY id",
                                (t["parent"]["id"], t["child_id"])).fetchall()
            if len(rows) != 2:
                raise ValueError(f"Parent/child pair missing for {t['parent']['id']}")
            pair_sum = sum((dec(x["amount"]) for x in rows), decimal.Decimal("0.00"))
            if pair_sum != t["before"]:
                raise ValueError(f"Amount conservation failure for {t['parent']['id']}: {pair_sum} != {t['before']}")
            child = next(x for x in rows if x["id"] == t["child_id"])
            if (dec(child["amount"]) != -FEE_AMOUNT or child["transaction_type"] != "Financial & Banking Expenses"
                    or child["category"] != "Finance Expense" or child["bank_name"] != BANK
                    or child["parent_remittance_id"] != t["parent"]["id"] or child["description"] != t["comment"]):
                raise ValueError(f"Expense child validation failed for {t['child_id']}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    verify = sqlite3.connect(DB, timeout=30)
    verify.row_factory = sqlite3.Row
    try:
        integrity = verify.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Database integrity check failed after split: {integrity}")
        counts_after = {
            "remittance": verify.execute("SELECT COUNT(*) FROM remittance").fetchone()[0],
            "details": verify.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0],
            "loans": verify.execute("SELECT COUNT(*) FROM loans").fetchone()[0],
        }
        if counts_after != {"remittance": counts_before["remittance"] + EXPECTED_TOTAL, "details": counts_before["details"], "loans": counts_before["loans"]}:
            raise ValueError(f"Unexpected table count changes: {counts_before} -> {counts_after}")
        new_imported_sum = sum((dec(r[0]) for r in verify.execute("SELECT amount FROM remittance WHERE id LIKE ?", (PREFIX + "%",))), decimal.Decimal("0.00"))
        if new_imported_sum != original_imported_sum:
            raise ValueError(f"Imported net amount changed: {original_imported_sum} -> {new_imported_sum}")
        # Original rows outside the intended parent/loan/detail records stay identical.
        parent_ids = [x["parent"]["id"] for x in targets]
        parent_marks = ",".join("?" for _ in parent_ids)
        child_marks = ",".join("?" for _ in targets)
        child_ids = [x["child_id"] for x in targets]
        rem_after_unaffected = hash_query(verify, f"SELECT * FROM remittance WHERE id NOT IN ({parent_marks}) AND id NOT IN ({child_marks}) ORDER BY rowid", parent_ids + child_ids)
        old = sqlite3.connect(backup)
        try:
            rem_before_unaffected = hash_query(old, f"SELECT * FROM remittance WHERE id NOT IN ({parent_marks}) ORDER BY rowid", parent_ids)
            changed_details = [d["id"] for t in targets for d in t["details"]]
            changed_loans = [l["id"] for t in targets for l in t["loans"]]
            if changed_details:
                marks = ",".join("?" for _ in changed_details)
                detail_after_unaffected = hash_query(verify, f"SELECT * FROM remittance_detail WHERE id NOT IN ({marks}) ORDER BY rowid", changed_details)
                detail_before_unaffected = hash_query(old, f"SELECT * FROM remittance_detail WHERE id NOT IN ({marks}) ORDER BY rowid", changed_details)
            else:
                detail_after_unaffected = hash_query(verify, "SELECT * FROM remittance_detail ORDER BY rowid")
                detail_before_unaffected = hash_query(old, "SELECT * FROM remittance_detail ORDER BY rowid")
            if changed_loans:
                marks = ",".join("?" for _ in changed_loans)
                loan_after_unaffected = hash_query(verify, f"SELECT * FROM loans WHERE id NOT IN ({marks}) ORDER BY rowid", changed_loans)
                loan_before_unaffected = hash_query(old, f"SELECT * FROM loans WHERE id NOT IN ({marks}) ORDER BY rowid", changed_loans)
            else:
                loan_after_unaffected = hash_query(verify, "SELECT * FROM loans ORDER BY rowid")
                loan_before_unaffected = hash_query(old, "SELECT * FROM loans ORDER BY rowid")
        finally:
            old.close()
        if rem_after_unaffected != rem_before_unaffected or detail_after_unaffected != detail_before_unaffected or loan_after_unaffected != loan_before_unaffected:
            raise ValueError("A non-target database row changed unexpectedly")
        for t in targets:
            parent = verify.execute("SELECT amount FROM remittance WHERE id=?", (t["parent"]["id"],)).fetchone()
            if dec(parent[0]) != -t["base"]:
                raise ValueError(f"Parent validation failed: {t['parent']['id']}")
            for d in t["details"]:
                row = verify.execute("SELECT amount,loan_info FROM remittance_detail WHERE id=?", (d["id"],)).fetchone()
                if dec(row["amount"]) != -t["base"] or dec(json.loads(row["loan_info"])["loanData"]["principalAmount"]) != t["base"]:
                    raise ValueError(f"Updated loan detail validation failed: {d['id']}")
            for loan in t["loans"]:
                row = verify.execute("SELECT principal_amount FROM loans WHERE id=?", (loan["id"],)).fetchone()
                if dec(row[0]) != t["base"]:
                    raise ValueError(f"Updated loan principal validation failed: {loan['id']}")
    finally:
        verify.close()

    # Row-level audit file preserves source amounts and records the approved split.
    audit_fields = ["source_excel_row", "parent_remittance_id", "source_description", "reference", "prior_signed_amount",
                    "parent_amount_after", "expense_amount", "expense_child_id", "classification", "loan_detail_id",
                    "loan_record_id", "loan_principal_after"]
    audit_rows = []
    split_ids = {x["parent"]["id"]: x for x in targets}
    for t in sorted(targets, key=lambda x: x["parent"]["id"]):
        x = t["crosswalk"]
        audit_rows.append({
            "source_excel_row": x["excel_row"], "parent_remittance_id": t["parent"]["id"],
            "source_description": x["bank_description"], "reference": x["reference"],
            "prior_signed_amount": amt(t["before"]), "parent_amount_after": amt(-t["base"]),
            "expense_amount": amt(-t["fee"]), "expense_child_id": t["child_id"],
            "classification": t["kind"], "loan_detail_id": t["details"][0]["id"] if t["details"] else "",
            "loan_record_id": t["loans"][0]["id"] if t["loans"] else "",
            "loan_principal_after": amt(t["base"]) if t["loans"] else "",
        })
    with AUDIT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=audit_fields)
        w.writeheader(); w.writerows(audit_rows)

    # Extend the original crosswalk while keeping source statement amount columns unchanged.
    extra_fields = ["split_parent_amount_after", "split_expense_amount", "split_expense_child_id", "loan_principal_after"]
    for field in extra_fields:
        if field not in cross_fields:
            cross_fields.append(field)
    for x in cross_rows:
        t = split_ids.get(x["remittance_id"])
        x.update({field: "" for field in extra_fields})
        if t:
            x["split_parent_amount_after"] = amt(-t["base"])
            x["split_expense_amount"] = amt(-t["fee"])
            x["split_expense_child_id"] = t["child_id"]
            x["loan_principal_after"] = amt(t["base"]) if t["loans"] else ""
    with CROSSWALK.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cross_fields, extrasaction="ignore")
        w.writeheader(); w.writerows(cross_rows)

    total_split = FEE_AMOUNT * EXPECTED_TOTAL
    split_meta = {
        "applied_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "rule": "For each imported negative amount whose absolute value is an integer multiple of NGN 1,000 plus exactly NGN 53.75, reduce the parent by NGN 53.75 and create a linked negative Financial & Banking Expenses / Finance Expense child for NGN 53.75.",
        "rows_split": EXPECTED_TOTAL, "matched_member_loans": EXPECTED_LOAN, "suspense_rows": EXPECTED_SUSPENSE,
        "expense_children_created": EXPECTED_TOTAL, "expense_component_per_row": "-53.75",
        "total_expense_component": amt(-total_split), "total_net_change": "0.00",
        "loan_details_and_records_updated": EXPECTED_LOAN, "target_database_backup": str(backup),
        "backup_sha256": hashlib.sha256(backup.read_bytes()).hexdigest(), "integrity_check": integrity,
        "remittance_count_before": counts_before["remittance"], "remittance_count_after": counts_after["remittance"],
        "detail_count_before": counts_before["details"], "detail_count_after": counts_after["details"],
        "loan_count_before": counts_before["loans"], "loan_count_after": counts_after["loans"],
        "imported_total_before": amt(original_imported_sum), "imported_total_after": amt(new_imported_sum),
        "all_amounts_conserved": True, "non_target_rows_unchanged": True,
    }
    if PLAN.exists():
        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        plan["53_75_amount_split"] = split_meta
        PLAN.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    report = REPORT.read_text(encoding="utf-8")
    section = (
        "\n\n## NGN 53.75 amount split\n"
        "- Applied to all 117 imported negative rows with an absolute amount equal to a whole multiple of NGN 1,000 plus NGN 53.75: 52 matched Member Loan rows and 65 Suspense rows.\n"
        "- Each parent amount was reduced by NGN 53.75; each now has a linked `Financial & Banking Expenses` / `Finance Expense` child remittance for −NGN 53.75, dated to the statement date and carrying the statement narration/reference.\n"
        "- All 52 linked Ordinary Loan detail amounts, loan_info principal amounts, and loan-record principal amounts now reflect the reduced parent principal. Suspense parent classifications remain Suspense.\n"
        f"- Total split into expense children: NGN {amt(total_split)}. The combined parent-plus-child amount remains unchanged for every source entry; imported net total before and after: NGN {amt(original_imported_sum)}.\n"
        f"- Pre-split database backup: `{backup}`. `PRAGMA integrity_check`: `{integrity}`. New remittances: {counts_before['remittance']:,} → {counts_after['remittance']:,}; detail and loan counts unchanged at {counts_after['details']:,} and {counts_after['loans']:,}.\n"
        "- Row-level splits: `amount_split_audit.csv`; crosswalk includes the post-split parent and expense-child amounts/IDs.\n"
    )
    marker = "## NGN 53.75 amount split"
    report = report.split(marker)[0].rstrip() + section if marker in report else report.rstrip() + section
    REPORT.write_text(report, encoding="utf-8")

    print(json.dumps({
        "rows_split": EXPECTED_TOTAL, "matched_loans": EXPECTED_LOAN, "suspense": EXPECTED_SUSPENSE,
        "expense_children": EXPECTED_TOTAL, "fee_component_total": amt(total_split),
        "total_before": amt(original_imported_sum), "total_after": amt(new_imported_sum),
        "database_counts_after": counts_after, "integrity": integrity, "backup": str(backup),
        "audit_csv": str(AUDIT), "crosswalk": str(CROSSWALK), "report": str(REPORT),
    }, indent=2, ensure_ascii=False))


def _loan_info_with_base(raw: str, principal: decimal.Decimal) -> str:
    obj = json.loads(raw or "{}")
    if not isinstance(obj.get("loanData"), dict):
        raise ValueError("Loan detail missing loanData")
    obj["loanData"]["principalAmount"] = float(principal)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
