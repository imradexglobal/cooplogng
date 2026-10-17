import { queryRows } from '../sqliteService.js';
import { fetchAllMembers, fetchEnterprises } from '../dataService.js';
import { formatDate } from '../../utils/formatters.js';
import { selectMemberFields, memberFieldHeader, memberFieldValue } from './memberFields.js';

export async function getMemberListData(cooperativeId, user, filters = {}) {
    const { status } = filters;
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    const members = await fetchAllMembers(cooperativeId, user.username, isAdmin);

    let filtered = members;
    if (status && status !== 'All') {
        filtered = members.filter(m => m.status === status);
    }
    filtered = [...filtered].sort((a, b) => (parseInt(a.registration_no, 10) || 0) - (parseInt(b.registration_no, 10) || 0));

    // Headers and cell values come from the same ordered field list, so the
    // columns can never drift out of alignment with each other.
    const fields = selectMemberFields(filters.selectedFields);
    const headers = ['S/N', ...fields.map(memberFieldHeader)];

    const data = filtered.map((m, idx) => {
        const row = { 'S/N': idx + 1 };
        fields.forEach(f => { row[memberFieldHeader(f)] = memberFieldValue(f, m); });
        return row;
    });

    return { data, headers };
}

export async function getPaymentAdviseData(cooperativeId, user = null, filters = {}) {
    const status = filters.status || 'All';
    const enterpriseFilter = filters.enterprise || '';
    const isAdmin = !user || user.role === 'admin' || (user.permissions || '').includes('admin');

    const enterprises = await fetchEnterprises(cooperativeId, true);
    const byName = (a, b) => String(a.account_name || '').localeCompare(String(b.account_name || ''));
    const loans = enterprises.filter(e => (e.account_type || '').toLowerCase() === 'loan').sort(byName);
    const savings = enterprises.filter(e => (e.account_type || '').toLowerCase() === 'savings').sort(byName);
    const others = enterprises.filter(e => !loans.includes(e) && !savings.includes(e)).sort(byName);
    let orderedEnts = [...loans, ...savings, ...others];
    if (enterpriseFilter) orderedEnts = orderedEnts.filter(e => String(e.id) === String(enterpriseFilter));

    // The roster is read in JS rather than through a members join: the local
    // executor drops any member field that collides with a remittance column
    // (`is_deleted` among them), so SQL-side member filters never applied and
    // soft-deleted members leaked into this report. Filtering here also scopes
    // non-admin users to their own account managers.
    const roster = await fetchAllMembers(cooperativeId, isAdmin ? null : (user?.username ?? null), isAdmin);
    const memberById = new Map();
    roster.forEach(m => {
        if (m.is_deleted) return;
        if (status !== 'All' && String(m.status || '') !== status) return;
        memberById.set(String(m.id), m);
    });

    const rows = await queryRows(`
        SELECT member_id as id, enterprise_id, SUM(amount) as total
        FROM payment_advise
        WHERE cooperative_id = ? AND is_deleted = 0
        GROUP BY member_id, enterprise_id
    `, [String(cooperativeId)]);

    const entIds = new Set(orderedEnts.map(e => String(e.id)));
    const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const byMember = new Map();
    rows.forEach(r => {
        const mid = String(r.id);
        if (!memberById.has(mid)) return;
        const entId = String(r.enterprise_id);
        if (!entIds.has(entId)) return;
        const amt = round2(r.total);
        if (amt === 0) return;
        if (!byMember.has(mid)) byMember.set(mid, new Map());
        byMember.get(mid).set(entId, amt);
    });

    // Accounts nobody advises on only widen the matrix — drop them.
    const usedEntIds = new Set();
    byMember.forEach(ents => ents.forEach((_, entId) => usedEntIds.add(entId)));
    const activeEnts = orderedEnts.filter(e => usedEntIds.has(String(e.id)));

    const fullName = m => [m.last_name, m.first_name, m.middle_name].filter(Boolean).join(' ') || String(m.name || '');
    const regKey = m => {
        const n = parseFloat(m.registration_no);
        return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
    };
    const members = [...byMember.keys()]
        .map(mid => memberById.get(mid))
        .sort((a, b) => (regKey(a) - regKey(b))
            || String(a.registration_no || '').localeCompare(String(b.registration_no || ''))
            || fullName(a).localeCompare(fullName(b)));

    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    const headers = [
        'S/N',
        useSpecialId ? 'Member ID' : 'Reg No',
        'Member Name',
        'Status',
        ...activeEnts.map(e => e.account_name),
        'Total'
    ];

    const data = [];
    const entTotals = new Array(activeEnts.length).fill(0);
    let grandTotal = 0;

    members.forEach((m, idx) => {
        const regNo = m.registration_no != null ? String(m.registration_no) : '';
        const memberId = useSpecialId
            ? (m.special_id || regNo.padStart(4, '0'))
            : regNo.padStart(4, '0');
        const row = [idx + 1, memberId, fullName(m), m.status || 'Active'];
        const advices = byMember.get(String(m.id)) || new Map();
        let rowTotal = 0;

        activeEnts.forEach((ent, eIdx) => {
            const val = round2(advices.get(String(ent.id)) || 0);
            row.push(val);
            rowTotal = round2(rowTotal + val);
            entTotals[eIdx] = round2(entTotals[eIdx] + val);
        });

        row.push(rowTotal);
        grandTotal = round2(grandTotal + rowTotal);
        data.push(row);
    });

    if (data.length > 0) {
        data.push(['TOTAL', '', '', '', ...entTotals, grandTotal]);
    }

    const title = `Payment Advice as at ${formatDate(new Date())}`;
    // footerCount keeps the TOTAL row pinned below the preview row limit.
    return { data, headers, title, footerCount: data.length > 0 ? 1 : 0 };
}

export async function getMemberPerformanceAgingData(cooperativeId) {
    const members = await fetchAllMembers(cooperativeId, null, true);
    const enterprises = await fetchEnterprises(cooperativeId, true);
    const loans = enterprises.filter(e => (e.account_type || '').toLowerCase() === 'loan');

    const data = [];
    let idx = 1;
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';

    for (const member of members) {
        for (const loan of loans) {
            const sql = `
                SELECT r.remittance_date, rd.amount
                FROM remittance_detail rd
                JOIN remittance r ON rd.remittance_id = r.id
                WHERE rd.enterprise_id = ?
                  AND r.member_id = ?
                  AND r.status = 'Approved' AND r.is_deleted = 0 AND rd.is_deleted = 0
                ORDER BY r.remittance_date ASC, r.id ASC
            `;
            const results = await queryRows(sql, [loan.id, member.id]);

            // FIFO: repayments (positive) retire the oldest disbursement
            // (negative) lots first, so each surviving naira is aged from
            // when it was actually disbursed — not from the first ever loan.
            const lots = [];
            for (const row of results) {
                const amt = parseFloat(row.amount || 0);
                if (amt < -0.009) {
                    lots.push({ amt: -amt, date: new Date(row.remittance_date) });
                } else if (amt > 0.009) {
                    let pay = amt;
                    while (pay > 0.009 && lots.length > 0) {
                        const lot = lots[0];
                        const take = Math.min(lot.amt, pay);
                        lot.amt -= take;
                        pay -= take;
                        if (lot.amt <= 0.009) lots.shift();
                    }
                }
            }
            const outstanding = lots.reduce((s, l) => s + l.amt, 0);

            if (outstanding > 0.01) {
                const absOutstanding = outstanding;
                const nowMs = new Date().getTime();

                let bucket1 = 0;
                let bucket2 = 0;
                let bucket3 = 0;
                let bucket4 = 0;
                for (const lot of lots) {
                    const d = isNaN(lot.date.getTime()) ? new Date(nowMs) : lot.date;
                    const diffDays = Math.ceil(Math.abs(nowMs - d.getTime()) / (1000 * 60 * 60 * 24));
                    if (diffDays < 30) bucket1 += lot.amt;
                    else if (diffDays < 60) bucket2 += lot.amt;
                    else if (diffDays < 90) bucket3 += lot.amt;
                    else bucket4 += lot.amt;
                }

                const memberIdStr = useSpecialId ? (member.special_id || String(member.registration_no).padStart(4, '0')) : String(member.registration_no).padStart(4, '0');

                data.push([
                    idx++,
                    memberIdStr,
                    `${member.last_name || ''} ${member.first_name || ''} ${member.middle_name || ''}`.trim(),
                    member.status || 'Active',
                    loan.account_name,
                    bucket1 || '',
                    bucket2 || '',
                    bucket3 || '',
                    bucket4 || '',
                    absOutstanding
                ]);
            }
        }
    }

    const headers = ['S/N', useSpecialId ? 'Member ID' : 'Reg No', 'Member Name', 'Status', 'Loan Account', 'Current (<30)', '30-60 Days', '60-90 Days', 'Over 90 Days', 'Total Outstanding'];
    return { data, headers, title: 'Loan Aging Analysis Report' };
}

export async function getMemberMonthlyTransactionSummaryData(cooperativeId, user, fyLabel, transactionFilter = 'cr') {
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    const baseYear = fyLabel.includes('/') ? parseInt(fyLabel.split('/')[0]) : parseInt(fyLabel);

    const coop = await queryRows("SELECT coop_first_month FROM cooperatives WHERE id=?", [cooperativeId]);
    let startMonth = 1;
    if (coop[0]?.coop_first_month) {
        const parts = String(coop[0].coop_first_month).split('-');
        startMonth = parseInt(parts[1]);
    }

    const startDate = new Date(baseYear, startMonth - 1, 1);
    const months = [];
    let cur = new Date(startDate);
    for (let i = 0; i < 12; i++) {
        months.push({ year: cur.getFullYear(), month: cur.getMonth() + 1 });
        cur.setMonth(cur.getMonth() + 1);
    }

    const periodStartMs = new Date(baseYear, startMonth - 1, 1).getTime();
    const periodEndMs = new Date(baseYear, startMonth - 1, 1);
    periodEndMs.setMonth(periodEndMs.getMonth() + 12);
    periodEndMs.setDate(periodEndMs.getDate() - 1);
    periodEndMs.setHours(23, 59, 59, 999);

    const moLabels = months.map(m => new Date(m.year, m.month - 1, 1).toLocaleString('default', { month: 'short' }));
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    const headers = ['S/N', useSpecialId ? 'Member ID' : 'Reg No', ...moLabels, 'Total'];

    // Member status cannot be read through the remittance join: the local SQL
    // executor merges joined tables into one flat object and drops any member
    // field that collides with a remittance column, which `status` does. The
    // active roster is therefore built from the members table directly, which
    // also scopes rows to the current cooperative and the user's account
    // managers.
    const roster = await fetchAllMembers(cooperativeId, isAdmin ? null : user.username, isAdmin);
    const activeMembers = roster
        .filter(m => !m.is_deleted && String(m.status || '').toLowerCase() === 'active')
        .sort((a, b) => (a.registration_no || 0) - (b.registration_no || 0));

    const memberById = {};
    activeMembers.forEach(m => { memberById[String(m.id)] = m; });

    // The executor supports no CTEs, no date()/CAST() in WHERE and strips
    // aliases, so the query stays deliberately plain and every filter that
    // needs real date or numeric semantics is applied in JS below.
    const rows = await queryRows(
        `SELECT member_id, remittance_date, bank_name, amount
         FROM remittance_detail
         JOIN remittance ON remittance.id = remittance_detail.remittance_id
         WHERE remittance_detail.cooperative_id = ?
           AND remittance.status = 'Approved'
           AND remittance_detail.is_deleted = 0`,
        [String(cooperativeId)]
    );

    const byMember = {};
    rows.forEach(r => {
        const key = String(r.member_id);
        if (!(key in memberById)) return;

        if (String(r.bank_name || '').trim().toLowerCase() === 'internal transfer') return;

        const d = new Date(String(r.remittance_date || '').trim());
        if (isNaN(d.getTime())) return;
        if (d.getTime() < periodStartMs || d.getTime() > periodEndMs) return;

        const amt = parseFloat(r.amount) || 0;
        if (transactionFilter === 'cr' && !(amt > 0)) return;
        if (transactionFilter === 'dr' && !(amt < 0)) return;

        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!byMember[key]) byMember[key] = {};
        byMember[key][monthKey] = (byMember[key][monthKey] || 0) + amt;
    });

    const data = [];
    const monthTotals = new Array(12).fill(0);
    let grandTotal = 0;

    activeMembers.forEach((m, idx) => {
        const regNo = m.registration_no != null ? String(m.registration_no) : '';
        const memberId = useSpecialId ? (m.special_id || regNo.padStart(4, '0')) : regNo.padStart(4, '0');
        const row = [idx + 1, memberId];
        let rowTotal = 0;
        const monthsForMember = byMember[String(m.id)] || {};

        months.forEach((mo, i) => {
            const monthKey = `${mo.year}-${String(mo.month).padStart(2, '0')}`;
            const val = monthsForMember[monthKey] || 0;
            row.push(val);
            rowTotal += val;
            monthTotals[i] += val;
        });

        row.push(rowTotal);
        grandTotal += rowTotal;
        data.push(row);
    });

    if (data.length > 0) {
        const totalRow = ['TOTAL', '', ...monthTotals, grandTotal];
        data.push(totalRow);
    }

    const title = `Member Monthly Transaction Summary - ${fyLabel} Financial Year`;
    return { data, headers, title };
}

export async function getGeneralNetworthData(cooperativeId, user, dateTo) {
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';

    const allEnterprises = await fetchEnterprises(cooperativeId, true);
    // Dues & penalties count toward networth even when flagged as revenue
    // (member obligations, not pure cooperative income).
    const _isDuePenalty = (e) => {
        if (!e) return false;
        const due = e.compulsory_due == 1 || e.compulsory_due === '1' || e.compulsory_due === 'true' || e.compulsory_due === true;
        const pen = e.is_penalty == 1 || e.is_penalty === '1' || e.is_penalty === 'true' || e.is_penalty === true;
        return !!(due || pen);
    };
    const enterprises = allEnterprises.filter(e => {
        const isRevenue = e.revenue == 1 || e.revenue === '1' || e.revenue === 'true' || e.revenue === true;
        return (!isRevenue || _isDuePenalty(e)) && !e.is_deleted;
    });

    let sql = `
        SELECT r.member_id as id, m.registration_no, m.special_id,
               m.last_name, m.first_name, m.middle_name,
               rd.enterprise_id, SUM(rd.amount) as total
        FROM remittance_detail rd
        JOIN remittance r ON r.id = rd.remittance_id
        JOIN members m ON m.id = r.member_id
        WHERE rd.cooperative_id = ? AND r.status = 'Approved'
          AND r.is_deleted = 0 AND rd.is_deleted = 0 AND m.is_deleted = 0
          AND date(r.remittance_date) <= date(?)
    `;
    const bind = [String(cooperativeId), dateTo];

    if (!isAdmin) {
        sql += " AND LOWER(',' || REPLACE(IFNULL(m.account_manager, ''), ' ', '') || ',') LIKE LOWER('%,' || REPLACE(?, ' ', '') || ',%')";
        bind.push(user.username);
    }
    sql += " GROUP BY r.member_id, rd.enterprise_id";

    const rows = await queryRows(sql, bind);

    const byMember = {};
    const regMap = {};
    const specialIdMap = {};
    const nameMap = {};
    rows.forEach(r => {
        if (!byMember[r.id]) byMember[r.id] = {};
        byMember[r.id][r.enterprise_id] = r.total;
        regMap[r.id] = r.registration_no;
        specialIdMap[r.id] = r.special_id;
        if (!nameMap[r.id]) {
            nameMap[r.id] = [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ');
        }
    });

    const headers = [
        'S/N',
        'Account Number',
        'Full Name',
        ...enterprises.map(e => e.account_name),
        'Total'
    ];

    const data = [];
    const entTotals = new Array(enterprises.length).fill(0);
    const sortedIds = Object.keys(byMember).sort((a, b) => (regMap[a] || 0) - (regMap[b] || 0));

    sortedIds.forEach((mid, idx) => {
        const accountId = useSpecialId
            ? (specialIdMap[mid] || String(regMap[mid] || '').padStart(4, '0'))
            : String(regMap[mid] || '').padStart(4, '0');
        const row = [idx + 1, accountId, nameMap[mid] || ''];
        let rowTotal = 0;

        enterprises.forEach((ent, eIdx) => {
            const val = byMember[mid][ent.id] || 0;
            row.push(val);
            rowTotal += val;
            entTotals[eIdx] += val;
        });

        row.push(rowTotal);
        data.push(row);
    });

    if (data.length > 0) {
        // Footer sums every displayed column so column totals tie to row totals.
        const footerTotal = entTotals.reduce((a, b) => a + b, 0);
        data.push(['TOTAL', '', '', ...entTotals, footerTotal]);
    }

    const title = `Member Balances Summary As At ${formatDate(dateTo)}`;
    return { data, headers, title };
}
