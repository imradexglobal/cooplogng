import csv
import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

SOURCE = Path(r"C:\Users\User\Downloads\cooperative_backup_2026-11-06T13-24.db")
OUTPUT_DIR = Path(r"C:\Users\User\Documents\GitHub\cooplogng\outputs\loan-balance-reconciliation-2026-11-06")
PREVIEW = OUTPUT_DIR / "proposed-remittances.csv"
OUTPUT_DB = OUTPUT_DIR / "cooperative_backup_2026-11-06_RECONCILED_READY_2026-11-06.db"
MANIFEST = OUTPUT_DIR / "applied-remittance-manifest.csv"
EXECUTION_REPORT = OUTPUT_DIR / "reconciliation-execution.md"
EXPECTED_SOURCE_SHA256 = "fb7f5902d93ef30bed415e911334ffa0e7319391ce828d5858efc809180d18e4"
COOP_ID = "TMSA"
DESCRIPTION = "Loan balance precision reconciliation — Ordinary Savings offset"
REMITTANCE_DATE = "2026-11-06T00:00:00.000Z"
CREATED_BY = "system"


def decimal(value):
    try:
        return Decimal(str(value if value is not None else "0").strip() or "0")
    except (InvalidOperation, ValueError):
        raise ValueError(f"Invalid decimal amount: {value!r}")


def decimal_text(value):
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def iso_utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_csv_rows():
    with PREVIEW.open("r", newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    ready = [row for row in rows if row["review_status"] == "READY"]
    held = [row for row in rows if row["review_status"] == "HOLD"]
    if (len(rows), len(ready), len(held)) != (320, 314, 6):
        raise RuntimeError(f"Unexpected preview counts: total={len(rows)}, ready={len(ready)}, hold={len(held)}")
    for row in ready:
        loan_delta = decimal(row["loan_detail_delta"])
        savings_delta = decimal(row["savings_detail_delta"])
        if loan_delta + savings_delta != 0:
            raise RuntimeError(f"Unbalanced detail pair in preview sequence {row['sequence']}")
        if decimal(row["savings_balance_after_all_member_corrections"]) < 0:
            raise RuntimeError(f"READY row would leave negative Ordinary Savings: sequence {row['sequence']}")
    return ready, held


def main():
    if not SOURCE.is_file() or not PREVIEW.is_file():
        raise FileNotFoundError("The source backup or approved preview CSV is missing.")
    if OUTPUT_DB.exists() or MANIFEST.exists() or EXECUTION_REPORT.exists():
        raise FileExistsError("A reconciliation output already exists; refusing to overwrite it.")
    source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("Source backup checksum differs from the reviewed backup; refusing to proceed.")

    ready, held = read_csv_rows()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE, OUTPUT_DB)
    now_utc = datetime.now(timezone.utc)
    local_id_start = datetime.now().astimezone().replace(microsecond=0)
    manifest_rows = []
    totals = defaultdict(Decimal)
    header_start = None

    try:
        connection = sqlite3.connect(OUTPUT_DB)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Copied database failed SQLite integrity check before edits.")
        connection.execute("BEGIN IMMEDIATE")

        coop = connection.execute(
            "SELECT id, full_name FROM cooperatives WHERE id=? AND lower(coalesce(is_deleted,'0')) NOT IN ('1','true')",
            (COOP_ID,),
        ).fetchone()
        if not coop or coop["full_name"] != "The Muslim Stars Association":
            raise RuntimeError("Cooperative identity did not match the reviewed TMSA backup.")

        sealed = connection.execute(
            """SELECT id FROM bank_reconciliation_summary
               WHERE cooperative_id=? AND bank_name='Internal Transfer'
                 AND lower(coalesce(is_deleted,'0')) NOT IN ('1','true')
                 AND period_start<=? AND period_end>=? LIMIT 1""",
            (COOP_ID, "2026-11-06", "2026-11-06"),
        ).fetchone()
        if sealed:
            raise RuntimeError("The target date is covered by a sealed Internal Transfer reconciliation; app rules would block posting.")

        ordinary_savings = connection.execute(
            """SELECT id FROM enterprise WHERE cooperative_id=?
               AND lower(coalesce(account_type,''))='savings'
               AND lower(trim(coalesce(account_name,'')))='ordinary savings'
               AND lower(coalesce(is_deleted,'0')) NOT IN ('1','true')""",
            (COOP_ID,),
        ).fetchall()
        if len(ordinary_savings) != 1:
            raise RuntimeError(f"Expected exactly one Ordinary Savings enterprise, found {len(ordinary_savings)}.")
        savings_id = str(ordinary_savings[0]["id"])
        existing_headers = {
            str(row[0]) for row in connection.execute("SELECT id FROM remittance")
        }
        queue_id = connection.execute("SELECT coalesce(max(CAST(id AS INTEGER)),0)+1 FROM sync_queue").fetchone()[0]
        base_created = now_utc
        header_start = local_id_start

        for index, row in enumerate(ready):
            sequence = int(row["sequence"])
            member_id = str(row["member_id"])
            savings_enterprise_id = str(row["savings_enterprise_id"])
            loan_enterprise_id = str(row["loan_enterprise_id"])
            if savings_enterprise_id != savings_id:
                raise RuntimeError(f"Unexpected Savings enterprise in sequence {sequence}.")
            loan_enterprise = connection.execute(
                "SELECT account_type FROM enterprise WHERE cooperative_id=? AND id=? AND lower(coalesce(is_deleted,'0')) NOT IN ('1','true')",
                (COOP_ID, loan_enterprise_id),
            ).fetchone()
            if not loan_enterprise or str(loan_enterprise["account_type"]).lower() != "loan":
                raise RuntimeError(f"Target enterprise is not an active Loan account in sequence {sequence}.")

            loan_delta = decimal(row["loan_detail_delta"])
            savings_delta = decimal(row["savings_detail_delta"])
            if loan_delta + savings_delta != 0:
                raise RuntimeError(f"Detail totals are not zero in sequence {sequence}.")
            if decimal(row["remittance_amount"]) != 0:
                raise RuntimeError(f"Non-zero header amount in sequence {sequence}.")
            if row["remittance_date"] != "2026-11-06":
                raise RuntimeError(f"Unexpected date in sequence {sequence}.")
            if row["bank_name"] != "Internal Transfer" or row["transaction_type"] != "Internal Transfer" or row["category"] != "Transfer":
                raise RuntimeError(f"Classification differs from reviewed app classification in sequence {sequence}.")

            # Match the app's generateRemittanceId(cooperativeId) timestamp ID.
            candidate_time = local_id_start + timedelta(seconds=index)
            remittance_id = f"{COOP_ID}-{candidate_time.strftime('%Y%m%d%H%M%S')}"
            collision_index = 0
            while remittance_id in existing_headers:
                collision_index += 1
                candidate_time += timedelta(seconds=1)
                remittance_id = f"{COOP_ID}-{candidate_time.strftime('%Y%m%d%H%M%S')}"
                if collision_index > 1000:
                    raise RuntimeError("Could not allocate a unique app-format remittance ID.")
            existing_headers.add(remittance_id)
            created_at = iso_utc(base_created + timedelta(milliseconds=index))

            header = {
                "id": remittance_id,
                "cooperative_id": COOP_ID,
                "member_id": member_id,
                "amount": "0",
                "bank_name": "Internal Transfer",
                "description": DESCRIPTION,
                "transaction_type": "Internal Transfer",
                "category": "Transfer",
                "status": "Approved",
                "remittance_date": REMITTANCE_DATE,
                "created_by": CREATED_BY,
                "created_at": created_at,
                "modified_by": CREATED_BY,
                "modified_at": created_at,
                "is_deleted": "0",
                "is_synced": "0",
                "sync_at": None,
                "deleted_at": None,
                "reconciliation_summary_id": None,
                "autogen": "0",
                "loan_id": None,
                "isWithdrawalRequest": "0",
                "isLoanRequest": "0",
                "parent_remittance_id": None,
            }
            header_columns = list(header)
            connection.execute(
                f"INSERT INTO remittance ({','.join(header_columns)}) VALUES ({','.join('?' for _ in header_columns)})",
                [header[column] for column in header_columns],
            )

            detail_specs = [
                (savings_enterprise_id, savings_delta),
                (loan_enterprise_id, loan_delta),
            ]
            detail_ids = []
            for enterprise_id, amount in detail_specs:
                detail_id = f"{COOP_ID}-{uuid.uuid4()}"
                detail_ids.append(detail_id)
                detail = {
                    "id": detail_id,
                    "cooperative_id": COOP_ID,
                    "remittance_id": remittance_id,
                    "enterprise_id": enterprise_id,
                    "amount": decimal_text(amount),
                    "auto_description": "",
                    "loan_info": None,
                    "created_by": CREATED_BY,
                    "created_at": created_at,
                    "modified_by": CREATED_BY,
                    "modified_at": created_at,
                    "is_synced": "0",
                    "is_deleted": "0",
                    "sync_at": None,
                    "deleted_at": None,
                }
                detail_columns = list(detail)
                connection.execute(
                    f"INSERT INTO remittance_detail ({','.join(detail_columns)}) VALUES ({','.join('?' for _ in detail_columns)})",
                    [detail[column] for column in detail_columns],
                )

            # Match mutationEngine.saveDoc('remittance', ...): one parent
            # remittance queue row carries the canonical embedded details.
            connection.execute(
                """INSERT INTO sync_queue
                   (id,entity,entity_id,status,attempt_count,last_error,last_attempt_at,created_at,updated_at,
                    collection_name,document_id,operation_type,merged_document,cooperative_id,next_attempt_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (queue_id, "remittance", remittance_id, "pending", 0, None, None,
                 created_at, created_at, "remittance", remittance_id, "update", None, COOP_ID, None),
            )
            queue_id += 1
            manifest_rows.append({
                "sequence": sequence,
                "review_status": "READY",
                "remittance_id": remittance_id,
                "detail_id_savings": detail_ids[0],
                "detail_id_loan": detail_ids[1],
                "registration_no": row["registration_no"],
                "member_name": row["member_name"],
                "member_id": member_id,
                "loan_enterprise": row["loan_enterprise"],
                "loan_enterprise_id": loan_enterprise_id,
                "loan_balance_before": decimal_text(decimal(row["loan_balance_before"])),
                "loan_balance_after": decimal_text(decimal(row["loan_balance_after"])),
                "loan_detail_delta": decimal_text(loan_delta),
                "savings_detail_delta": decimal_text(savings_delta),
                "remittance_amount": "0",
                "remittance_date": REMITTANCE_DATE,
                "bank_name": "Internal Transfer",
                "transaction_type": "Internal Transfer",
                "category": "Transfer",
                "description": DESCRIPTION,
                "remittance_status": "Approved",
            })
            totals["loan_delta"] += loan_delta
            totals["savings_delta"] += savings_delta

        if len(manifest_rows) != 314 or totals["loan_delta"] + totals["savings_delta"] != 0:
            raise RuntimeError("Applied record count or total balancing validation failed.")

        connection.commit()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"Output database failed integrity check after changes: {integrity}")
        post_headers = connection.execute(
            "SELECT count(*) FROM remittance WHERE cooperative_id=? AND description=? AND status='Approved' AND is_deleted='0'",
            (COOP_ID, DESCRIPTION),
        ).fetchone()[0]
        post_details = connection.execute(
            "SELECT count(*) FROM remittance_detail d JOIN remittance r ON r.id=d.remittance_id WHERE r.cooperative_id=? AND r.description=? AND d.is_deleted='0'",
            (COOP_ID, DESCRIPTION),
        ).fetchone()[0]
        post_queue = connection.execute(
            "SELECT count(*) FROM sync_queue WHERE cooperative_id=? AND collection_name='remittance' AND status='pending' AND document_id IN (SELECT id FROM remittance WHERE description=?)",
            (COOP_ID, DESCRIPTION),
        ).fetchone()[0]
        if (post_headers, post_details, post_queue) != (314, 628, 314):
            raise RuntimeError(f"Output row count validation failed: headers={post_headers}, details={post_details}, queued={post_queue}")
        connection.close()

        with MANIFEST.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(manifest_rows[0]))
            writer.writeheader()
            writer.writerows(manifest_rows)

        source_after_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        if source_after_hash != EXPECTED_SOURCE_SHA256:
            raise RuntimeError("Source backup checksum changed unexpectedly; inspect both files before use.")
        output_hash = hashlib.sha256(OUTPUT_DB.read_bytes()).hexdigest()
        report = f"""# Reconciliation execution report\n\n**Source backup:** `{SOURCE.name}`  \n**Source SHA-256:** `{source_hash}`  \n**Output database copy:** `{OUTPUT_DB.name}`  \n**Output SHA-256:** `{output_hash}`  \n**Cooperative:** The Muslim Stars Association (TMSA)\n\nApplied exactly **314 READY remittances**. The **6 HOLD rows were not applied**.\n\nEach new remittance is Approved, dated `2026-11-06T00:00:00.000Z`, uses bank `Internal Transfer`, transaction type `Internal Transfer`, category `Transfer`, amount `0`, and description `{DESCRIPTION}`. Each has exactly two detail rows: Ordinary Savings `-loan_delta`, and the target Loan enterprise `loan_delta`. All 314 remittances are marked unsynced and have one parent sync-queue entry each, consistent with the app's remittance-save/sync model.\n\n- New headers: **{post_headers}**\n- New detail rows: **{post_details}**\n- Parent sync queue entries: **{post_queue}**\n- Net loan detail delta: **₦{decimal_text(totals['loan_delta'])}**\n- Net Ordinary Savings detail delta: **₦{decimal_text(totals['savings_delta'])}**\n- Header and paired-detail reconciliation: **balanced**\n- Output SQLite integrity check: **{integrity}**\n- Original source SHA-256 after processing: **{source_after_hash}** (unchanged)\n\nThe row-level mapping, balances before/after, detail amounts, and new remittance/detail IDs are in `applied-remittance-manifest.csv`. No values in the original backup were changed.\n"""
        EXECUTION_REPORT.write_text(report, encoding="utf-8")
        print(json.dumps({
            "output_db": str(OUTPUT_DB),
            "manifest": str(MANIFEST),
            "report": str(EXECUTION_REPORT),
            "integrity": integrity,
            "headers": post_headers,
            "details": post_details,
            "sync_queue": post_queue,
            "ready_applied": len(manifest_rows),
            "held_unapplied": len(held),
            "loan_delta": decimal_text(totals["loan_delta"]),
            "savings_delta": decimal_text(totals["savings_delta"]),
            "source_sha256": source_after_hash,
            "output_sha256": output_hash,
        }, ensure_ascii=False))
    except Exception:
        try:
            connection.rollback()
            connection.close()
        except Exception:
            pass
        # Keep the untouched source. Remove only an incomplete target copy so a
        # clean, guarded retry is possible; never remove outputs after success.
        if OUTPUT_DB.exists():
            OUTPUT_DB.unlink()
        raise


if __name__ == "__main__":
    main()
