from __future__ import annotations
import argparse, csv, hashlib, json, os, sqlite3, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

DB = Path(r"C:\Users\User\Documents\Radio Project\new_file.db")
CSV = Path(r"C:\Users\User\Documents\GitHub\cooplogng\outputs\bank_import_20261104\transaction_mapping_preview_v3_20261104.csv")
WORK = Path(r"C:\Users\User\Documents\GitHub\cooplogng\.work\bank_import_20261104")
COOP_ID = "RACDA"
ACTOR = "RACDA"  # active administrator username, matching the app's remittance add path
PSEUDO_MEMBER = "0000000000"
EXPECTED_ROWS = 142
EXPECTED_CLASS_COUNTS = {
    "Member savings contribution": 9,
    "Unknown Payment": 43,
    "Bank / financial expense": 71,
    "Other Income": 19,
}
TYPE_CATEGORY = {
    "Member savings contribution": ("Member Deposit", "Member Liability"),
    "Unknown Payment": ("Unknown Payments", "Member Liability"),
    "Bank / financial expense": ("Financial & Banking Expenses", "Finance Expense"),
    "Other Income": ("Other Income", "Other Income"),
}
REMITTANCE_COLUMNS = [
    "id", "cooperative_id", "member_id", "amount", "bank_name", "description",
    "transaction_type", "category", "status", "remittance_date", "created_by",
    "created_at", "modified_by", "modified_at", "is_deleted", "is_synced",
    "sync_at", "deleted_at", "reconciliation_summary_id", "autogen", "loan_id",
    "isWithdrawalRequest", "isLoanRequest", "parent_remittance_id",
]
DETAIL_COLUMNS = [
    "id", "cooperative_id", "remittance_id", "enterprise_id", "amount",
    "auto_description", "loan_info", "created_by", "created_at", "modified_by",
    "modified_at", "is_synced", "is_deleted", "sync_at", "deleted_at",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def connect_ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table_counts(conn: sqlite3.Connection) -> dict:
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}


def load_rows() -> tuple[list[dict], dict]:
    with CSV.open("r", newline="", encoding="utf-8-sig") as f:
        all_rows = list(csv.DictReader(f))
    if len(all_rows) != 177:
        raise ValueError(f"Expected 177 mapped source rows; found {len(all_rows)}")
    rows = [r for r in all_rows if r["Import outcome if unblocked"] == "READY FOR APPROVAL"]
    if len(rows) != EXPECTED_ROWS:
        raise ValueError(f"Expected exactly {EXPECTED_ROWS} READY FOR APPROVAL rows; found {len(rows)}")
    classes = Counter(r["Proposed classification"] for r in rows)
    if dict(classes) != EXPECTED_CLASS_COUNTS:
        raise ValueError(f"Approved class counts changed: {dict(classes)}")
    row_keys = [(r["Worksheet"], r["Excel row"]) for r in rows]
    if len(set(row_keys)) != len(rows):
        raise ValueError("Duplicate source sheet/row in approved mapping")
    totals = defaultdict(lambda: {"count": 0, "debit": Decimal("0"), "credit": Decimal("0")})
    for r in rows:
        cls = r["Proposed classification"]
        if cls not in TYPE_CATEGORY:
            raise ValueError(f"Unapproved classification entered prepared set: {cls}")
        tx_type, category = TYPE_CATEGORY[cls]
        if r["Application transaction type"] != tx_type or r["Application category"] != category:
            raise ValueError(f"Unexpected type/category in source row {r['Worksheet']}:{r['Excel row']}")
        if r["Bank-name validation"] != "Exact active-bank match" or r["Bank name in remittance (from worksheet)"] != r["Worksheet"]:
            raise ValueError(f"Bank mismatch in source row {r['Worksheet']}:{r['Excel row']}")
        try:
            debit = Decimal(r["Debit"] or "0")
            credit = Decimal(r["Credit"] or "0")
            signed = Decimal(r["Amount signed (credit + / debit -)"])
        except InvalidOperation as e:
            raise ValueError(f"Invalid amount in {r['Worksheet']}:{r['Excel row']}") from e
        if debit < 0 or credit < 0 or (debit and credit):
            raise ValueError(f"Invalid debit/credit sides in {r['Worksheet']}:{r['Excel row']}")
        if signed != credit - debit:
            raise ValueError(f"Signed amount mismatch in {r['Worksheet']}:{r['Excel row']}")
        note = r["Transaction note to store"]
        desc = r["Bank description"]
        ref = r["Bank reference"]
        if desc and not note.startswith(desc):
            raise ValueError(f"Description not preserved in note at {r['Worksheet']}:{r['Excel row']}")
        if ref and f"Bank reference: {ref}" not in note:
            raise ValueError(f"Reference not preserved in note at {r['Worksheet']}:{r['Excel row']}")
        if cls == "Member savings contribution":
            if not r["Member ID"] or signed <= 0:
                raise ValueError(f"Savings item needs a known member and positive amount at {r['Worksheet']}:{r['Excel row']}")
        elif r["Member ID"]:
            raise ValueError(f"Non-member cooperative header unexpectedly has member ID at {r['Worksheet']}:{r['Excel row']}")
        agg = totals[cls]
        agg["count"] += 1
        agg["debit"] += debit
        agg["credit"] += credit
    summary = {k: {"count": v["count"], "debit": str(v["debit"]), "credit": str(v["credit"])} for k, v in totals.items()}
    return rows, summary


def validate_target(path: Path, rows: list[dict], expected_empty: bool = True) -> dict:
    if not path.is_file():
        raise FileNotFoundError(path)
    c = connect_ro(path)
    try:
        integrity = c.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"SQLite integrity_check failed: {integrity}")
        coop = c.execute("SELECT id FROM cooperatives WHERE id=?", (COOP_ID,)).fetchone()
        if not coop:
            raise ValueError(f"Expected cooperative {COOP_ID} not found")
        banks = {r[0] for r in c.execute("SELECT bank_name FROM bank WHERE cooperative_id=? AND is_deleted='0'", (COOP_ID,))}
        sheets = {r["Worksheet"] for r in rows}
        if not sheets.issubset(banks):
            raise ValueError(f"Worksheet banks not present in target: {sheets - banks}")
        enterprises = {r["account_name"]: r["id"] for r in c.execute("SELECT id,account_name FROM enterprise WHERE cooperative_id=? AND is_deleted='0'", (COOP_ID,))}
        if "Ordinary Savings" not in enterprises:
            raise ValueError("Ordinary Savings enterprise missing")
        for r in rows:
            if r["Proposed classification"] == "Member savings contribution":
                if not c.execute("SELECT 1 FROM members WHERE id=? AND cooperative_id=? AND is_deleted='0'", (r["Member ID"], COOP_ID)).fetchone():
                    raise ValueError(f"Mapped member missing/inactive: {r['Member ID']}")
        admin = c.execute("SELECT username FROM users WHERE cooperative_id=? AND lower(role)='admin' AND is_deleted='0'", (COOP_ID,)).fetchone()
        if not admin or admin[0] != ACTOR:
            raise ValueError("Expected active RACDA admin audit identity not found")
        txcols = {r[1] for r in c.execute('PRAGMA table_info("remittance")')}
        dcols = {r[1] for r in c.execute('PRAGMA table_info("remittance_detail")')}
        if not set(REMITTANCE_COLUMNS).issubset(txcols) or not set(DETAIL_COLUMNS).issubset(dcols):
            raise ValueError("Target schema does not match expected application allowlist")
        existing_rem = c.execute("SELECT COUNT(*) FROM remittance").fetchone()[0]
        existing_det = c.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0]
        if expected_empty and (existing_rem != 0 or existing_det != 0):
            raise ValueError(f"Target no longer empty: remittance={existing_rem}, detail={existing_det}; refusing import")
        return {
            "integrity": integrity, "counts": table_counts(c), "banks": sorted(banks),
            "enterprises": enterprises, "savings_enterprise_id": enterprises["Ordinary Savings"],
            "existing_remittances": existing_rem, "existing_details": existing_det,
            "cooperative_id": COOP_ID, "audit_actor": ACTOR,
            "loan_rows_present_in_import": sum(r["Proposed classification"].startswith("Ordinary Loan") for r in rows),
        }
    finally:
        c.close()


def create_backup() -> dict:
    if not DB.is_file():
        raise FileNotFoundError(DB)
    WORK.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
    backup = DB.with_name(f"new_file.preimport_{stamp}.db")
    manifest_path = WORK / f"preimport_manifest_{stamp}.json"
    if backup.exists() or manifest_path.exists():
        raise FileExistsError("Refusing to overwrite an existing timestamped backup or manifest")
    before = validate_target(DB, load_rows()[0], expected_empty=True)
    source_hash = sha256(DB)
    src = connect_ro(DB)
    dst = sqlite3.connect(str(backup))
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()
    b = connect_ro(backup)
    try:
        b_integrity = b.execute("PRAGMA integrity_check").fetchone()[0]
        backup_counts = table_counts(b)
    finally:
        b.close()
    if b_integrity != "ok" or backup_counts != before["counts"]:
        raise ValueError("Backup verification failed; import not started")
    if sha256(DB) != source_hash:
        raise ValueError("Source target file changed while making backup; import not started")
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(), "source_db": str(DB),
        "backup_db": str(backup), "source_sha256_before_import": source_hash,
        "backup_sha256": sha256(backup), "source_size_bytes": DB.stat().st_size,
        "source_mtime_ns": DB.stat().st_mtime_ns, "integrity": b_integrity,
        "table_counts": backup_counts, "authorized_scope": "142 READY FOR APPROVAL rows only; SQLite file only",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"backup": str(backup), "manifest": str(manifest_path), "manifest_data": manifest}


def build_docs(rows: list[dict], pre: dict) -> tuple[list[dict], list[dict]]:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    stamp = datetime.now().astimezone().strftime("%Y%m%d%H%M%S")
    rems, details = [], []
    member_details = 0
    for i, r in enumerate(rows, 1):
        cls = r["Proposed classification"]
        tx_type, category = TYPE_CATEGORY[cls]
        signed = Decimal(r["Amount signed (credit + / debit -)"])
        rem_id = f"{COOP_ID}-{stamp}-BANKIMPORT-{i:03d}"
        member_id = r["Member ID"] if cls == "Member savings contribution" else PSEUDO_MEMBER
        amount = format(signed, ".2f")
        rem = {
            "id": rem_id, "cooperative_id": COOP_ID, "member_id": member_id,
            "amount": amount, "bank_name": r["Worksheet"],
            "description": r["Transaction note to store"], "transaction_type": tx_type,
            "category": category, "status": "Approved", "remittance_date": r["Transaction date"],
            "created_by": ACTOR, "created_at": now, "modified_by": ACTOR, "modified_at": now,
            "is_deleted": "0", "is_synced": "0", "sync_at": None, "deleted_at": None,
            "reconciliation_summary_id": None, "autogen": "0", "loan_id": None,
            "isWithdrawalRequest": "0", "isLoanRequest": "0", "parent_remittance_id": None,
        }
        rems.append(rem)
        if cls == "Member savings contribution":
            details.append({
                "id": f"{COOP_ID}-{uuid4()}", "cooperative_id": COOP_ID,
                "remittance_id": rem_id, "enterprise_id": pre["savings_enterprise_id"],
                "amount": amount, "auto_description": None, "loan_info": None,
                "created_by": ACTOR, "created_at": now, "modified_by": ACTOR,
                "modified_at": now, "is_synced": "0", "is_deleted": "0",
                "sync_at": None, "deleted_at": None,
            })
            member_details += 1
    if len({r["id"] for r in rems}) != len(rems):
        raise ValueError("Generated duplicate remittance IDs")
    if len({d["id"] for d in details}) != len(details):
        raise ValueError("Generated duplicate detail IDs")
    return rems, details


def import_rows(backup_path: Path, manifest_path: Path) -> dict:
    rows, totals = load_rows()
    pre = validate_target(DB, rows, expected_empty=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if Path(manifest["backup_db"]).resolve() != backup_path.resolve():
        raise ValueError("Backup path does not match the verified manifest")
    if sha256(DB) != manifest["source_sha256_before_import"]:
        raise ValueError("Target SQLite file changed after backup; refusing import")
    if sha256(backup_path) != manifest["backup_sha256"]:
        raise ValueError("Backup checksum changed; refusing import")
    rems, details = build_docs(rows, pre)
    c = sqlite3.connect(str(DB), timeout=30)
    try:
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("BEGIN IMMEDIATE")
        rem_q = f"INSERT INTO remittance ({','.join('"'+x+'"' for x in REMITTANCE_COLUMNS)}) VALUES ({','.join('?' for _ in REMITTANCE_COLUMNS)})"
        det_q = f"INSERT INTO remittance_detail ({','.join('"'+x+'"' for x in DETAIL_COLUMNS)}) VALUES ({','.join('?' for _ in DETAIL_COLUMNS)})"
        c.executemany(rem_q, [tuple(r[x] for x in REMITTANCE_COLUMNS) for r in rems])
        c.executemany(det_q, [tuple(d[x] for x in DETAIL_COLUMNS) for d in details])
        if c.execute("SELECT COUNT(*) FROM remittance").fetchone()[0] != EXPECTED_ROWS:
            raise ValueError("In-transaction remittance count validation failed")
        if c.execute("SELECT COUNT(*) FROM remittance_detail").fetchone()[0] != len(details):
            raise ValueError("In-transaction detail count validation failed")
        if c.execute("SELECT COUNT(*) FROM remittance WHERE status='Approved'").fetchone()[0] != EXPECTED_ROWS:
            raise ValueError("In-transaction approval status validation failed")
        for r in rems:
            got = c.execute("SELECT cooperative_id,member_id,amount,bank_name,description,transaction_type,category,status,remittance_date FROM remittance WHERE id=?", (r["id"],)).fetchone()
            expect = tuple(r[k] for k in ("cooperative_id","member_id","amount","bank_name","description","transaction_type","category","status","remittance_date"))
            if got != expect:
                raise ValueError(f"In-transaction row verification failed for {r['id']}")
        for d in details:
            got = c.execute("SELECT cooperative_id,remittance_id,enterprise_id,amount FROM remittance_detail WHERE id=?", (d["id"],)).fetchone()
            expect = tuple(d[k] for k in ("cooperative_id","remittance_id","enterprise_id","amount"))
            if got != expect:
                raise ValueError(f"In-transaction detail verification failed for {d['id']}")
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()

    ro = connect_ro(DB)
    try:
        integrity = ro.execute("PRAGMA integrity_check").fetchone()[0]
        counts = table_counts(ro)
        status_counts = dict(ro.execute("SELECT status,COUNT(*) FROM remittance GROUP BY status").fetchall())
        bank_counts = dict(ro.execute("SELECT bank_name,COUNT(*) FROM remittance GROUP BY bank_name").fetchall())
        type_counts = dict(ro.execute("SELECT transaction_type,COUNT(*) FROM remittance GROUP BY transaction_type").fetchall())
        detail_rows = [dict(x) for x in ro.execute("SELECT remittance_id,enterprise_id,amount FROM remittance_detail ORDER BY remittance_id")]
        imported_ids = {r[0] for r in ro.execute("SELECT id FROM remittance")}
        expected_ids = {r["id"] for r in rems}
        bad_links = ro.execute("SELECT COUNT(*) FROM remittance_detail d LEFT JOIN remittance r ON r.id=d.remittance_id WHERE r.id IS NULL").fetchone()[0]
        bad_banks = ro.execute("SELECT COUNT(*) FROM remittance r LEFT JOIN bank b ON b.cooperative_id=r.cooperative_id AND b.bank_name=r.bank_name AND b.is_deleted='0' WHERE b.id IS NULL").fetchone()[0]
        if integrity != "ok" or counts.get("remittance") != EXPECTED_ROWS or counts.get("remittance_detail") != len(details):
            raise ValueError("Post-commit counts/integrity verification failed")
        if imported_ids != expected_ids or bad_links != 0 or bad_banks != 0:
            raise ValueError("Post-commit ID/link/bank verification failed")
        if status_counts != {"Approved": EXPECTED_ROWS}:
            raise ValueError(f"Unexpected status counts after import: {status_counts}")
        if sum(1 for d in detail_rows if d["enterprise_id"] == pre["savings_enterprise_id"]) != 9:
            raise ValueError("Post-commit savings detail count validation failed")
        for sheet in ("FCMB", "Fidelity Bank"):
            if bank_counts.get(sheet, 0) != sum(r["Worksheet"] == sheet for r in rows):
                raise ValueError(f"Unexpected bank count for {sheet}")
        report = {
            "completed_at": datetime.now(timezone.utc).isoformat(), "source_csv": str(CSV),
            "target_db": str(DB), "backup_db": str(backup_path), "backup_manifest": str(manifest_path),
            "authorization": "SQLite-only import of 142 READY FOR APPROVAL rows; 35 unresolved rows excluded",
            "rows_imported": len(rems), "details_imported": len(details),
            "classes": EXPECTED_CLASS_COUNTS, "totals_by_class": totals,
            "total_debits": str(sum(Decimal(r["Debit"] or "0") for r in rows)),
            "total_credits": str(sum(Decimal(r["Credit"] or "0") for r in rows)),
            "bank_counts": bank_counts, "transaction_type_counts": type_counts,
            "status_counts": status_counts, "integrity_check": integrity,
            "unlinked_details": bad_links, "bank_name_mismatches": bad_banks,
            "database_counts": counts, "live_indexeddb_modified": False,
            "source_workbook_modified": False, "schema_modified": False,
        }
        WORK.mkdir(parents=True, exist_ok=True)
        audit_path = WORK / "sqlite_only_import_verification_20261104.json"
        audit_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        return {"audit": str(audit_path), **report}
    finally:
        ro.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup", action="store_true")
    ap.add_argument("--import", dest="do_import", action="store_true")
    ap.add_argument("--backup-path", type=Path)
    ap.add_argument("--manifest-path", type=Path)
    args = ap.parse_args()
    if sum([args.dry_run, args.backup, args.do_import]) != 1:
        ap.error("choose exactly one of --dry-run, --backup, or --import")
    rows, totals = load_rows()
    if args.dry_run:
        state = validate_target(DB, rows, expected_empty=True)
        print(json.dumps({"mode":"dry-run-no-writes","source_rows":177,"selected_rows":len(rows),"class_counts":EXPECTED_CLASS_COUNTS,"totals":totals,"preimport_state":state},ensure_ascii=False,indent=2))
    elif args.backup:
        print(json.dumps(create_backup(),ensure_ascii=False,indent=2))
    else:
        if not args.backup_path or not args.manifest_path:
            ap.error("--import requires --backup-path and --manifest-path from the verified backup step")
        print(json.dumps(import_rows(args.backup_path, args.manifest_path),ensure_ascii=False,indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error":str(e),"writes_may_have_occurred":False},ensure_ascii=False),file=sys.stderr)
        raise
