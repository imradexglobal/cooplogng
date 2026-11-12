import { addRemittance } from '../data/remittances.js';
import { allocateAutoShare } from '../autoShare/index.js';
import { fetchMemberPaymentAdvise } from '../data/members.js';
import { buildAccountBalance } from '../data/balance.js';
import { saveDoc } from '../sqliteService.js';
import { generateId } from '../../utils/formatters.js';

/**
 * Commits reviewed statement transactions to the database as Pending remittances
 */
export async function commitStatementImport({
    transactions,
    cooperativeId,
    bankName,
    fileName,
    uploadedBy,
    enterprises = []
}) {
    const coopId = String(cooperativeId || '');
    const cleanBank = String(bankName || '').trim();
    const importedIds = [];
    const errors = [];

    // Pre-cache member advice and balances for members in this batch to speed up Auto Share
    const memberIds = Array.from(new Set(
        transactions
            .filter(t => t.memberId && t.memberId !== '0000000000' && t.classification === 'Remittance')
            .map(t => t.memberId)
    ));

    const adviceCache = new Map();
    const balanceCache = new Map();

    for (const mId of memberIds) {
        try {
            const adviceRows = await fetchMemberPaymentAdvise(mId).catch(() => []);
            const adviceMap = {};
            adviceRows.forEach(r => {
                if (r.enterprise_id && Number(r.amount) > 0) {
                    adviceMap[String(r.enterprise_id)] = Number(r.amount);
                }
            });
            adviceCache.set(mId, adviceMap);

            const bal = await buildAccountBalance(coopId, mId).catch(() => ({}));
            balanceCache.set(mId, bal?.summaryByEnterprise || {});
        } catch (_) {}
    }

    for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        if (txn.skipImport) continue;

        try {
            const rawAmount = Number(txn.amount || 0);
            const isNegative = rawAmount < 0;
            const absAmount = Math.abs(rawAmount);
            const dateStr = txn.date ? `${txn.date}T12:00:00.000Z` : new Date().toISOString();
            const originalDesc = String(txn.description || '').trim();
            const refStr = String(txn.reference || '').trim();
            const fullDesc = refStr ? `${originalDesc} [Ref: ${refStr}]` : originalDesc;

            let remittanceData = null;

            if (txn.classification === 'Remittance' && txn.memberId && txn.memberId !== '0000000000') {
                // 1. Confidently Identified Positive Member Remittance -> Run Auto Distribution
                let details = [];
                if (txn.details && txn.details.length > 0) {
                    details = txn.details;
                } else {
                    const memberAdvice = adviceCache.get(txn.memberId) || {};
                    const memberBal = balanceCache.get(txn.memberId) || {};
                    const autoResult = allocateAutoShare({
                        remittanceAmount: absAmount,
                        enterprises,
                        adviceByEnterprise: memberAdvice,
                        balanceByEnterprise: memberBal
                    });

                    if (autoResult && autoResult.allocations) {
                        details = autoResult.allocations
                            .filter(a => Number(a.allocatedAmount) > 0)
                            .map(a => ({
                                enterprise_id: a.enterpriseId,
                                amount: a.allocatedAmount,
                                notes: a.reason || 'Auto Distributed'
                            }));
                    }
                }

                // If no allocations generated, allocate 100% to first Savings enterprise
                if (details.length === 0) {
                    const savingsEnt = enterprises.find(e => String(e.account_type || '').toLowerCase() === 'savings');
                    if (savingsEnt) {
                        details.push({
                            enterprise_id: savingsEnt.id,
                            amount: absAmount,
                            notes: 'Default Savings Deposit'
                        });
                    }
                }

                remittanceData = {
                    cooperative_id: coopId,
                    member_id: txn.memberId,
                    amount: absAmount,
                    bank_name: cleanBank,
                    remittance_date: dateStr,
                    transaction_type: 'Member Deposit',
                    category: 'Member Liability',
                    description: fullDesc,
                    cheque_number: refStr,
                    status: 'Pending',
                    details
                };

            } else if (txn.classification === 'Loan' && txn.memberId && txn.memberId !== '0000000000') {
                // 2. Confidently Identified Negative Member Outflow -> Prepare Pending Loan Transaction
                // No loan child is created at this upload stage
                const loanEntId = txn.enterpriseId || (enterprises.find(e => String(e.account_type || '').toLowerCase() === 'loan')?.id || '');
                const details = [{
                    enterprise_id: loanEntId,
                    amount: -absAmount,
                    notes: txn.notes || 'Pending Member Loan Disbursement'
                }];

                remittanceData = {
                    cooperative_id: coopId,
                    member_id: txn.memberId,
                    amount: -absAmount,
                    bank_name: cleanBank,
                    remittance_date: dateStr,
                    transaction_type: 'Member Loan',
                    category: 'Loan Asset',
                    isLoanRequest: true,
                    description: fullDesc,
                    cheque_number: refStr,
                    status: 'Pending',
                    details
                };

            } else if (txn.classification === 'Expense') {
                // 3. Confirmed Expense
                remittanceData = {
                    cooperative_id: coopId,
                    member_id: '0000000000',
                    amount: -absAmount,
                    bank_name: cleanBank,
                    remittance_date: dateStr,
                    transaction_type: txn.transactionType || 'Financial & Banking Expenses',
                    category: txn.category || 'Finance Expense',
                    description: fullDesc,
                    cheque_number: refStr,
                    status: 'Pending'
                };

            } else if (txn.classification === 'Income') {
                // 4. Confirmed Income
                remittanceData = {
                    cooperative_id: coopId,
                    member_id: '0000000000',
                    amount: absAmount,
                    bank_name: cleanBank,
                    remittance_date: dateStr,
                    transaction_type: txn.transactionType || 'Other Income',
                    category: txn.category || 'Other Income',
                    description: fullDesc,
                    cheque_number: refStr,
                    status: 'Pending'
                };

            } else {
                // 5. Unknown Payment
                remittanceData = {
                    cooperative_id: coopId,
                    member_id: '0000000000',
                    amount: rawAmount,
                    bank_name: cleanBank,
                    remittance_date: dateStr,
                    transaction_type: 'Unknown Payments',
                    category: 'Member Liability',
                    description: txn.duplicateNote ? `${fullDesc} (${txn.duplicateNote})` : fullDesc,
                    cheque_number: refStr,
                    status: 'Pending'
                };
            }

            if (remittanceData) {
                const res = await addRemittance(remittanceData, uploadedBy || 'system');
                if (res && res.id) {
                    importedIds.push(res.id);
                }
            }
        } catch (err) {
            console.error(`[BankStatementImport] Failed to import row #${i + 1}:`, err);
            errors.push({ row: i + 1, error: err.message });
        }
    }

    // Save Statement Traceability History Record
    const historyRecord = {
        id: `statement-import-${Date.now()}`,
        cooperative_id: coopId,
        file_name: fileName || 'bank_statement',
        bank_name: cleanBank,
        uploaded_at: new Date().toISOString(),
        uploaded_by: uploadedBy || 'system',
        total_extracted: transactions.length,
        total_imported: importedIds.length,
        imported_ids: importedIds,
        status: errors.length === 0 ? 'Completed' : 'Partial'
    };

    try {
        await saveDoc('app_settings', {
            key: `bank_import_history:${historyRecord.id}`,
            payload: historyRecord,
            updated_at: new Date().toISOString()
        });
    } catch (_) {}

    return {
        success: true,
        totalImported: importedIds.length,
        importedIds,
        errors
    };
}
