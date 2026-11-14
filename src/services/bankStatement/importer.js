import { addRemittance } from '../data/remittances.js';
import { allocateAutoShare } from '../autoShare/index.js';
import { saveDoc, getDocById_Global, getRemittances, queryRows } from '../sqliteService.js';
import { generateRemittanceId } from '../../utils/formatters.js';
import { buildTransferDetails } from '../data/duesTransfer.js';

/**
 * Commits reviewed statement transactions with the caller-authorized status
 */

async function createStatementDuesChildren({ cooperativeId, parentId, memberId, memberName, date, status, actor, duesItems, savingsLines, enterprises }) {
    const validItems = (duesItems || []).filter(item => Math.abs(Number(item.amount) || 0) > 0 && item.enterprise_id);
    if (!validItems.length) return;
    const entById = new Map((enterprises || []).map(ent => [String(ent.id), ent]));
    for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const amount = Math.abs(Number(item.amount) || 0);
        const id = `${parentId}-DUE-${String(i + 1).padStart(2, '0')}`;
        await addRemittance({
            id, cooperative_id: String(cooperativeId), member_id: memberId, amount: -amount,
            remittance_date: date, bank_name: 'Internal Transfer', transaction_type: 'Internal Transfer',
            description: `Auto Internal Charges (${item.name || item.enterprise_id})`, autogen: 1,
            loan_id: String(parentId), parent_remittance_id: String(parentId), status,
            details: [{ id: `${id}-DETAIL-01`, enterprise_id: String(item.enterprise_id), amount: -amount, notes: item.name || String(item.enterprise_id) }]
        }, actor || 'system');
    }
    const grouped = new Map();
    validItems.forEach(item => {
        const key = String(item.enterprise_id);
        const current = grouped.get(key) || { enterprise_id: key, name: item.name || key, amount: 0 };
        current.amount += Math.abs(Number(item.amount) || 0);
        grouped.set(key, current);
    });
    let pickupIndex = 0;
    for (const [enterpriseId, total] of grouped) {
        pickupIndex++;
        const ent = entById.get(enterpriseId);
        const entName = ent?.account_name || total.name || enterpriseId;
        await addRemittance({
            id: `${parentId}-INCOME-${String(pickupIndex).padStart(2, '0')}`,
            cooperative_id: String(cooperativeId), member_id: '0000000000', amount: total.amount,
            remittance_date: date, bank_name: 'Internal Transfer', transaction_type: entName,
            category: ent?.revenue ? 'Operating Income' : 'Member Liability',
            description: `Auto ${entName} (Dues & Penalties) - ${memberName || memberId}`, autogen: 1,
            loan_id: String(parentId), parent_remittance_id: String(parentId), status
        }, actor || 'system');
    }
    const transfer = buildTransferDetails({ savingsLines, duesItems: validItems, cooperativeId: String(cooperativeId) });
    if (transfer.total > 0 && transfer.details.length) {
        const transferDetails = transfer.details.map((detail, index) => ({ ...detail, id: `${parentId}-TR-01-DETAIL-${String(index + 1).padStart(2, '0')}` }));
        await addRemittance({
            id: `${parentId}-TR-01`, cooperative_id: String(cooperativeId), member_id: memberId,
            amount: 0, remittance_date: date, bank_name: 'Internal Transfer',
            transaction_type: 'Internal Transfer',
            description: `Auto Dues Transfer (Savings → Dues & Penalties) - ${memberName || memberId}`,
            autogen: 1, loan_id: String(parentId), parent_remittance_id: String(parentId), status,
            details: transferDetails
        }, actor || 'system');
    }
}

export async function commitStatementImport({
    transactions,
    cooperativeId,
    bankName,
    fileName,
    uploadedBy,
    enterprises = [],
    status = 'Pending',
    onProgress = () => {}
}) {
    const coopId = String(cooperativeId || '');
    const cleanBank = String(bankName || '').trim();
    const importedIds = [];
    const importedRows = [];
    const errors = [];

    const reportProgress = (stage, current = 0, total = 0) => {
        try { onProgress({ stage, current, total }); } catch (_) {}
        if (!total || current === 1 || current === total || current % 25 === 0) {
            console.info(`[BankStatementImport] ${stage}${total ? ` (${current}/${total})` : ''}`);
        }
    };
    // Cache member advice and existing loan balances in bulk. Fetching a full
    // cooperative balance once per member was an O(members × remittances)
    // operation and could make the commit appear frozen on large imports.
    const memberIds = Array.from(new Set(
        transactions
            .filter(t => t.memberId && t.memberId !== '0000000000' && t.classification === 'Remittance')
            .map(t => String(t.memberId))
    ));

    const adviceCache = new Map();
    const balanceCache = new Map();
    reportProgress('Loading member payment advice', 0, memberIds.length);
    if (memberIds.length) {
        const memberSet = new Set(memberIds);
        const adviceRows = await queryRows('SELECT * FROM payment_advise WHERE is_deleted = 0').catch(() => []);
        for (const row of adviceRows || []) {
            const memberId = String(row.member_id || '');
            if (!memberSet.has(memberId) || !row.enterprise_id || Number(row.amount) <= 0) continue;
            const advice = adviceCache.get(memberId) || {};
            advice[String(row.enterprise_id)] = Number(row.amount);
            adviceCache.set(memberId, advice);
        }
        memberIds.forEach((id, index) => {
            if (!adviceCache.has(id)) adviceCache.set(id, {});
            reportProgress('Loading member payment advice', index + 1, memberIds.length);
        });
        const loanEnterpriseIds = new Set((enterprises || [])
            .filter(ent => String(ent.account_type || ent.type || '').toLowerCase() === 'loan')
            .map(ent => String(ent.id)));
        if (loanEnterpriseIds.size) {
            reportProgress('Reading existing loan balances');
            const existingRemittances = await getRemittances(coopId).catch(() => []);
            for (const remittance of existingRemittances || []) {
                const memberId = String(remittance.member_id || '');
                if (remittance.status !== 'Approved' || !memberSet.has(memberId)) continue;
                const balances = balanceCache.get(memberId) || {};
                for (const detail of remittance.details || []) {
                    const enterpriseId = String(detail.enterprise_id || detail.item || '');
                    if (!loanEnterpriseIds.has(enterpriseId)) continue;
                    balances[enterpriseId] = (Number(balances[enterpriseId]) || 0) + (Number(detail.amount) || 0);
                }
                balanceCache.set(memberId, balances);
            }
        }
    }
    reportProgress('Member data ready', memberIds.length, memberIds.length);

    const dueEnterpriseIds = new Set((enterprises || []).filter(ent => ent.compulsory_due || ent.is_penalty).map(ent => String(ent.id)));
    const buildMemberDepositDetails = async (txn) => {
        if (Array.isArray(txn.importDepositDetails) && txn.importDepositDetails.length) return txn.importDepositDetails;
        if (Array.isArray(txn.details) && txn.details.length) {
            txn.importDepositDetails = txn.details;
            return txn.importDepositDetails;
        }
        if (Number(txn.importAttemptCount) > 0 && txn.importRemittanceId) {
            const existing = await getDocById_Global('remittance', txn.importRemittanceId).catch(() => null);
            if (Array.isArray(existing?.details) && existing.details.length) {
                txn.importDepositDetails = existing.details;
                return txn.importDepositDetails;
            }
        }
        const memberAdvice = adviceCache.get(String(txn.memberId)) || {};
        const memberBal = balanceCache.get(String(txn.memberId)) || {};
        const autoResult = allocateAutoShare({ remittanceAmount: Math.abs(Number(txn.amount) || 0), enterprises, adviceByEnterprise: memberAdvice, balanceByEnterprise: memberBal });
        let details = (autoResult?.allocations || []).filter(a => Number(a.allocatedAmount) > 0).map(a => ({ enterprise_id: a.enterpriseId, amount: a.allocatedAmount, notes: a.reason || 'Auto Distributed' }));
        if (!details.length) {
            const savingsEnt = enterprises.find(e => String(e.account_type || '').toLowerCase() === 'savings');
            if (savingsEnt) details = [{ enterprise_id: savingsEnt.id, amount: Math.abs(Number(txn.amount) || 0), notes: 'Default Savings Deposit' }];
        }
        txn.importDepositDetails = details;
        return details;
    };
    const duesValidationErrors = [];
    reportProgress('Checking batch dues', 0, transactions.length);
    for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        reportProgress('Checking batch dues', i + 1, transactions.length);
        const decision = txn.importDuesDecision;
        if (txn.skipImport || txn.classification !== 'Remittance' || !txn.memberId || txn.memberId === '0000000000' || Number(txn.amount) <= 0 || !decision?.charge) continue;
        const items = (decision.items || []).filter(item => Number(item.amount) > 0);
        const totalDue = items.reduce((sum, item) => sum + Math.abs(Number(item.amount) || 0), 0);
        if (!(totalDue > 0)) continue;
        const details = await buildMemberDepositDetails(txn);
        const savingsTotal = details.filter(d => Number(d.amount) > 0 && !dueEnterpriseIds.has(String(d.enterprise_id || d.item || ''))).reduce((sum, d) => sum + Math.abs(Number(d.amount) || 0), 0);
        if (totalDue > savingsTotal + 1e-9) duesValidationErrors.push({ row: i + 1, error: `Compulsory dues/penalties (₦${totalDue.toLocaleString()}) exceed this member's positive allocation (₦${savingsTotal.toLocaleString()}). Reduce the charge or choose Don't Charge.` });
    }
    if (duesValidationErrors.length) return { success: false, aborted: true, totalAttempted: transactions.filter(t => !t.skipImport).length, totalImported: 0, importedIds: [], importedRows: [], errors: duesValidationErrors };

    for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        if (txn.skipImport) continue;
        reportProgress(`Saving statement row ${i + 1}`, i + 1, transactions.length);

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
                const details = await buildMemberDepositDetails(txn);

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
                    status,
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
                    status
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
                    status
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
                    status
                };
            }

            if (remittanceData) {
                const stableId = txn.importRemittanceId || generateRemittanceId(coopId, false, new Date());
                txn.importRemittanceId = stableId;
                remittanceData.id = stableId;
                if (Array.isArray(remittanceData.details)) {
                    remittanceData.details = remittanceData.details.map((detail, index) => ({
                        ...detail,
                        id: detail.id || `${stableId}-DETAIL-${String(index + 1).padStart(2, '0')}`
                    }));
                    txn.importDepositDetails = remittanceData.details;
                }
                txn.importAttemptCount = (Number(txn.importAttemptCount) || 0) + 1;
                const res = await addRemittance(remittanceData, uploadedBy || 'system');
                if (res && res.id) {
                    const dueDecision = txn.importDuesDecision;
                    if (txn.classification === 'Remittance' && txn.memberId && txn.memberId !== '0000000000' && rawAmount > 0 && dueDecision?.charge) {
                        const dueItems = (dueDecision.items || []).filter(item => Number(item.amount) > 0);
                        const savingsLines = (remittanceData.details || []).filter(d => Number(d.amount) > 0 && !dueEnterpriseIds.has(String(d.enterprise_id || d.item || ''))).map(d => ({ enterprise_id: d.enterprise_id || d.item, amount: Math.abs(Number(d.amount) || 0) }));
                        await createStatementDuesChildren({ cooperativeId: coopId, parentId: stableId, memberId: txn.memberId, memberName: txn.memberName || txn.member_name || txn.memberId, date: dateStr, status: remittanceData.status || status, actor: uploadedBy || 'system', duesItems: dueItems, savingsLines, enterprises });
                    }
                    importedIds.push(res.id);
                    importedRows.push(i);
                } else {
                    errors.push({ row: i + 1, error: 'Remittance save did not return a saved record ID.' });
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
        reportProgress('Saving import history');
        await saveDoc('app_settings', {
            key: `bank_import_history:${historyRecord.id}`,
            payload: historyRecord,
            updated_at: new Date().toISOString()
        });
    } catch (_) {}

    reportProgress('Import complete', importedRows.length, transactions.filter(t => !t.skipImport).length);
    return {
        success: true,
        totalAttempted: transactions.filter(t => !t.skipImport).length,
        totalImported: importedIds.length,
        importedIds,
        importedRows,
        errors
    };
}
