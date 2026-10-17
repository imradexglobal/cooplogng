import { queryRows } from '../sqliteService.js';
import { fetchEnterprises } from '../dataService.js';
import { formatDate, shortRef } from '../../utils/formatters.js';

export async function getRemittanceListData(cooperativeId, user, filters = {}) {
    const { dateFrom, dateTo, bank, transactionType } = filters;
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');

    let sql = `
        SELECT r.id, r.member_id, r.remittance_date, m.last_name, m.first_name, m.middle_name, m.registration_no, m.special_id, r.amount, r.bank_name, r.transaction_type, r.description, r.category, r.created_by
        FROM remittance r
        LEFT JOIN members m ON r.member_id = m.id
        WHERE r.cooperative_id = ? AND r.is_deleted = 0 AND r.status = 'Approved'
    `;
    const bind = [cooperativeId];

    if (dateFrom) {
        sql += " AND date(r.remittance_date) >= date(?)";
        bind.push(dateFrom);
    }
    if (dateTo) {
        sql += " AND date(r.remittance_date) <= date(?)";
        bind.push(dateTo);
    }
    if (bank && bank !== 'All') {
        sql += " AND r.bank_name = ?";
        bind.push(bank);
    }
    if (transactionType && transactionType !== 'All') {
        sql += " AND r.transaction_type = ?";
        bind.push(transactionType);
    }

    if (!isAdmin) {
        sql += ` AND (
            m.member_id = '0000000000' 
            OR EXISTS (
                SELECT 1 FROM members m2 
                WHERE m2.id = r.member_id 
                AND LOWER(',' || REPLACE(IFNULL(m2.account_manager, ''), ' ', '') || ',') LIKE LOWER('%,' || REPLACE(?, ' ', '') || ',%')
            )
        )`;
        bind.push(user.username);
    }

    sql += " ORDER BY r.remittance_date ASC, r.created_at ASC, r.id ASC";

    const rows = await queryRows(sql, bind);
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    const headers = ["ID", "Date", useSpecialId ? "Member ID" : "Reg No", "Member Name", "Amount", "Bank", "Transaction Type", "Category", "Posted By", "Description"];
    const data = rows.map(r => [
        shortRef(r.id),
        formatDate(r.remittance_date),
        useSpecialId && r.special_id ? r.special_id : (r.registration_no ? String(r.registration_no).padStart(4, '0') : ''),
        memberLabel(r),
        Number(r.amount) || 0,
        r.bank_name || '',
        r.transaction_type || '',
        r.category || '',
        r.created_by || '',
        r.description || ''
    ]);

    // Journal footer: a running journal is only auditable against a total.
    let footerCount = 0;
    if (rows.length > 0) {
        const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        data.push(['', '', '', `TOTAL (${rows.length} transaction${rows.length === 1 ? '' : 's'})`, total, '', '', '', '', '']);
        footerCount = 1;
    }

    return { data, headers, footerCount };
}

// Coop-wide system postings (member 0000000000) belong to the cooperative
// itself, not to a person called Admin.
function memberLabel(r) {
    if (String(r.member_id || '') === '0000000000') return 'Cooperative';
    return [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ') || 'Admin';
}

export async function getRemittanceScheduleData(cooperativeId, user, month, year, positive, options = {}) {
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    const signOp = positive ? ">" : "<";
    const showMemberName = options.showMemberName !== false;

    const lastDay = new Date(year, month, 0).getDate();
    const dFrom = `${year}-${String(month).padStart(2, '0')}-01`;
    const dTo = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const enterprises = await fetchEnterprises(cooperativeId, true);
    const loans = enterprises.filter(e => (e.account_type || '').toLowerCase() === 'loan').sort((a, b) => a.account_name.localeCompare(b.account_name));
    const savings = enterprises.filter(e => (e.account_type || '').toLowerCase() === 'savings').sort((a, b) => a.account_name.localeCompare(b.account_name));
    const others = enterprises.filter(e => !loans.includes(e) && !savings.includes(e)).sort((a, b) => a.account_name.localeCompare(b.account_name));
    const orderedEnts = [...loans, ...savings, ...others];

    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    const headers = [
        "S/N",
        useSpecialId ? "Member ID" : "Reg No",
        ...(showMemberName ? ["Member Name"] : []),
        ...orderedEnts.map(e => e.account_name),
        "Total"
    ];

    let sql = `
        SELECT r.member_id as id, m.registration_no, m.special_id,
               m.last_name, m.first_name, m.middle_name,
               rd.enterprise_id, SUM(rd.amount) as total
        FROM remittance_detail rd
        JOIN remittance r ON r.id = rd.remittance_id
        JOIN members m ON m.id = r.member_id
        WHERE rd.cooperative_id = ? AND r.status = 'Approved'
          AND r.is_deleted = 0 AND rd.is_deleted = 0 AND m.is_deleted = 0
          AND r.remittance_date >= date(?) AND r.remittance_date <= date(?)
          AND rd.amount ${signOp} 0
    `;
    const bind = [cooperativeId, dFrom, dTo];

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

    const data = [];
    const entTotals = new Array(orderedEnts.length).fill(0);
    const sortedIds = Object.keys(byMember).sort((a, b) => (regMap[a] || 0) - (regMap[b] || 0));

    sortedIds.forEach((mid, idx) => {
        const memberId = useSpecialId ? (specialIdMap[mid] || String(regMap[mid] || '').padStart(4, '0')) : String(regMap[mid] || '').padStart(4, '0');
        const row = [idx + 1, memberId, ...(showMemberName ? [nameMap[mid] || ''] : [])];
        let rowTotal = 0;
        orderedEnts.forEach((ent, eIdx) => {
            const val = byMember[mid][ent.id] || 0;
            row.push(val);
            rowTotal += val;
            entTotals[eIdx] += val;
        });
        row.push(rowTotal);
        data.push(row);
    });

    if (data.length > 0) {
        const totalRow = ["TOTAL", "", ...(showMemberName ? [""] : []), ...entTotals, entTotals.reduce((a, b) => a + b, 0)];
        data.push(totalRow);
    }

    return { data, headers };
}

export async function getEODReportData(cooperativeId, dateFrom, dateTo) {
    const sql = `
        SELECT 
            r.id,
            r.remittance_date,
            r.member_id,
            m.last_name,
            m.first_name,
            m.middle_name,
            m.registration_no,
            m.special_id,
            e.account_name,
            rd.amount,
            r.transaction_type,
            r.bank_name,
            r.description,
            r.created_at
        FROM remittance r
        JOIN remittance_detail rd ON r.id = rd.remittance_id
        LEFT JOIN members m ON r.member_id = m.id
        LEFT JOIN enterprise e ON rd.enterprise_id = e.id
        WHERE r.cooperative_id = ? 
        AND r.status = 'Approved'
        AND r.is_deleted = 0
        AND rd.is_deleted = 0
        AND r.bank_name != 'Internal Transfer'
        AND date(r.remittance_date) >= date(?)
        AND date(r.remittance_date) <= date(?)
        ORDER BY r.created_at ASC
    `;
    const rows = await queryRows(sql, [cooperativeId, dateFrom, dateTo]);

    let totalDeposits = 0;
    let totalWithdrawals = 0;
    const bankSummary = {};

    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';

    const data = rows.map((row, idx) => {
        const amount = Number(row.amount) || 0;
        const bank = row.bank_name || 'N/A';
        // Coop-wide system pickups (member 0000000000) are the cooperative's
        // own postings, not a person called Admin.
        const memberLabel = String(row.member_id || '') === '0000000000'
            ? 'Cooperative'
            : ([row.last_name, row.first_name, row.middle_name].filter(Boolean).join(' ') || 'Admin');

        if (amount > 0) {
            totalDeposits += amount;
            if (!bankSummary[bank]) bankSummary[bank] = { deposits: 0, withdrawals: 0 };
            bankSummary[bank].deposits += amount;
        } else {
            totalWithdrawals += Math.abs(amount);
            if (!bankSummary[bank]) bankSummary[bank] = { deposits: 0, withdrawals: 0 };
            bankSummary[bank].withdrawals += Math.abs(amount);
        }

        return [
            idx + 1,
            formatDate(row.remittance_date),
            useSpecialId ? (row.special_id || (row.registration_no ? String(row.registration_no).padStart(4, '0') : 'N/A')) : (row.registration_no ? String(row.registration_no).padStart(4, '0') : 'N/A'),
            memberLabel,
            row.account_name || 'N/A',
            row.transaction_type || 'N/A',
            bank,
            amount,
            row.description || ''
        ];
    });

    data.push([]);
    data.push(['', '', '', '', '', '', '', '', '']);
    data.push(['BANK SUMMARY', '', '', '', '', '', '', '', '']);
    data.push(['Bank', 'Deposits', 'Withdrawals', 'Total', '', '', '', '', '']);

    Object.keys(bankSummary).sort().forEach(bank => {
        const { deposits, withdrawals } = bankSummary[bank];
        data.push([bank, deposits, withdrawals, deposits - withdrawals, '', '', '', '', '']);
    });

    data.push(['', '', '', '', '', '', '', '', '']);
    data.push(['TOTAL DEPOSITS', totalDeposits, '', '', '', '', '', '', '']);
    data.push(['TOTAL WITHDRAWALS', totalWithdrawals, '', '', '', '', '', '', '']);
    data.push(['NET TOTAL', totalDeposits - totalWithdrawals, '', '', '', '', '', '', '']);

    const headers = ['S/N', 'Date', useSpecialId ? 'Member ID' : 'Reg No', 'Member', 'Account', 'Type', 'Bank', 'Amount', 'Description'];
    const title = dateFrom === dateTo
        ? `Daily Transactions Summary - ${formatDate(dateFrom)}`
        : `Daily Transactions Summary - ${formatDate(dateFrom)} to ${formatDate(dateTo)}`;
    return { data, headers, title };
}
