import { queryRows } from '../sqliteService.js';
import { normalizeText } from './intelligence.js';

/**
 * Builds a lookup key for duplicate detection
 */
function makeKey(date, bank, amount, payerOrMemberId) {
    const d = String(date || '').slice(0, 10);
    const b = normalizeText(bank);
    const a = Math.abs(Number(amount) || 0).toFixed(2);
    const p = String(payerOrMemberId || '').toLowerCase().trim();
    return `${d}|${b}|${a}|${p}`;
}

/**
 * Checks extracted transactions against existing database remittances and within the current batch
 */
export async function detectDuplicates(transactions, { cooperativeId, bankName }) {
    if (!transactions || transactions.length === 0) return [];

    const coopId = String(cooperativeId || '');
    const cleanBank = String(bankName || '').trim();

    // Query all existing non-deleted remittances for this cooperative and bank
    const existingRemittances = await queryRows(`
        SELECT id, remittance_date, bank_name, amount, member_id, description, cheque_number, status, transaction_type
        FROM remittance
        WHERE cooperative_id = ?
          AND is_deleted = 0
    `, [coopId]).catch(() => []);

    // Build index of existing remittances
    const existingMap = new Map();
    const existingRefMap = new Map();

    for (const rem of existingRemittances) {
        const remDate = String(rem.remittance_date || '').slice(0, 10);
        const remAmt = Math.abs(parseFloat(rem.amount || 0)).toFixed(2);
        const remMember = String(rem.member_id || '');
        const key = `${remDate}|${normalizeText(rem.bank_name)}|${remAmt}|${remMember}`;

        if (!existingMap.has(key)) existingMap.set(key, []);
        existingMap.get(key).push(rem);

        // Also index by bank reference/cheque number if present
        const ref = String(rem.cheque_number || '').trim().toLowerCase();
        if (ref && ref.length >= 4) {
            existingRefMap.set(ref, rem);
        }
        // Also look for ref in description
        const desc = String(rem.description || '').toLowerCase();
        if (desc) {
            existingRefMap.set(`${remDate}|${remAmt}|${desc}`, rem);
        }
    }

    // Intra-batch frequency tracker
    const batchKeyCounts = new Map();
    const batchRefCounts = new Map();

    // Analyze each transaction
    return transactions.map((txn, index) => {
        const txnDate = String(txn.date || '').slice(0, 10);
        const txnAmt = Math.abs(Number(txn.amount) || 0).toFixed(2);
        const txnMemberId = String(txn.memberId || '0000000000');
        const key = `${txnDate}|${normalizeText(cleanBank)}|${txnAmt}|${txnMemberId}`;
        const ref = String(txn.reference || '').trim().toLowerCase();

        let duplicateStatus = 'New';
        let matchedExisting = null;
        let duplicateNote = '';

        // 1. Check exact reference match against existing DB records
        if (ref && existingRefMap.has(ref)) {
            matchedExisting = existingRefMap.get(ref);
            duplicateStatus = 'Confirmed Duplicate';
            duplicateNote = `Exact bank reference match with existing transaction #${matchedExisting.id} (${matchedExisting.status}).`;
        }
        // 2. Check exact Date + Bank + Amount + Member in DB
        else if (existingMap.has(key)) {
            const matches = existingMap.get(key);
            matchedExisting = matches[0];
            const isExactDesc = matches.some(m => normalizeText(m.description) === normalizeText(txn.description));
            
            if (isExactDesc && matches.length >= 1) {
                duplicateStatus = 'Confirmed Duplicate';
                duplicateNote = `Identical date, bank, amount, member and narration matches existing transaction #${matchedExisting.id} (${matchedExisting.status}).`;
            } else {
                duplicateStatus = 'Possible Duplicate';
                duplicateNote = `Similar transaction already exists in database with matching Date, Bank, Amount and Member (Transaction #${matchedExisting.id}, status: ${matchedExisting.status}).`;
            }
        }

        // 3. Check for repeated items within the CURRENT batch
        const prevBatchCount = batchKeyCounts.get(key) || 0;
        batchKeyCounts.set(key, prevBatchCount + 1);

        if (ref) {
            const prevRefCount = batchRefCounts.get(ref) || 0;
            batchRefCounts.set(ref, prevRefCount + 1);
            if (prevRefCount > 0 && duplicateStatus === 'New') {
                duplicateStatus = 'Confirmed Duplicate';
                duplicateNote = `Repeated bank reference (${txn.reference}) appeared ${prevRefCount + 1} times in this upload.`;
            }
        }

        if (prevBatchCount > 0 && duplicateStatus === 'New') {
            duplicateStatus = 'Possible Duplicate';
            duplicateNote = `Another transaction with the same Date, Bank, Amount and Member appeared earlier in this statement file (Row ${prevBatchCount}). Review to confirm if this is a legitimate repeated transaction.`;
        }

        return {
            ...txn,
            duplicateStatus,
            matchedExistingId: matchedExisting ? matchedExisting.id : null,
            duplicateNote
        };
    });
}
