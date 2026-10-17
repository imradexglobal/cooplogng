import { generateId, generateRemittanceId, escapeHtml, formatCurrency, shortRef } from '../../utils/formatters.js';
import { addRemittance } from '../../services/dataService.js';
import { getDocById_Global } from '../../services/sqliteService.js';
import { getAllByIndex } from '../../services/indexedDbService.js';
import { hasPermission } from '../../services/permissionService.js';
import { showToast } from '../../services/toastService.js';

// --- Reverse transaction(s): mirror a remittance group (parent + ALL autogen
// children, including the +ve admin 0000000000 enterprise-named pickup) with
// negated amounts. Multi-select cascades exactly like delete: the selected
// ids plus every descendant are collected first and each mirrored once.
// Mirrors are INDEPENDENT records (no loan_id back to the original group;
// children link to their own reversal parent), so later delete/decline of
// the original never touches them. loan_info is stripped from every mirrored
// detail so no duplicate loan records spawn. Loans-table rows and payment
// advice are not mirrored.
export async function showReverseModal(deps) {
    const { historyState, user, loadHistoryData } = deps;
    const ids = [...(historyState.selectedRemittanceIds || [])];
    if (!ids.length) { showToast('Select at least one transaction to reverse.', 'warning'); return; }

    const isActualAdmin = hasPermission(user.permissions, 'admin') || (user.username || '').toLowerCase() === 'admin';
    const canApprove = isActualAdmin || hasPermission(user.permissions, 'approve_remittance');
    const createdBy = user.role === 'member' ? 'self' : user.username;
    const status = canApprove ? 'Approved' : 'Pending';
    const today = new Date().toISOString().split('T')[0];
    const coopId = user.cooperativeId;

    // Header docs do NOT carry details (remittance_detail is a separate table
    // attached only in list fetches). Load live detail lines via the proven
    // index-read pattern (same as mutationEngine) for every record we mirror,
    // or the reversal would post header-only and leave enterprise balances
    // untouched.
    const notDeleted = (r) => !r || !r.is_deleted;
    const withDetails = async (doc) => {
        if (!doc) return doc;
        try {
            const rows = await getAllByIndex('remittance_detail', 'remittance_id', String(doc.id));
            doc.details = (rows || []).filter(notDeleted);
        } catch (e) { doc.details = doc.details || []; }
        return doc;
    };
    const liveChildrenOf = async (parentId) => {
        try {
            const rows = await getAllByIndex('remittance', 'loan_id', String(parentId));
            return (rows || []).filter(r => Number(r.autogen) === 1 && notDeleted(r));
        } catch (e) { return []; }
    };
    const liveLoansOf = async (parentId) => {
        try {
            const rows = await getAllByIndex('loans', 'remittance_id', String(parentId));
            return (rows || []).filter(notDeleted);
        } catch (e) { return []; }
    };

    // Walk an autogen child up to its family root (via the loan bridge or a
    // direct parent link), so selecting ANY family member reverses the whole
    // family. Guarded against cycles.
    const resolveRoot = async (doc) => {
        let cur = doc;
        const guard = new Set([String(doc.id)]);
        console.debug('[Reverse] resolveRoot start:', String(doc.id), 'autogen=', doc.autogen, 'loan_id=', doc.loan_id);
        while (cur && Number(cur.autogen) === 1 && cur.loan_id) {
            let parent = null;
            try {
                const loan = await getDocById_Global('loans', cur.loan_id).catch(() => null);
                if (loan && !loan.is_deleted && loan.remittance_id) {
                    parent = await getDocById_Global('remittance', loan.remittance_id).catch(() => null);
                } else if (!loan) {
                    parent = await getDocById_Global('remittance', cur.loan_id).catch(() => null);
                }
            } catch (e) { parent = null; }
            console.debug('[Reverse] walk-up from', String(cur.id), '-> parent:', parent ? String(parent.id) : null);
            if (!parent || parent.is_deleted || guard.has(String(parent.id))) break;
            guard.add(String(parent.id));
            cur = parent;
        }
        console.debug('[Reverse] resolveRoot end:', String(cur.id));
        return cur;
    };

    // Build groups (root + all descendants), deduped so overlapping selections
    // within one family mirror only once.
    const seen = new Set();
    const groups = [];
    for (const id of ids) {
        if (seen.has(String(id))) continue;
        let doc = null;
        try { doc = await getDocById_Global('remittance', id); } catch (e) { doc = null; }
        if (!doc || doc.is_deleted) continue;
        doc = await resolveRoot(doc);
        if (seen.has(String(doc.id))) continue;
        await withDetails(doc);
        // NOTE: the selected id is deliberately NOT pre-marked — when it is a
        // child, the sibling sweep below must still pick it up; the root mark
        // plus per-member marks already dedupe overlapping selections.
        seen.add(String(doc.id));
        const members = [{ doc, isParent: true }];
        // Direct autogen children (dues/penalty autos: loan_id = parent id)
        const direct = await liveChildrenOf(doc.id);
        // Loan-bridge children: loans of this parent + their charge autogens
        const bridged = [];
        try {
            const loans = await liveLoansOf(doc.id);
            for (const loan of loans || []) {
                bridged.push(...(await liveChildrenOf(loan.id)));
            }
        } catch (e) {}
        for (const kid of [...(direct || []), ...bridged]) {
            if (!kid || seen.has(String(kid.id))) continue;
            seen.add(String(kid.id));
            await withDetails(kid);
            members.push({ doc: kid, isParent: false });
        }
        console.debug('[Reverse] group root:', String(doc.id), 'members:', members.map(m => String(m.doc.id)));
        groups.push({ parent: doc, members });
    }
    if (!groups.length) { showToast('Nothing reversible in the selection.', 'warning'); return; }

    // Guard 1: a reversal itself can never be reversed (no mirror-of-mirror chains).
    for (const g of groups) {
        for (const m of g.members) {
            if (String(m.doc.description || '').startsWith('REVERSAL:')) {
                showToast(`Blocked: R-${shortRef(m.doc.id)} is itself a reversal and cannot be reversed.`, 'error');
                return;
            }
        }
    }
    // Guard 2: a group already reversed cannot be reversed again. Every mirror
    // carries `REVERSAL:<parent id> — ...`, so one coop scan settles it.
    // NOTE: mirrors created before receipt numbers were removed carry
    // `REVERSAL:<old 5-digit number>` markers and are NOT detected here —
    // do not re-reverse groups that were reversed before this update.
    try {
        const allRems = await getAllByIndex('remittance', 'cooperative_id', String(coopId));
        for (const g of groups) {
            const marker = `REVERSAL:${String(g.parent.id)} —`;
            const dup = (allRems || []).find(r => !r.is_deleted && String(r.description || '').startsWith(marker));
            if (dup) {
                showToast(`Blocked: R-${shortRef(g.parent.id)} was already reversed (${shortRef(dup.id)}).`, 'error');
                return;
            }
        }
    } catch (e) { console.warn('[Reverse] already-reversed scan failed:', e?.message); }


    const rowTotal = (g) => g.members.reduce((s, m) => s + Math.abs(parseFloat(m.doc.amount || 0)), 0);
    const lineCount = (g) => g.members.reduce((s, m) => s + ((m.doc.details || []).length), 0);

    document.getElementById('reverse-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'reverse-modal';
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center;';
    overlay.innerHTML = `
      <div class="modal-content" style="max-width: 560px; width: 94%; max-height: 88vh; display: flex; flex-direction: column; background: var(--bg-card); border-radius: var(--radius-md); box-shadow: var(--shadow-xl);">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--border-light);">
          <h3 style="margin: 0;">Reverse ${groups.length} transaction${groups.length === 1 ? '' : 's'}?</h3>
          <button type="button" id="reverse-close" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        <div style="padding: 1.1rem 1.25rem; overflow-y: auto;">
          <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--text-muted);">Each record below is mirrored with the opposite amount (dated today). Children — dues debits and the admin enterprise-named pickup included — are reversed with their parent. Originals stay untouched.</p>
          ${groups.map(g => `
            <div style="border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 0.6rem 0.8rem; margin-bottom: 0.5rem; font-size: 0.83rem;">
              <div style="font-weight: 700; color: var(--text-primary);">R-${shortRef(g.parent.id)} — ${escapeHtml(g.parent.description || g.parent.transaction_type || '')}</div>
              <div style="color: var(--text-muted); margin-top: 0.15rem;">${g.members.length} record${g.members.length === 1 ? '' : 's'} &bull; ${lineCount(g)} detail line${lineCount(g) === 1 ? '' : 's'} mirrored &bull; total ${formatCurrency(rowTotal(g))} &rarr; ${formatCurrency(-rowTotal(g))}</div>
            </div>
          `).join('')}
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.6rem; padding: 1rem 1.25rem; border-top: 1px solid var(--border-light);">
          <button type="button" id="reverse-cancel" class="btn btn-secondary">Cancel</button>
          <button type="button" id="reverse-confirm" class="btn btn-danger">Reverse</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#reverse-close').addEventListener('click', close);
    overlay.querySelector('#reverse-cancel').addEventListener('click', close);

    overlay.querySelector('#reverse-confirm').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Reversing...';
        let mirrored = 0;
        // generateRemittanceId is second-precision: timestamp-only ids would
        // collide across groups reversed in the same second (each saveDoc
        // upserting over the last). Batch tag + group index keeps all unique.
        const batchTag = Math.random().toString(36).slice(2, 6).toUpperCase();
        const baseRevId = generateRemittanceId(coopId);
        try {
            for (let gi = 0; gi < groups.length; gi++) {
                const g = groups[gi];
                const revParentId = `${baseRevId}-RV${batchTag}-${gi + 1}`;
                // Full parent id in the marker (unique + matches Guard 2 scan).
                const parentRid = String(g.parent.id);
                const mirrorDetails = (doc) => (doc.details || []).map(d => ({
                    id: generateId(String(coopId)),
                    enterprise_id: String(d.enterprise_id || d.item || ''),
                    amount: -1 * (parseFloat(d.amount || 0) || 0),
                    notes: d.notes || ''
                    // loan_info deliberately dropped: re-attaching it would
                    // spawn duplicate loan records via addRemittance derivation
                }));
                await addRemittance({
                    id: revParentId,
                    cooperative_id: coopId,
                    member_id: g.parent.member_id || '0000000000',
                    amount: -1 * (parseFloat(g.parent.amount || 0) || 0),
                    remittance_date: today,
                    bank_name: g.parent.bank_name || '',
                    transaction_type: g.parent.transaction_type || '',
                    description: `REVERSAL:${parentRid} — ${g.parent.description || g.parent.transaction_type || ''}`,
                    status,
                    user_role: user.role || 'member',
                    user_roles: [user.role || 'member'],
                    details: mirrorDetails(g.parent)
                }, createdBy);
                mirrored++;
                let ci = 0;
                for (const m of g.members) {
                    if (m.isParent) continue;
                    ci++;
                    await addRemittance({
                        id: `${revParentId}-RV${String(ci).padStart(2, '0')}`,
                        cooperative_id: coopId,
                        member_id: m.doc.member_id || '0000000000',
                        amount: -1 * (parseFloat(m.doc.amount || 0) || 0),
                        remittance_date: today,
                        bank_name: m.doc.bank_name || '',
                        transaction_type: m.doc.transaction_type || '',
                        description: `REVERSAL:${parentRid} — ${m.doc.description || m.doc.transaction_type || ''}`,
                        autogen: 1,
                        loan_id: revParentId,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        details: mirrorDetails(m.doc)
                    }, createdBy);
                    mirrored++;
                }
            }
            close();
            historyState.selectedRemittanceIds.clear();
            historyState.selectAll = false;
            try { await loadHistoryData(true); } catch (e) {}
            showToast(`Reversed: ${mirrored} record${mirrored === 1 ? '' : 's'} mirrored.`, 'success');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Reverse';
            showToast('Reverse failed: ' + (err?.message || err), 'error');
        }
    });
}
