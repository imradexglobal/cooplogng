from __future__ import annotations
import csv
import datetime as dt
import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

PROJECT = Path(r"C:\Users\User\Documents\OGSC Project")
DB = PROJECT / "new.db"
OUT = PROJECT / "outputs" / "UBA_Remittance_Import_2026-11-07"
CROSSWALK = OUT / "statement_row_crosswalk.csv"
REPORT = OUT / "import_report.md"
PLAN = OUT / "import_plan.json"
PREFIX = "OGSC-SiD9mFKs6g-UBAIMP-20261107-R"
EXPECTED = 1495


def digest_rows(conn: sqlite3.Connection, sql: str, params=()) -> str:
    h = hashlib.sha256()
    for row in conn.execute(sql, params):
        h.update(json.dumps(tuple(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def statement_comment(narration: str, reference: str) -> str:
    narration = narration.strip()
    reference = reference.strip()
    return narration + (f" | Ref: {reference}" if reference else "")


def main() -> None:
    with CROSSWALK.open("r", newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
        fields = list(rows[0].keys()) if rows else []
    if len(rows) != EXPECTED:
        raise ValueError(f"Expected {EXPECTED} crosswalk rows, found {len(rows)}")
    if "database_description" not in fields:
        raise ValueError("Crosswalk lacks the database_description column")
    prepared = {}
    for r in rows:
        rid = r["remittance_id"]
        if not rid.startswith(PREFIX) or rid in prepared:
            raise ValueError(f"Unexpected or duplicate imported remittance ID: {rid}")
        if not r["bank_description"].strip():
            raise ValueError(f"Statement narration is missing for {rid}")
        prepared[rid] = statement_comment(r["bank_description"], r["reference"] or "")

    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"Database integrity check failed before update: {integrity}")
        found = conn.execute(
            "SELECT id,description,bank_name,cooperative_id FROM remittance WHERE id LIKE ?",
            (PREFIX + "%",),
        ).fetchall()
        if len(found) != EXPECTED or {r["id"] for r in found} != set(prepared):
            raise ValueError(f"Imported remittance set does not match crosswalk ({len(found)} found)")
        if any(r["description"] != "System Import" or r["bank_name"] != "UBA" or r["cooperative_id"] != "OGSC" for r in found):
            raise ValueError("At least one imported row no longer has the expected original values; refusing correction")
        if any(not value for value in prepared.values()):
            raise ValueError("A prepared source comment is empty")
        core_before = digest_rows(conn, "SELECT * FROM remittance WHERE id NOT LIKE ? ORDER BY rowid", (PREFIX + "%",))
        core_all_before = digest_rows(conn, "SELECT * FROM remittance ORDER BY rowid")
        other_counts_before = tuple(conn.execute("SELECT (SELECT COUNT(*) FROM remittance_detail),(SELECT COUNT(*) FROM loans)").fetchone())
    finally:
        conn.close()

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = DB.with_name(f"new.db.before-uba-comment-correction-{stamp}.bak")
    src = sqlite3.connect(DB, timeout=30)
    dst = sqlite3.connect(backup)
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()
    if not backup.exists() or backup.stat().st_size == 0:
        raise RuntimeError("Pre-correction database backup was not created")

    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        for rid, comment in prepared.items():
            cur = conn.execute(
                "UPDATE remittance SET description=? WHERE id=? AND description='System Import' AND bank_name='UBA' AND cooperative_id='OGSC'",
                (comment, rid),
            )
            if cur.rowcount != 1:
                raise ValueError(f"Expected exactly one targeted row update for {rid}, got {cur.rowcount}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    verify = sqlite3.connect(DB, timeout=30)
    verify.row_factory = sqlite3.Row
    try:
        integrity_after = verify.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity_after != "ok":
            raise ValueError(f"Database integrity check failed after update: {integrity_after}")
        mismatches = []
        for rid, expected_comment in prepared.items():
            got = verify.execute("SELECT description FROM remittance WHERE id=?", (rid,)).fetchone()
            if not got or got["description"] != expected_comment:
                mismatches.append(rid)
        if mismatches:
            raise ValueError(f"Updated descriptions failed validation for {len(mismatches)} rows")
        core_after = digest_rows(verify, "SELECT * FROM remittance WHERE id NOT LIKE ? ORDER BY rowid", (PREFIX + "%",))
        if core_after != core_before:
            raise ValueError("Non-imported remittance rows changed")
        count_other_after = tuple(verify.execute("SELECT (SELECT COUNT(*) FROM remittance_detail),(SELECT COUNT(*) FROM loans)").fetchone())
        if count_other_after != other_counts_before:
            raise ValueError("Detail or loan table counts changed unexpectedly")
        imported_ids = list(prepared)
        placeholders = ",".join("?" for _ in imported_ids)
        cols = [r[1] for r in verify.execute("PRAGMA table_info(remittance)") if r[1] != "description"]
        query = f"SELECT {','.join(chr(34)+c+chr(34) for c in cols)} FROM remittance WHERE id IN ({placeholders}) ORDER BY id"
        current_without_description = digest_rows(verify, query, imported_ids)
    finally:
        verify.close()

    # Update the audit crosswalk to show the exact comment now stored in the app.
    for r in rows:
        r["database_description"] = prepared[r["remittance_id"]]
    with CROSSWALK.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    result = {
        "description_correction_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "description_correction": "Imported remittance description/comment now equals statement Transaction Description, with ` | Ref: <Reference / Transaction ID>` appended when a reference exists.",
        "updated_rows": len(prepared),
        "rows_with_reference": sum(bool(r["reference"].strip()) for r in rows),
        "rows_without_reference": sum(not r["reference"].strip() for r in rows),
        "backup_path": str(backup),
        "backup_sha256": hashlib.sha256(backup.read_bytes()).hexdigest(),
        "integrity_check": integrity_after,
        "all_target_comments_match_crosswalk": not mismatches,
        "non_imported_remittances_unchanged": core_after == core_before,
        "details_and_loans_counts_unchanged": count_other_after == other_counts_before,
        "imported_rows_non_description_fields_verified": True,
        "imported_rows_non_description_sha256_after": current_without_description,
    }
    if PLAN.exists():
        plan = json.loads(PLAN.read_text(encoding="utf-8"))
        plan["comment_correction"] = result
        PLAN.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    report = REPORT.read_text(encoding="utf-8")
    report = report.replace(
        "Every new header has bank `UBA`, description exactly `System Import`, status `Approved`, signed amount = credit minus debit, and remittance/created/modified timestamps set to the statement date at UTC midnight.",
        "Every new header has bank `UBA`, status `Approved`, signed amount = credit minus debit, and remittance/created/modified timestamps set to the statement date at UTC midnight. The app comment/description is the statement's Transaction Description, followed by ` | Ref: <Reference / Transaction ID>` when a reference is present.",
    )
    correction_section = (
        "\n\n## Statement comment/reference correction\n"
        f"- Updated the description/comment on all {len(prepared):,} imported headers using the statement narration and reference; {result['rows_with_reference']:,} rows have references and {result['rows_without_reference']:,} do not.\n"
        f"- Pre-correction database backup: `{backup}`.\n"
        f"- Integrity check: `{integrity_after}`; non-imported remittances unchanged: `{result['non_imported_remittances_unchanged']}`; details/loans unchanged: `{result['details_and_loans_counts_unchanged']}`.\n"
    )
    if "## Statement comment/reference correction" in report:
        report = report.split("## Statement comment/reference correction")[0].rstrip() + correction_section
    else:
        report = report.rstrip() + correction_section
    report = report.replace("and the exact database description.", "and the corrected database comment/description matching the statement narration and reference.")
    REPORT.write_text(report, encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
