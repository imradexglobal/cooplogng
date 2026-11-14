import fs from 'node:fs';
import path from 'node:path';
const p = path.resolve('src/services/bankStatement/importer.js');
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  "import { generateRemittanceId } from '../../utils/formatters.js';",
  "import { generateId, generateRemittanceId } from '../../utils/formatters.js';\nimport { buildTransferDetails } from '../data/duesTransfer.js';"
);
if (!s.includes("import { buildTransferDetails }")) throw new Error('Missing dues transfer import');
const helper = `
async function createStatementDuesChildren({ cooperativeId, parentId, memberId, memberName, date, status, actor, duesItems, savingsLines, enterprises }) {
    const validItems = (duesItems || []).filter(item => Math.abs(Number(item.amount) || 0) > 0 && item.enterprise_id);
    if (!validItems.length) return;
    const entById = new Map((enterprises || []).map(ent => [String(ent.id), ent]));
    for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        const amount = Math.abs(Number(item.amount) || 0);
        const id = \`${'${parentId}'}-DUE-\${String(i + 1).padStart(2, '0')}\`;
        await addRemittance({
            id, cooperative_id: String(cooperativeId), member_id: memberId, amount: -amount,
            remittance_date: date, bank_name: 'Internal Transfer', transaction_type: 'Internal Transfer',
            description: \`Auto Internal Charges (\${item.name || item.enterprise_id})\`, autogen: 1,
            loan_id: String(parentId), parent_remittance_id: String(parentId), status,
            details: [{ id: generateId(String(cooperativeId)), enterprise_id: String(item.enterprise_id), amount: -amount, notes: item.name || String(item.enterprise_id) }]
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
            id: \`${'${parentId}'}-INCOME-\${String(pickupIndex).padStart(2, '0')}\`,
            cooperative_id: String(cooperativeId), member_id: '0000000000', amount: total.amount,
            remittance_date: date, bank_name: 'Internal Transfer', transaction_type: entName,
            category: ent?.revenue ? 'Operating Income' : 'Member Liability',
            description: \`Auto \${entName} (Dues & Penalties) - \${memberName || memberId}\`, autogen: 1,
            loan_id: String(parentId), parent_remittance_id: String(parentId), status
        }, actor || 'system');
    }
    const transfer = buildTransferDetails({ savingsLines, duesItems: validItems, cooperativeId: String(cooperativeId) });
    if (transfer.total > 0 && transfer.details.length) {
        await addRemittance({
            id: \`${'${parentId}'}-TR-01\`, cooperative_id: String(cooperativeId), member_id: memberId,
            amount: 0, remittance_date: date, bank_name: 'Internal Transfer',
            transaction_type: 'Internal Transfer',
            description: \`Auto Dues Transfer (Savings → Dues & Penalties) - \${memberName || memberId}\`,
            autogen: 1, loan_id: String(parentId), parent_remittance_id: String(parentId), status,
            details: transfer.details
        }, actor || 'system');
    }
}
`;
if (!s.includes('async function createStatementDuesChildren')) {
  const anchor = /\*\/\r?\nexport async function commitStatementImport/;
  if (!anchor.test(s)) throw new Error('Importer function anchor not found');
  s = s.replace(anchor, '*/\n' + helper + '\nexport async function commitStatementImport');
}
const loopAnchor = /    for \(let i = 0; i < transactions\.length; i\+\+\) \{\r?\n        const txn = transactions\[i\];/;
const preflight = `    const dueEnterpriseIds = new Set((enterprises || []).filter(ent => ent.compulsory_due || ent.is_penalty).map(ent => String(ent.id)));
    const buildMemberDepositDetails = (txn) => {
        if (Array.isArray(txn.details) && txn.details.length) return txn.details;
        const memberAdvice = adviceCache.get(txn.memberId) || {};
        const memberBal = balanceCache.get(txn.memberId) || {};
        const autoResult = allocateAutoShare({ remittanceAmount: Math.abs(Number(txn.amount) || 0), enterprises, adviceByEnterprise: memberAdvice, balanceByEnterprise: memberBal });
        let details = (autoResult?.allocations || []).filter(a => Number(a.allocatedAmount) > 0).map(a => ({ enterprise_id: a.enterpriseId, amount: a.allocatedAmount, notes: a.reason || 'Auto Distributed' }));
        if (!details.length) {
            const savingsEnt = enterprises.find(e => String(e.account_type || '').toLowerCase() === 'savings');
            if (savingsEnt) details = [{ enterprise_id: savingsEnt.id, amount: Math.abs(Number(txn.amount) || 0), notes: 'Default Savings Deposit' }];
        }
        return details;
    };
    const duesValidationErrors = [];
    for (let i = 0; i < transactions.length; i++) {
        const txn = transactions[i];
        const decision = txn.importDuesDecision;
        if (txn.skipImport || txn.classification !== 'Remittance' || !txn.memberId || txn.memberId === '0000000000' || Number(txn.amount) <= 0 || !decision?.charge) continue;
        const items = (decision.items || []).filter(item => Number(item.amount) > 0);
        const totalDue = items.reduce((sum, item) => sum + Math.abs(Number(item.amount) || 0), 0);
        if (!(totalDue > 0)) continue;
        const details = buildMemberDepositDetails(txn);
        const savingsTotal = details.filter(d => Number(d.amount) > 0 && !dueEnterpriseIds.has(String(d.enterprise_id || d.item || ''))).reduce((sum, d) => sum + Math.abs(Number(d.amount) || 0), 0);
        if (totalDue > savingsTotal + 1e-9) duesValidationErrors.push({ row: i + 1, error: \`Compulsory dues/penalties (₦\${totalDue.toLocaleString()}) exceed this member's positive allocation (₦\${savingsTotal.toLocaleString()}). Reduce the charge or choose Don't Charge.\` });
    }
    if (duesValidationErrors.length) return { success: false, aborted: true, totalAttempted: transactions.filter(t => !t.skipImport).length, totalImported: 0, importedIds: [], importedRows: [], errors: duesValidationErrors };

`;
if (!s.includes('const duesValidationErrors = []')) {
  if (!loopAnchor.test(s)) throw new Error('Importer loop anchor not found');
  s = s.replace(loopAnchor, preflight + '    for (let i = 0; i < transactions.length; i++) {\n        const txn = transactions[i];');
}
const memberDetailsRe = /                let details = \[\];\r?\n                if \(txn\.details && txn\.details\.length > 0\) \{[\s\S]*?\r?\n                \}\r?\n\r?\n                remittanceData = \{/;
if (memberDetailsRe.test(s)) {
  s = s.replace(memberDetailsRe, '                const details = buildMemberDepositDetails(txn);\n\n                remittanceData = {');
}
// A member-loan request is always Pending, even when the importing user can approve ordinary remittances.
s = s.replace(/(transaction_type: 'Member Loan',[\s\S]*?cheque_number: refStr,\r?\n\s*)status,/, "$1status: 'Pending',");
const saveLine = /                const res = await addRemittance\(remittanceData, uploadedBy \|\| 'system'\);\r?\n                if \(res && res\.id\) \{\r?\n                    importedIds\.push\(res\.id\);/;
const saveWithDues = `                const res = await addRemittance(remittanceData, uploadedBy || 'system');
                if (res && res.id) {
                    const dueDecision = txn.importDuesDecision;
                    if (txn.classification === 'Remittance' && txn.memberId && txn.memberId !== '0000000000' && rawAmount > 0 && dueDecision?.charge) {
                        const dueItems = (dueDecision.items || []).filter(item => Number(item.amount) > 0);
                        const savingsLines = (remittanceData.details || []).filter(d => Number(d.amount) > 0 && !dueEnterpriseIds.has(String(d.enterprise_id || d.item || ''))).map(d => ({ enterprise_id: d.enterprise_id || d.item, amount: Math.abs(Number(d.amount) || 0) }));
                        await createStatementDuesChildren({ cooperativeId: coopId, parentId: stableId, memberId: txn.memberId, memberName: txn.memberName || txn.member_name || txn.memberId, date: dateStr, status: remittanceData.status || status, actor: uploadedBy || 'system', duesItems: dueItems, savingsLines, enterprises });
                    }
                    importedIds.push(res.id);`;
if (saveLine.test(s)) s = s.replace(saveLine, saveWithDues);
if (!s.includes('createStatementDuesChildren({ cooperativeId: coopId')) throw new Error('Could not attach dues child creation');
if (!s.includes("status: 'Pending'")) throw new Error('Member-loan Pending override missing');
if (!s.includes('duesValidationErrors.length')) throw new Error('Dues preflight missing');
fs.writeFileSync(p, s);
