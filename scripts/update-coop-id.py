#!/usr/bin/env python3
"""
update-coop-id.py
=================

Migrate one cooperative from one or more old cooperative IDs to a new/current
cooperative ID.

Usage
-----
Single old ID:

    python scripts/update-coop-id.py CG0nAXNIzK,Nasfat\ IKD

Multiple old IDs:

    python scripts/update-coop-id.py "CG0nAXNIzK,Nasfat IKD,OLD_ID_2"

The FIRST ID is always the CURRENT/NEW cooperative ID.
Every ID after the first is treated as an OLD cooperative ID.

Migration rules
---------------
1. The cooperatives collection is ALWAYS read using the old ID(s).
   At least one old cooperative document must exist.

2. The cooperative document is copied in memory and changed as follows:
      - document ID -> current ID
      - short_name -> current ID
      - sync_at -> current timestamp

   Firestore has no document-ID rename operation, so the old document is
   deleted and the migrated document is written under the current ID.

3. Every other configured collection is searched ONLY for documents whose
   cooperative_id is one of the old IDs.

4. For those documents:
      - cooperative_id -> current ID
      - sync_at -> current timestamp
      - document ID is NOT changed
      - all other fields are preserved

5. All source documents are pulled into memory before any write is made.

6. Writes are committed in Firestore batches (<= 500 operations per batch).

7. --dry-run performs the complete read/prepare phase but makes no changes.

Requirements
------------
- serviceAccountKey.json in the scripts folder, OR
  GOOGLE_APPLICATION_CREDENTIALS pointing to a service-account JSON file.
- firebase-admin installed:
      pip install firebase-admin
"""

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


# Collections containing cooperative_id records.
# The cooperatives collection is handled separately because its document ID
# is the cooperative ID and it must be renamed.
OTHER_COLLECTIONS = [
    "members",
    "loans",
    "enterprise",
    "bank",
    "remittance",
    "transaction_types",
    "bank_reconciliation_summary",
    "feedback",
    "notifications",
    "payment_advise",
    "remittance_detail",
    "loan_guarantors",
]

BATCH_LIMIT = 500


def init_firestore():
    """Initialize and return the Firestore client."""
    import firebase_admin
    from firebase_admin import credentials, firestore

    key_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

    if not key_path:
        key_path = str(Path(__file__).parent / "serviceAccountKey.json")

    if not os.path.exists(key_path):
        print(f"ERROR: Service account key not found: {key_path}")
        print(
            "Set GOOGLE_APPLICATION_CREDENTIALS or place "
            "serviceAccountKey.json next to this script."
        )
        sys.exit(1)

    try:
        if not firebase_admin._apps:
            cred = credentials.Certificate(key_path)
            firebase_admin.initialize_app(cred)

        return firestore.client()

    except Exception as exc:
        print(f"ERROR: Could not initialize Firebase/Firestore: {exc}")
        sys.exit(1)


def parse_coop_ids(raw_value):
    """
    Parse a comma-separated list.

    The first value is the current ID.
    Remaining values are old IDs.

    Example:
        CG0nAXNIzK,Nasfat IKD,OLD_ID
    """
    ids = [item.strip() for item in raw_value.split(",") if item.strip()]

    if len(ids) < 2:
        raise ValueError(
            "At least TWO IDs are required: CURRENT_ID,OLD_ID"
        )

    current_id = ids[0]
    old_ids = []

    for old_id in ids[1:]:
        if old_id == current_id:
            continue
        if old_id not in old_ids:
            old_ids.append(old_id)

    if not old_ids:
        raise ValueError(
            "No valid old cooperative ID was supplied after the current ID."
        )

    return current_id, old_ids


def get_cooperative_source_docs(db, old_ids):
    """
    Pull cooperative documents from the cooperatives collection.

    The cooperatives collection is compulsory: at least one old cooperative
    document must be found.

    Returns:
        list of dictionaries containing:
            old_id
            data
            document_reference
    """
    sources = []

    print("Pulling cooperative document(s) from 'cooperatives'...")

    for old_id in old_ids:
        ref = db.collection("cooperatives").document(old_id)
        snapshot = ref.get()

        if snapshot.exists:
            data = snapshot.to_dict() or {}

            sources.append(
                {
                    "old_id": old_id,
                    "ref": ref,
                    "data": data,
                }
            )

            print(f"  FOUND: cooperatives/{old_id}")
        else:
            print(f"  NOT FOUND: cooperatives/{old_id}")

    if not sources:
        raise RuntimeError(
            "No cooperative document was found for any supplied old ID. "
            "Nothing will be changed."
        )

    return sources


def pull_other_collection_docs(db, old_ids):
    """
    Pull every document whose cooperative_id matches one of old_ids.

    This is a read-only phase. Nothing is changed in Firestore here.

    Returns:
        list of dictionaries containing:
            collection
            ref
            data
            source_cooperative_id
    """
    pulled = []

    old_id_set = set(old_ids)

    print("\nPulling matching documents from other collections...")

    for collection_name in OTHER_COLLECTIONS:
        collection_ref = db.collection(collection_name)

        collection_count = 0

        # Query each old ID separately. This avoids depending on Firestore
        # 'in' query limits and makes the source ID explicit.
        for old_id in old_ids:
            try:
                query = collection_ref.where(
                    "cooperative_id", "==", old_id
                )

                docs = list(query.stream())

                for snapshot in docs:
                    data = snapshot.to_dict() or {}

                    # Defensive check in case a returned record has an
                    # unexpected value.
                    if data.get("cooperative_id") not in old_id_set:
                        continue

                    pulled.append(
                        {
                            "collection": collection_name,
                            "ref": snapshot.reference,
                            "data": data,
                            "source_cooperative_id": data.get(
                                "cooperative_id"
                            ),
                        }
                    )

                    collection_count += 1

            except Exception as exc:
                raise RuntimeError(
                    f"Failed reading collection '{collection_name}' "
                    f"for cooperative_id '{old_id}': {exc}"
                ) from exc

        print(f"  {collection_name}: {collection_count} document(s)")

    return pulled


def prepare_in_memory_changes(
    current_id,
    old_ids,
    cooperative_sources,
    other_documents,
):
    """
    Modify copies of the pulled data in memory.

    No Firestore write occurs in this function.

    Returns:
        {
            "new_cooperative": {
                "ref": ...,
                "data": ...
            },
            "old_cooperative_refs": [...],
            "other_updates": [...]
        }
    """
    now = datetime.now(timezone.utc)

    # ------------------------------------------------------------------
    # COOPERATIVE DOCUMENT
    # ------------------------------------------------------------------
    #
    # If more than one old cooperative document exists, use the first
    # one in the supplied old-ID order as the source data.
    #
    # This prevents an arbitrary Firestore query result from deciding
    # which cooperative document becomes the new/current document.
    # ------------------------------------------------------------------
    source = cooperative_sources[0]

    migrated_coop_data = dict(source["data"])

    # Explicitly update the requested cooperative fields.
    migrated_coop_data["short_name"] = current_id
    migrated_coop_data["sync_at"] = now

    # Keep cooperative_id consistent if that field exists in the source.
    # If it did not exist, we add it because the migrated cooperative
    # represents the current cooperative.
    migrated_coop_data["cooperative_id"] = current_id

    # ------------------------------------------------------------------
    # OTHER COLLECTIONS
    # ------------------------------------------------------------------
    other_updates = []

    for item in other_documents:
        updated_data = dict(item["data"])

        # Only these two fields change.
        updated_data["cooperative_id"] = current_id
        updated_data["sync_at"] = now

        other_updates.append(
            {
                "collection": item["collection"],
                "ref": item["ref"],
                "data": updated_data,
                "old_cooperative_id": item["source_cooperative_id"],
            }
        )

    return {
        "new_cooperative": {
            "ref": None,
            "data": migrated_coop_data,
        },
        "old_cooperative_refs": [
            source["ref"] for source in cooperative_sources
        ],
        "other_updates": other_updates,
        "sync_at": now,
    }


def build_operations(db, current_id, prepared):
    """
    Convert the in-memory changes into Firestore write operations.

    Operation format:
        ("set", ref, data)
        ("update", ref, data)
        ("delete", ref, None)
    """
    operations = []

    new_coop_ref = db.collection("cooperatives").document(current_id)

    # Create/replace the current cooperative document.
    operations.append(
        (
            "set",
            new_coop_ref,
            prepared["new_cooperative"]["data"],
        )
    )

    # Delete every old cooperative document after the new one is written.
    # This also handles the case where multiple old IDs were supplied.
    for old_ref in prepared["old_cooperative_refs"]:
        if old_ref.id != current_id:
            operations.append(("delete", old_ref, None))

    # Update all other documents without changing their document IDs.
    for item in prepared["other_updates"]:
        operations.append(
            (
                "update",
                item["ref"],
                {
                    "cooperative_id": current_id,
                    "sync_at": item["data"]["sync_at"],
                },
            )
        )

    return operations


def commit_operations(db, operations):
    """Commit Firestore operations in batches of <= 500."""
    total = len(operations)
    committed = 0

    print("\nWriting changes to Firestore...")

    for start in range(0, total, BATCH_LIMIT):
        chunk = operations[start : start + BATCH_LIMIT]

        batch = db.batch()

        for operation, ref, data in chunk:
            if operation == "set":
                batch.set(ref, data)
            elif operation == "update":
                batch.update(ref, data)
            elif operation == "delete":
                batch.delete(ref)
            else:
                raise RuntimeError(f"Unknown operation: {operation}")

        try:
            batch.commit()
        except Exception as exc:
            raise RuntimeError(
                f"Firestore batch failed for operations "
                f"{start + 1}-{start + len(chunk)}: {exc}"
            ) from exc

        committed += len(chunk)
        print(
            f"  Committed {len(chunk)} operation(s) "
            f"({committed}/{total})"
        )

    return committed


def print_summary(
    current_id,
    old_ids,
    cooperative_sources,
    other_documents,
    operations,
    sync_at,
    dry_run,
):
    """Print a clear migration summary."""
    other_count = len(other_documents)

    print("\n" + "=" * 72)
    print("COOPERATIVE ID MIGRATION SUMMARY")
    print("=" * 72)

    print(f"Current ID : {current_id}")
    print(f"Old ID(s)  : {', '.join(old_ids)}")
    print(f"Sync time  : {sync_at.isoformat()}")

    print("\nPulled:")
    print(
        f"  Cooperative document(s): "
        f"{len(cooperative_sources)}"
    )
    print(
        f"  Other collection document(s): "
        f"{other_count}"
    )

    print("\nChanges:")
    print(f"  New cooperative document: cooperatives/{current_id}")
    print(
        f"  Old cooperative document(s) deleted: "
        f"{len(cooperative_sources)}"
    )
    print(
        f"  Other documents keeping their existing document IDs: "
        f"{other_count}"
    )
    print(
        f"  Total Firestore operations: {len(operations)}"
    )

    if dry_run:
        print("\nDRY RUN: No Firestore writes were performed.")
    else:
        print("\nMigration completed.")

    print("=" * 72)


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Migrate cooperative_id values from one or more old IDs "
            "to a current ID and rename the cooperative document."
        )
    )

    parser.add_argument(
        "coop_ids",
        help=(
            "Comma-separated IDs. First is CURRENT, remaining IDs are OLD. "
            'Example: "CG0nAXNIzK,Nasfat IKD"'
        ),
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Pull and prepare everything, show the changes, "
            "but do not write to Firestore."
        ),
    )

    args = parser.parse_args()

    try:
        current_id, old_ids = parse_coop_ids(args.coop_ids)
    except ValueError as exc:
        parser.error(str(exc))

    print("=" * 72)
    print("COOPERATIVE ID MIGRATION")
    print("=" * 72)
    print(f"Current ID: {current_id}")
    print(f"Old ID(s): {', '.join(old_ids)}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'WRITE'}")
    print()

    db = init_firestore()
    print("Firestore initialized.")

    # ---------------------------------------------------------------
    # SAFETY CHECK
    # ---------------------------------------------------------------
    # The target document must not already exist unless it is one of
    # the source documents. Otherwise this script could overwrite an
    # unrelated cooperative.
    # ---------------------------------------------------------------
    target_ref = db.collection("cooperatives").document(current_id)
    target_doc = target_ref.get()

    if target_doc.exists and current_id not in old_ids:
        raise RuntimeError(
            f"Target cooperative document 'cooperatives/{current_id}' "
            "already exists. Migration stopped to avoid overwriting it."
        )

    # ---------------------------------------------------------------
    # PHASE 1: PULL EVERYTHING
    # ---------------------------------------------------------------
    # Nothing is modified in Firestore during this phase.
    # ---------------------------------------------------------------
    cooperative_sources = get_cooperative_source_docs(db, old_ids)

    other_documents = pull_other_collection_docs(db, old_ids)

    print(
        "\nAll matching source data has been pulled. "
        "No writes have been made yet."
    )

    # ---------------------------------------------------------------
    # PHASE 2: MODIFY IN MEMORY
    # ---------------------------------------------------------------
    print("\nPreparing all changes in memory...")

    prepared = prepare_in_memory_changes(
        current_id=current_id,
        old_ids=old_ids,
        cooperative_sources=cooperative_sources,
        other_documents=other_documents,
    )

    operations = build_operations(
        db=db,
        current_id=current_id,
        prepared=prepared,
    )

    print("In-memory preparation complete.")

    # Show a useful preview.
    print("\nPreview:")
    print(
        f"  cooperatives/{current_id}: "
        "SET migrated cooperative data"
    )

    for source in cooperative_sources:
        print(
            f"  cooperatives/{source['old_id']}: "
            "DELETE"
        )

    for item in prepared["other_updates"][:10]:
        print(
            f"  {item['collection']}/{item['ref'].id}: "
            f"cooperative_id "
            f"'{item['old_cooperative_id']}' -> '{current_id}'"
        )

    if len(prepared["other_updates"]) > 10:
        print(
            f"  ... and "
            f"{len(prepared['other_updates']) - 10} more "
            "document updates"
        )

    print_summary(
        current_id=current_id,
        old_ids=old_ids,
        cooperative_sources=cooperative_sources,
        other_documents=other_documents,
        operations=operations,
        sync_at=prepared["sync_at"],
        dry_run=args.dry_run,
    )

    if args.dry_run:
        return

    # ---------------------------------------------------------------
    # PHASE 3: WRITE
    # ---------------------------------------------------------------
    commit_operations(db, operations)

    print_summary(
        current_id=current_id,
        old_ids=old_ids,
        cooperative_sources=cooperative_sources,
        other_documents=other_documents,
        operations=operations,
        sync_at=prepared["sync_at"],
        dry_run=False,
    )


if __name__ == "__main__":
    main()
