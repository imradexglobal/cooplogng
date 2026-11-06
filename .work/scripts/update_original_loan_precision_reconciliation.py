import csv
import hashlib
import shutil
import sqlite3
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

SOURCE = Path(r"C:\Users\User\Downloads\cooperative_backup_2026-11-06T13-24.db")
BACKUP = Path(r"C:\Users\User\Downloads\cooperative_backup_2026-11-06T13-24_PRE_RECONCILIATION.db")
VERIFIED_COPY = Path(r"C:\Users\User\Documents\GitHub\cooplogng\outputs\loan-balance-reconciliation-2026-11-06\cooperative_backup_2026-11-06_RECONCILED_READY_2026-11-06.db")
PREVIEW = Path(r"C:\Users\User\Documents\GitHub\cooplogng\outputs\loan-balance-reconciliation-2026-11-06\proposed-remittances.csv")
REPORT = Path(r"C:\Users\User\Documents\GitHub\cooplogng\outputs\loan-balance-reconciliation-2026-11-06\original-db-update-report.md")
EXPECTED_SOURCE_SHA256 = "fb7f5902d93ef30bed415e911334ffa0e7319391ce828d5858efc809180d18e4"
EXPECTED_VERIFIED_SHA256 = "aa7ca71ce08201501a2d37704f069d568188ca8e6956d9fbd9aae1cd34204982"
DESCRIPTION = "Loan balance precision reconciliation — Ordinary Savings offset"
COOP_ID = "TMSA"


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def decimal(value):
    return Decimal(str(value if value is not None else "0"))


def quote_ident(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def rows_as_dicts(connection, table, where, params):
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(f"SELECT * FROM {quote_ident(table)} WHERE {where}", params)]


def table_columns(connection, table):
    return [row[1] for row in connection.execute(f"PRAGMA table_info({quote_ident(table)})")]


def insert_rows(connection, table, rows):
    if not rows:
        return
    columns = table_columns(connection, table)
    marks = ",".join("?" for _ in columns)
    sql = f"INSERT INTO {quote_ident(table)} ({','.join(quote_ident(c) for c in columns)}) VALUES ({marks})"
    for row in rows:
        if set(row) != set(columns):
            missing, extra = set(columns) - set(row), set(row) - set(columns)
            raise RuntimeError(f"Schema mismatch in {table}: missing={missing}, extra={extra}")
        connection.execute(sql, [row[c] for c in columns])


def ledger_balances(connection):
    connection.row_factory = sqlite3.Row
    balances = defaultdict(Decimal)
    sql = """SELECT r.member_id,d.enterprise_id,d.amount
             FROM remittance_detail d JOIN remittance r ON r.id=d.remittance_id
             WHERE lower(coalesce(r.status,''))='approved'
               AND lower(coalesce(r.is_deleted,'0')) NOT IN ('1','true')
               AND lower(coalesce(d.is_deleted,'0')) NOT IN ('1','true')"""
    for row in connection.execute(sql):
        balances[str(row["member_id"]), str(row["enterprise_id"])] += decimal(row["amount"])
    return balances


def main():
    for path in (SOURCE, VERIFIED_COPY, PREVIEW):
        if not path.is_file():
            raise FileNotFoundError(path)
    if BACKUP.exists():
        raise FileExistsError(f"Refusing to overwrite existing safety backup: {BACKUP}")
    if REPORT.exists():
        raise FileExistsError(f"Refusing to overwrite existing report: {REPORT}")
    if sha(SOURCE) != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("The original DB no longer matches the reviewed backup; no changes made.")
    if sha(VERIFIED_COPY) != EXPECTED_VERIFIED_SHA256:
        raise RuntimeError("The verified reconciliation copy checksum changed; no changes made.")

    with PREVIEW.open("r", newline="", encoding="utf-8-sig") as stream:
        preview = list(csv.DictReader(stream))
    ready = [r for r in preview if r["review_status"] == "READY"]
    held = [r for r in preview if r["review_status"] == "HOLD"]
    if len(preview) != 320 or len(ready) != 314 or len(held) != 6:
        raise RuntimeError("Preview counts differ from the reviewed scope; no changes made.")

    # Verify the ready/hold balances before changing the original.
    original_read = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    original_read.execute("PRAGMA query_only=ON")
    if original_read.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("Original DB integrity check failed; no changes made.")
    before_balances = ledger_balances(original_read)
    original_rows = rows_as_dicts(original_read, "remittance", "description=?", (DESCRIPTION,))
    if original_rows:
        raise RuntimeError("Matching reconciliation entries already exist in the original; no changes made.")
    original_read.close()

    verified = sqlite3.connect(f"file:{VERIFIED_COPY}?mode=ro", uri=True)
    verified.execute("PRAGMA query_only=ON")
    if verified.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("Verified DB integrity check failed; no changes made.")
    source_coop = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    source_coop.row_factory = sqlite3.Row
    source_name = source_coop.execute("SELECT full_name FROM cooperatives WHERE id=?", (COOP_ID,)).fetchone()
    source_coop.close()
    if not source_name or source_name[0] != "The Muslim Stars Association":
        raise RuntimeError("The original cooperative identity differs from the reviewed source.")

    headers = rows_as_dicts(verified, "remittance", "cooperative_id=? AND description=?", (COOP_ID, DESCRIPTION))
    if len(headers) != 314:
        raise RuntimeError(f"Verified DB has {len(headers)} correction headers, expected 314.")
    header_ids = {str(h["id"]) for h in headers}
    details = rows_as_dicts(verified, "remittance_detail", "cooperative_id=? AND remittance_id IN (SELECT id FROM remittance WHERE cooperative_id=? AND description=?)", (COOP_ID, COOP_ID, DESCRIPTION))
    queue = rows_as_dicts(verified, "sync_queue", "cooperative_id=? AND collection_name='remittance' AND document_id IN (SELECT id FROM remittance WHERE cooperative_id=? AND description=?)", (COOP_ID, COOP_ID, DESCRIPTION))
    if len(details) != 628 or len(queue) != 314:
        raise RuntimeError(f"Verified entries have wrong child/queue counts: details={len(details)}, queue={len(queue)}.")
    if {str(q["document_id"]) for q in queue} != header_ids:
        raise RuntimeError("Verified sync queue does not match exactly the correction headers.")
    if any(decimal(h["amount"]) != 0 or h["status"] != "Approved" or h["bank_name"] != "Internal Transfer" or h["transaction_type"] != "Internal Transfer" or h["category"] != "Transfer" for h in headers):
        raise RuntimeError("Verified remittance header values differ from the approved scope.")

    # Verify every mapped original balance before importing records.
    for row in ready:
        key = (row["member_id"], row["loan_enterprise_id"])
        if before_balances[key] != decimal(row["loan_balance_before"]):
            raise RuntimeError(f"Original balance no longer matches preview at sequence {row['sequence']}.")
    for row in held:
        key = (row["member_id"], row["loan_enterprise_id"])
        if before_balances[key] != decimal(row["loan_balance_before"]):
            raise RuntimeError(f"HOLD balance no longer matches preview at sequence {row['sequence']}.")

    # Preserve an exact byte-for-byte backup before opening the original for writes.
    shutil.copy2(SOURCE, BACKUP)
    if sha(BACKUP) != EXPECTED_SOURCE_SHA256:
        BACKUP.unlink(missing_ok=True)
        raise RuntimeError("Safety backup checksum mismatch; original not modified.")

    destination = sqlite3.connect(SOURCE, timeout=30)
    destination.execute("PRAGMA busy_timeout=30000")
    try:
        destination.execute("BEGIN IMMEDIATE")
        current_hash = sha(SOURCE)
        # Hashing a DB with an open write transaction is stable here because no
        # changes have yet been made and the main file uses DELETE journaling.
        if current_hash != EXPECTED_SOURCE_SHA256:
            raise RuntimeError("Original DB changed just before write; transaction rolled back.")
        existing_ids = {str(row[0]) for row in destination.execute("SELECT id FROM remittance")}
        if existing_ids.intersection(header_ids):
            raise RuntimeError("One or more new remittance IDs already exist; transaction rolled back.")
        # Queue IDs also must not conflict, as queue rows have a numeric primary key.
        existing_queue_ids = {str(row[0]) for row in destination.execute("SELECT id FROM sync_queue")}
        new_queue_ids = {str(q["id"]) for q in queue}
        if existing_queue_ids.intersection(new_queue_ids):
            raise RuntimeError("One or more sync queue IDs already exist; transaction rolled back.")

        insert_rows(destination, "remittance", headers)
        insert_rows(destination, "remittance_detail", details)
        insert_rows(destination, "sync_queue", queue)
        destination.commit()
    except Exception:
        destination.rollback()
        destination.close()
        raise

    # Verify committed rows and every target balance directly on the original.
    verify = sqlite3.connect(SOURCE, timeout=30)
    verify.row_factory = sqlite3.Row
    verify.execute("PRAGMA query_only=ON")
    integrity = verify.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        verify.close()
        raise RuntimeError(f"Original DB integrity check after commit failed: {integrity}; safety backup preserved at {BACKUP}")
    after_balances = ledger_balances(verify)
    for row in ready:
        key = (row["member_id"], row["loan_enterprise_id"])
        expected = decimal(row["loan_balance_after"])
        if after_balances[key] != expected:
            verify.close()
            raise RuntimeError(f"Committed loan balance mismatch at sequence {row['sequence']}; safety backup preserved at {BACKUP}")
        if row["correction_rule"].startswith("Under") and expected != 0:
            verify.close()
            raise RuntimeError(f"Under-₦1 loan was not zero at sequence {row['sequence']}.")
        if row["correction_rule"].startswith("Over") and expected != expected.to_integral_value():
            verify.close()
            raise RuntimeError(f"Over-₦1 loan did not become whole-naira at sequence {row['sequence']}.")
    for row in held:
        key = (row["member_id"], row["loan_enterprise_id"])
        if after_balances[key] != before_balances[key]:
            verify.close()
            raise RuntimeError(f"HOLD loan changed at sequence {row['sequence']}.")
    observed_headers = verify.execute("SELECT count(*) FROM remittance WHERE cooperative_id=? AND description=? AND status='Approved' AND is_deleted='0'", (COOP_ID, DESCRIPTION)).fetchone()[0]
    observed_details = verify.execute("SELECT count(*) FROM remittance_detail d JOIN remittance r ON r.id=d.remittance_id WHERE r.cooperative_id=? AND r.description=? AND d.is_deleted='0'", (COOP_ID, DESCRIPTION)).fetchone()[0]
    observed_queue = verify.execute("SELECT count(*) FROM sync_queue WHERE cooperative_id=? AND collection_name='remittance' AND status='pending' AND document_id IN (SELECT id FROM remittance WHERE cooperative_id=? AND description=?)", (COOP_ID, COOP_ID, DESCRIPTION)).fetchone()[0]
    if (observed_headers, observed_details, observed_queue) != (314, 628, 314):
        verify.close()
        raise RuntimeError(f"Committed record counts mismatch: headers={observed_headers}, details={observed_details}, queue={observed_queue}.")
    total_loan_delta = sum((decimal(r["loan_detail_delta"]) for r in ready), Decimal(0))
    total_savings_delta = sum((decimal(r["savings_detail_delta"]) for r in ready), Decimal(0))
    if total_loan_delta + total_savings_delta != 0:
        verify.close()
        raise RuntimeError("Committed detail deltas do not net to zero.")
    verify.close()

    report = f"""# Update of the original TMSA database\n\n**Updated database:** `{SOURCE.name}`  \n**Pre-update safety copy:** `{BACKUP.name}`  \n**Source SHA-256 before update:** `{EXPECTED_SOURCE_SHA256}`  \n**Cooperative:** The Muslim Stars Association (TMSA)\n\nAdded exactly **314 READY** Approved Internal Transfer remittances to the original database. The **6 HOLD** rows were left unchanged. Each posted header has amount zero, date `2026-11-06T00:00:00.000Z`, transaction type `Internal Transfer`, category `Transfer`, and two equal/opposite detail rows (Ordinary Savings and a Loan enterprise).\n\n- Headers added: **{observed_headers}**\n- Detail rows added: **{observed_details}**\n- Pending parent sync queue entries: **{observed_queue}**\n- Net Loan detail adjustment: **₦{total_loan_delta}**\n- Net Ordinary Savings adjustment: **₦{total_savings_delta}**\n- Original database integrity check: **{integrity}**\n- Original loan balances checked against manifest: **314 READY match; 6 HOLD unchanged**\n- Pre-update safety-copy SHA-256: `{sha(BACKUP)}`\n\nThe pre-update database is preserved byte-for-byte as `{BACKUP.name}`. The previously created separate reconciled output copy remains available; this report confirms the original Downloads database was updated directly.\n"""
    REPORT.write_text(report, encoding="utf-8")
    print(f"UPDATED_ORIGINAL={SOURCE}")
    print(f"SAFETY_BACKUP={BACKUP}")
    print(f"REPORT={REPORT}")
    print(f"HEADERS={observed_headers} DETAILS={observed_details} QUEUE={observed_queue}")
    print(f"READY={len(ready)} HOLD_UNCHANGED={len(held)} INTEGRITY={integrity}")
    print(f"LOAN_DELTA={total_loan_delta} SAVINGS_DELTA={total_savings_delta}")
    print(f"BACKUP_SHA256={sha(BACKUP)}")


if __name__ == "__main__":
    main()
