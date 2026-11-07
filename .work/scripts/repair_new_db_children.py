import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

TARGET = r"C:\Users\User\Documents\OGSC Project\new.db"
REFERENCE = r"C:\Users\User\Documents\OGSC Project\old.db"
STAMP = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
BACKUP = TARGET + f".before-child-repair-{STAMP}.bak"
ACTOR = "data-repair"


def as_int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def as_float(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def parse_json(value, fallback):
    if value in (None, ""):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return fallback


def active(row):
    return as_int(row.get("is_deleted")) != 1


if not os.path.exists(TARGET):
    raise FileNotFoundError(TARGET)
if not os.path.exists(REFERENCE):
    raise FileNotFoundError(REFERENCE)
shutil.copy2(TARGET, BACKUP)

now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
con = sqlite3.connect(TARGET)
con.row_factory = sqlite3.Row
ref = sqlite3.connect(REFERENCE)
ref.row_factory = sqlite3.Row

try:
    con.execute("PRAGMA foreign_keys=OFF")
    con.execute("BEGIN IMMEDIATE")

    rem_rows = [dict(r) for r in con.execute("SELECT * FROM remittance")]
    rem_by_id = {r["id"]: r for r in rem_rows}
    detail_rows = [dict(r) for r in con.execute("SELECT * FROM remittance_detail")]
    active_details = [r for r in detail_rows if active(r)]
    active_parents = {r["id"]: r for r in rem_rows if active(r)}

    loan_infos = []
    for d in active_details:
        if not d.get("loan_info"):
            continue
        info = parse_json(d["loan_info"], None)
        if isinstance(info, dict) and isinstance(info.get("loanData"), dict):
            loan_infos.append((d, info))

    ref_loans = {
        r["id"]: dict(r)
        for r in ref.execute("SELECT * FROM loans")
        if active(dict(r))
    }
    ref_loans_by_remittance = {}
    for loan in ref_loans.values():
        ref_loans_by_remittance.setdefault(loan.get("remittance_id"), []).append(loan)

    existing_loan_ids = {
        r["id"] for r in con.execute("SELECT id FROM loans")
    }
    inserted_loans = []
    for d, info in loan_infos:
        parent = active_parents.get(d["remittance_id"])
        if not parent:
            continue
        historical = ref_loans_by_remittance.get(d["remittance_id"], [])
        historical = [l for l in historical if str(l.get("enterprise_id")) == str(d.get("enterprise_id"))]
        if not historical:
            raise RuntimeError(f"No historical loan row for {d['remittance_id']} / {d['enterprise_id']}")
        loan = historical[0]
        if loan["id"] in existing_loan_ids:
            continue
        con.execute(
            """INSERT INTO loans
            (id, cooperative_id, member_id, enterprise_id, principal_amount,
             issued_date, due_date, status, notes, created_at, created_by,
             modified_at, modified_by, deleted_at, is_synced, is_deleted,
             sync_at, admin_fee_id, duration_months, remittance_id,
             monthly_advice_amount)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            tuple(loan.get(k) for k in [
                "id", "cooperative_id", "member_id", "enterprise_id", "principal_amount",
                "issued_date", "due_date", "status", "notes", "created_at", "created_by",
                "modified_at", "modified_by", "deleted_at", "is_synced", "is_deleted",
                "sync_at", "admin_fee_id", "duration_months", "remittance_id",
                "monthly_advice_amount"
            ])
        )
        inserted_loans.append(loan["id"])
        existing_loan_ids.add(loan["id"])

    loans = {r["id"]: dict(r) for r in con.execute("SELECT * FROM loans") if active(dict(r))}

    children = [
        dict(r) for r in con.execute(
            "SELECT * FROM remittance WHERE cast(coalesce(autogen,0) as integer)=1"
        ) if active(dict(r))
    ]
    deleted_children = []
    for child in children:
        parent = active_parents.get(child.get("parent_remittance_id"))
        loan = loans.get(child.get("loan_id"))
        reasons = []
        if not parent:
            reasons.append("missing_active_parent_link")
        if not loan:
            reasons.append("missing_active_loan_link")
        if as_float(child.get("amount")) == 0:
            reasons.append("zero_value_child_not_created_by_app")
        if str(child.get("bank_name") or "").strip().lower() != "internal transfer":
            reasons.append("wrong_bank_method")
        if str(child.get("status") or "") != "Approved":
            reasons.append("wrong_status")
        if reasons:
            con.execute(
                """UPDATE remittance SET is_deleted=1, deleted_at=?, modified_at=?,
                   modified_by=?, is_synced=0 WHERE id=?""",
                (now, now, ACTOR, child["id"])
            )
            deleted_children.append({"id": child["id"], "reasons": reasons})

    # Normalize valid autogenerated children to the current app's explicit parent link.
    normalized_links = []
    for child in [dict(r) for r in con.execute(
        "SELECT * FROM remittance WHERE cast(coalesce(autogen,0) as integer)=1 AND cast(coalesce(is_deleted,0) as integer)=0"
    )]:
        loan = loans.get(child.get("loan_id"))
        if not loan:
            raise RuntimeError(f"Valid child still lacks loan: {child['id']}")
        expected_parent = loan.get("remittance_id")
        if child.get("parent_remittance_id") != expected_parent:
            con.execute(
                "UPDATE remittance SET parent_remittance_id=?, modified_at=?, modified_by=?, is_synced=0 WHERE id=?",
                (expected_parent, now, ACTOR, child["id"])
            )
            normalized_links.append(child["id"])

    con.commit()

    # Validate active family invariants after mutation.
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"SQLite integrity_check failed: {integrity}")

    active_children = [
        dict(r) for r in con.execute(
            "SELECT * FROM remittance WHERE cast(coalesce(autogen,0) as integer)=1 AND cast(coalesce(is_deleted,0) as integer)=0"
        )
    ]
    active_loans = {r["id"]: dict(r) for r in con.execute("SELECT * FROM loans") if active(dict(r))}
    validation_errors = []
    for child in active_children:
        parent = active_parents.get(child.get("parent_remittance_id"))
        loan = active_loans.get(child.get("loan_id"))
        if not parent or not loan:
            validation_errors.append((child["id"], "broken_parent_or_loan_link"))
        if str(child.get("bank_name") or "").lower() != "internal transfer":
            validation_errors.append((child["id"], "wrong_bank_method"))
        if as_float(child.get("amount")) == 0:
            validation_errors.append((child["id"], "zero_value"))
        if child.get("member_id") != "0000000000" and loan and child.get("member_id") != loan.get("member_id"):
            validation_errors.append((child["id"], "member_loan_mismatch"))
        if parent and child.get("remittance_date") != parent.get("remittance_date"):
            validation_errors.append((child["id"], "date_mismatch"))

    if validation_errors:
        raise RuntimeError("Post-repair validation errors: " + repr(validation_errors))

    result = {
        "target": TARGET,
        "backup": BACKUP,
        "inserted_loans": inserted_loans,
        "deleted_children": deleted_children,
        "normalized_links": normalized_links,
        "active_children_after": len(active_children),
        "active_loans_after": len(active_loans),
        "integrity_check": integrity,
    }
    print(json.dumps(result, indent=2))
finally:
    ref.close()
    con.close()
