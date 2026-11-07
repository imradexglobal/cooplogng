from __future__ import annotations
import csv
import datetime as dt
import hashlib
import json
import sqlite3
from pathlib import Path

PROJECT = Path(r"C:\Users\User\Documents\OGSC Project")
DB = PROJECT / "new.db"
OUT = PROJECT / "outputs" / "UBA_Remittance_Import_2026-11-07"
AUDIT = OUT / "amount_split_audit.csv"
CROSSWALK = OUT / "statement_row_crosswalk.csv"
REPORT = OUT / "import_report.md"
PLAN = OUT / "import_plan.json"
EXPECTED = 117


def row_hash(conn, query, params=()):
    h = hashlib.sha256()
    for row in conn.execute(query, params):
        h.update(json.dumps(tuple(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def main():
    with AUDIT.open("r", newline="", encoding="utf-8-sig") as f:
        audit_rows = list(csv.DictReader(f))
        audit_fields = list(audit_rows[0].keys())
    if len(audit_rows) != EXPECTED or "expense_child_id" not in audit_fields:
        raise ValueError("Expected the 117-row split audit with expense_child_id")
    expense_ids = [r["expense_child_id"] for r in audit_rows]
    if len(set(expense_ids)) != EXPECTED:
        raise ValueError("Expense remittance IDs are not unique")

    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Database integrity check failed before detaching")
        rows = []
        for audit in audit_rows:
            r = conn.execute("SELECT * FROM remittance WHERE id=?", (audit["expense_child_id"],)).fetchone()
            if not r:
                raise ValueError(f"Expense remittance is missing: {audit['expense_child_id']}")
            if (r["amount"] != "-53.75" or r["transaction_type"] != "Financial & Banking Expenses"
                    or r["category"] != "Finance Expense" or r["bank_name"] != "UBA"
                    or r["autogen"] != "1" or r["parent_remittance_id"] != audit["parent_remittance_id"]
                    or r["loan_id"] is not None):
                raise ValueError(f"Expense row is not in expected linked-child state: {r['id']}")
            rows.append(dict(r))
        ids_marks = ",".join("?" for _ in expense_ids)
        before_hash = row_hash(conn, f"SELECT * FROM remittance WHERE id IN ({ids_marks}) ORDER BY id", expense_ids)
        preserved_cols = [r[1] for r in conn.execute("PRAGMA table_info(remittance)") if r[1] not in {"autogen", "parent_remittance_id"}]
        preserved_select = ",".join('"' + name + '"' for name in preserved_cols)
        before_preserved_hash = row_hash(conn, f"SELECT {preserved_select} FROM remittance WHERE id IN ({ids_marks}) ORDER BY id", expense_ids)
        outside_hash = row_hash(conn, f"SELECT * FROM remittance WHERE id NOT IN ({ids_marks}) ORDER BY rowid", expense_ids)
        counts_before = {
            "remittance": conn.execute("SELECT COUNT(*) FROM remittance").fetchone()[0],
            "detail": conn.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0],
            "loans": conn.execute("SELECT COUNT(*) FROM loans").fetchone()[0],
        }
        fee_total_before = sum((__import__("decimal").Decimal(r["amount"]) for r in rows), __import__("decimal").Decimal("0.00"))
    finally:
        conn.close()

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = DB.with_name(f"new.db.before-standalone-uba-fees-{stamp}.bak")
    source = sqlite3.connect(DB, timeout=30)
    target = sqlite3.connect(backup_path)
    try:
        source.backup(target)
        target.commit()
    finally:
        target.close()
        source.close()
    check = sqlite3.connect(backup_path)
    try:
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Pre-detachment backup integrity check failed")
    finally:
        check.close()

    conn = sqlite3.connect(DB, timeout=30)
    try:
        conn.execute("BEGIN IMMEDIATE")
        for rid, parent_id in zip(expense_ids, [r["parent_remittance_id"] for r in audit_rows]):
            cur = conn.execute(
                "UPDATE remittance SET autogen='0', parent_remittance_id=NULL "
                "WHERE id=? AND amount='-53.75' AND transaction_type='Financial & Banking Expenses' "
                "AND category='Finance Expense' AND autogen='1' AND parent_remittance_id=? AND loan_id IS NULL",
                (rid, parent_id),
            )
            if cur.rowcount != 1:
                raise ValueError(f"Failed exact standalone update for {rid}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Post-detachment integrity check failed: {integrity}")
        after = conn.execute(f"SELECT * FROM remittance WHERE id IN ({ids_marks}) ORDER BY id", expense_ids).fetchall()
        if len(after) != EXPECTED:
            raise ValueError(f"Expected {EXPECTED} standalone expenses after update, found {len(after)}")
        if any(r["amount"] != "-53.75" or r["autogen"] != "0" or r["parent_remittance_id"] is not None
               or r["loan_id"] is not None or r["bank_name"] != "UBA"
               or r["transaction_type"] != "Financial & Banking Expenses" or r["category"] != "Finance Expense"
               or r["created_at"] != r["remittance_date"] or r["modified_at"] != r["remittance_date"] for r in after):
            raise ValueError("At least one expense remittance did not validate as a standalone row")
        outside_after = row_hash(conn, f"SELECT * FROM remittance WHERE id NOT IN ({ids_marks}) ORDER BY rowid", expense_ids)
        if outside_after != outside_hash:
            raise ValueError("Rows other than the 117 expense remittances changed")
        after_preserved_hash = row_hash(conn, f"SELECT {preserved_select} FROM remittance WHERE id IN ({ids_marks}) ORDER BY id", expense_ids)
        if after_preserved_hash != before_preserved_hash:
            raise ValueError("A standalone expense field other than autogen/parent linkage changed")
        if row_hash(conn, f"SELECT * FROM remittance WHERE id IN ({ids_marks}) ORDER BY id", expense_ids) == before_hash:
            raise ValueError("Expected the autogen/parent linkage flags to change")
        counts_after = {
            "remittance": conn.execute("SELECT COUNT(*) FROM remittance").fetchone()[0],
            "detail": conn.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0],
            "loans": conn.execute("SELECT COUNT(*) FROM loans").fetchone()[0],
        }
        if counts_after != counts_before:
            raise ValueError(f"Table counts changed unexpectedly: {counts_before} -> {counts_after}")
        fee_total_after = sum((__import__("decimal").Decimal(r["amount"]) for r in after), __import__("decimal").Decimal("0.00"))
        if fee_total_after != fee_total_before:
            raise ValueError("Expense total changed while detaching")
    finally:
        conn.close()

    # Update row-level audit headers and values; the IDs remain the same standalone remittances.
    audit_rows = [{("expense_remittance_id" if k == "expense_child_id" else "source_parent_remittance_id" if k == "parent_remittance_id" else k): v for k, v in r.items()} for r in audit_rows]
    audit_fields = ["expense_remittance_id" if k == "expense_child_id" else "source_parent_remittance_id" if k == "parent_remittance_id" else k for k in audit_fields]
    audit_fields += ["standalone", "autogen", "database_parent_remittance_id"]
    for r in audit_rows:
        r["standalone"] = "true"
        r["autogen"] = "0"
        r["database_parent_remittance_id"] = ""
    with AUDIT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=audit_fields, extrasaction="ignore")
        w.writeheader(); w.writerows(audit_rows)

    with CROSSWALK.open("r", newline="", encoding="utf-8-sig") as f:
        cross_rows = list(csv.DictReader(f)); cross_fields = list(cross_rows[0].keys())
    if "split_expense_child_id" in cross_fields:
        cross_fields[cross_fields.index("split_expense_child_id")] = "split_expense_remittance_id"
        for r in cross_rows:
            r["split_expense_remittance_id"] = r.pop("split_expense_child_id", "")
    for field in ("split_expense_standalone", "split_expense_autogen", "split_expense_parent_remittance_id"):
        if field not in cross_fields:
            cross_fields.append(field)
    for r in cross_rows:
        expense_id = r.get("split_expense_remittance_id", "")
        if expense_id:
            r["split_expense_standalone"] = "true"
            r["split_expense_autogen"] = "0"
            r["split_expense_parent_remittance_id"] = ""
        else:
            r["split_expense_standalone"] = ""
            r["split_expense_autogen"] = ""
            r["split_expense_parent_remittance_id"] = ""
    with CROSSWALK.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cross_fields, extrasaction="ignore")
        w.writeheader(); w.writerows(cross_rows)

    result = {
        "corrected_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "standalone_expense_remittances": EXPECTED,
        "autogen_flag": "0", "parent_remittance_id": None, "loan_id": None,
        "expense_amount_each": "-53.75", "combined_amounts_unchanged": True,
        "expense_total": str(fee_total_after), "integrity_check": integrity,
        "non_fee_remittance_rows_unchanged": True, "table_counts_unchanged": True,
        "pre_detachment_backup": str(backup_path),
        "backup_sha256": hashlib.sha256(backup_path.read_bytes()).hexdigest(),
        "remittance_count": counts_after["remittance"], "detail_count": counts_after["detail"], "loan_count": counts_after["loans"],
    }
    if PLAN.exists():
        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        split = plan.get("53_75_amount_split", {})
        split["rule"] = "For each imported negative amount whose absolute value is an integer multiple of NGN 1,000 plus NGN 53.75, reduce the source remittance by NGN 53.75 and record that amount in a separate standalone negative Financial & Banking Expenses / Finance Expense remittance."
        split["expense_children_created"] = 0
        split["expense_standalone_remittances"] = EXPECTED
        split["expense_remittances_standalone"] = True
        plan["53_75_amount_split"] = split
        plan["53_75_standalone_correction"] = result
        PLAN.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")

    report = REPORT.read_text(encoding="utf-8")
    report = report.replace(
        "Each parent amount was reduced by NGN 53.75; each now has a linked `Financial & Banking Expenses` / `Finance Expense` child remittance for −NGN 53.75, dated to the statement date and carrying the statement narration/reference.",
        "Each original parent amount was reduced by NGN 53.75; the matching −NGN 53.75 `Financial & Banking Expenses` / `Finance Expense` remittance stands alone (it is not a child), with no parent/loan link, and carries the statement date and narration/reference.",
    ).replace("Total split into expense children:", "Total split into standalone expense remittances:")
    report = report.replace(
        "Row-level splits: `amount_split_audit.csv`; crosswalk includes the post-split parent and expense-child amounts/IDs.",
        "Row-level splits: `amount_split_audit.csv`; crosswalk includes the reduced parent amounts and standalone expense-remittance IDs.",
    )
    marker = "## NGN 53.75 standalone-remittance correction"
    section = (
        "\n\n## NGN 53.75 standalone-remittance correction\n"
        f"- Detached all {EXPECTED} expense remittances: `autogen=0`, `parent_remittance_id=NULL`, and `loan_id=NULL`. Each remains its own −NGN 53.75 finance-expense transaction; amounts, date, statement comment/reference, and status were preserved.\n"
        f"- Pre-detachment backup: `{backup_path}`. Integrity check: `{integrity}`; other remittance rows unchanged: `True`; remittance/detail/loan counts unchanged at {counts_after['remittance']:,}/{counts_after['detail']:,}/{counts_after['loans']:,}.\n"
    )
    report = report.split(marker)[0].rstrip() + section if marker in report else report.rstrip() + section
    REPORT.write_text(report, encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
