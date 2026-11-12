import { normalizeText } from './intelligence.js';

/**
 * Builds a lookup key for a saved transaction.
 */
function makeKey(date, bank, amount, memberId) {
    const d = String(date || '').slice(0, 10);
    const b = normalizeText(bank);
    const a = Math.abs(Number(amount) || 0).toFixed(2);
    const m = String(memberId || '0000000000').toLowerCase().trim();
    return `${d}|${b}|${a}|${m}`;
}

/**
 * Checks statement rows only against saved remittances supplied from the database.
 * Rows in the current statement are never indexed against one another.
 */
export function detectAgainstSavedRemittances(transactions, { existingRemittances = [], bankName = '' } = {}) {
    if (!transactions || transactions.length === 0) return [];

    const existingMap = new Map();
    const existingRefMap = new Map();
    const cleanBank = String(bankName || '').trim();

    for (const rem of existingRemittances || []) {
        const key = makeKey(rem.remittance_date, rem.bank_name, rem.amount, rem.member_id);
        if (!existingMap.has(key)) existingMap.set(key, []);
        existingMap.get(key).push(rem);

        const ref = String(rem.cheque_number || '').trim().toLowerCase();
        if (ref && ref.length >= 4) {
            existingRefMap.set(ref, rem);
        }
    }

    return transactions.map(txn => {
        const key = makeKey(txn.date, cleanBank, txn.amount, txn.memberId);
        const ref = String(txn.reference || '').trim().toLowerCase();

        let duplicateStatus = 'New';
        let matchedExisting = null;
        let duplicateNote = '';

        if (ref && existingRefMap.has(ref)) {
            matchedExisting = existingRefMap.get(ref);
            duplicateStatus = 'Confirmed Duplicate';
            duplicateNote = `Exact bank reference match with existing transaction #${matchedExisting.id} (${matchedExisting.status}).`;
        } else if (existingMap.has(key)) {
            const matches = existingMap.get(key);
            matchedExisting = matches[0];
            const isExactDesc = matches.some(m => normalizeText(m.description) === normalizeText(txn.description));

            if (isExactDesc) {
                duplicateStatus = 'Confirmed Duplicate';
                duplicateNote = `Identical date, bank, amount, member and narration matches existing transaction #${matchedExisting.id} (${matchedExisting.status}).`;
            } else {
                duplicateStatus = 'Possible Duplicate';
                duplicateNote = `Similar transaction already exists in the database with matching date, bank, amount and member (Transaction #${matchedExisting.id}, status: ${matchedExisting.status}).`;
            }
        }

        return {
            ...txn,
            duplicateStatus,
            matchedExistingId: matchedExisting ? matchedExisting.id : null,
            duplicateNote
        };
    });
}

/**
 * Checks extracted transactions against non-deleted remittances already saved for this cooperative.
 */
export async function detectDuplicates(transactions, { cooperativeId, bankName }) {
    if (!transactions || transactions.length === 0) return [];

    const coopId = String(cooperativeId || '');
    const { queryRows } = await import('../sqliteService.js');
    const existingRemittances = await queryRows(`
        SELECT id, remittance_date, bank_name, amount, member_id, description, cheque_number, status, transaction_type
        FROM remittance
        WHERE cooperative_id = ?
          AND is_deleted = 0
    `, [coopId]).catch(() => []);

    return detectAgainstSavedRemittances(transactions, {
        existingRemittances,
        bankName
    });
}
