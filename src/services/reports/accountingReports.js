import { queryRows } from '../sqliteService.js';
import { fetchEnterprises } from '../dataService.js';
import { formatDate } from '../../utils/formatters.js';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function memberNameOf(row) {
    return [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(' ');
}

function toSqlDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextDaySql(dateStr) {
    const parts = String(dateStr).split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return String(dateStr);
    return toSqlDate(new Date(parts[0], parts[1] - 1, parts[2] + 1));
}

function sum(values) {
    return round2(values.reduce((s, v) => s + v, 0));
}

export async function getEnterpriseAccountData(cooperativeId, user, options = {}) {
    const {
        enterpriseId,
        fyLabel = '',
        showMemberName = false,
        includeInactive = false,
        dateFrom = '',
        dateTo = '',
        useSpecialId = false
    } = options;

    const baseTitle = 'Member Remittance Record (by Account)';
    const emptyResult = { data: [], headers: [], title: baseTitle };
    if (!enterpriseId) return emptyResult;
    if (dateFrom && dateTo && dateFrom > dateTo) return emptyResult;

    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    const baseYear = parseInt(fyLabel.includes('/') ? fyLabel.split('/')[0] : fyLabel, 10);
    if (!Number.isFinite(baseYear)) return emptyResult;

    const coop = await queryRows("SELECT coop_first_month FROM cooperatives WHERE id=?", [cooperativeId]);
    let startMonth = 1;
    if (coop[0]?.coop_first_month) {
        const parts = String(coop[0].coop_first_month).split('-');
        startMonth = parseInt(parts[1], 10) || 1;
    }

    const fiscalStart = new Date(baseYear, startMonth - 1, 1);
    const months = [];
    let cursor = new Date(fiscalStart);
    for (let i = 0; i < 12; i++) {
        months.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
        cursor.setMonth(cursor.getMonth() + 1);
    }
    const fiscalStartStr = toSqlDate(fiscalStart);
    const fiscalEndStr = toSqlDate(cursor);
    const fiscalLastStr = toSqlDate(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1));

    const rangeStartStr = dateFrom && dateFrom > fiscalStartStr ? dateFrom : fiscalStartStr;
    const rangeEndStr = dateTo && nextDaySql(dateTo) < fiscalEndStr ? nextDaySql(dateTo) : fiscalEndStr;

    const headers = [useSpecialId ? "Member ID" : "Reg No"];
    if (showMemberName) headers.push("Member Name");
    headers.push("Type", "Bal B/F", ...months.map(m => MONTH_LABELS[m.month - 1]), "Total");

    const managerFilter = isAdmin
        ? ''
        : " AND LOWER(',' || REPLACE(IFNULL(m.account_manager, ''), ' ', '') || ',') LIKE LOWER('%,' || REPLACE(?, ' ', '') || ',%')";
    const joins = `
        FROM remittance_detail rd
        JOIN remittance r ON r.id = rd.remittance_id
        JOIN members m ON m.id = r.member_id
        WHERE rd.cooperative_id = ? AND rd.enterprise_id = ? AND r.status = 'Approved'
          AND r.is_deleted = 0 AND rd.is_deleted = 0 AND m.is_deleted = 0`;

    const bbfBind = [cooperativeId, enterpriseId, rangeStartStr];
    const rangeBind = [cooperativeId, enterpriseId, rangeStartStr, rangeEndStr];
    if (!isAdmin) {
        bbfBind.push(user.username);
        rangeBind.push(user.username);
    }

    const [bbfRows, rangeRows] = await Promise.all([
        queryRows(
            `SELECT r.member_id as id, m.registration_no, m.special_id, m.first_name, m.middle_name, m.last_name,
                    SUM(rd.amount) as amt
             ${joins}
               AND date(r.remittance_date) < date(?)
             ${managerFilter}
             GROUP BY r.member_id`,
            bbfBind
        ),
        queryRows(
            `SELECT r.member_id, m.registration_no, m.special_id, m.first_name, m.middle_name, m.last_name,
                    r.remittance_date, rd.amount
             ${joins}
               AND date(r.remittance_date) >= date(?) AND date(r.remittance_date) < date(?)`,
            rangeBind
        )
    ]);

    const meta = {};
    const remember = (row, id) => {
        if (id === undefined || id === null || meta[id]) return;
        meta[id] = { reg: row.registration_no, special: row.special_id, name: memberNameOf(row) };
    };

    const bbfMap = {};
    bbfRows.forEach(row => {
        remember(row, row.id);
        bbfMap[row.id] = round2((bbfMap[row.id] || 0) + (Number(row.amt) || 0));
    });

    const monthIndex = new Map(months.map((m, i) => [`${m.year}-${String(m.month).padStart(2, '0')}`, i]));
    const perMonth = months.map(() => ({}));
    rangeRows.forEach(row => {
        const id = row.member_id;
        remember(row, id);
        const idx = monthIndex.get(String(row.remittance_date || '').slice(0, 7));
        if (idx === undefined) return;
        const amount = Number(row.amount) || 0;
        if (amount === 0) return;
        const cell = perMonth[idx][id] || (perMonth[idx][id] = { cr: 0, dr: 0 });
        if (amount > 0) cell.cr = round2(cell.cr + amount);
        else cell.dr = round2(cell.dr - amount);
    });

    if (includeInactive) {
        const rosterSql = `
            SELECT id, registration_no, special_id, first_name, middle_name, last_name
            FROM members
            WHERE cooperative_id = ? AND is_deleted = 0
              ${managerFilter.replace(/m\./g, '')}`;
        const rosterBind = [cooperativeId];
        if (!isAdmin) rosterBind.push(user.username);
        const roster = await queryRows(rosterSql, rosterBind);
        roster.forEach(row => remember(row, row.id));
    }

    const displayIds = {};
    Object.keys(meta).forEach(id => {
        displayIds[id] = useSpecialId
            ? (meta[id].special || String(meta[id].reg || '').padStart(4, '0'))
            : String(meta[id].reg || '').padStart(4, '0');
    });

    const sortedIds = Object.keys(meta).sort((a, b) =>
        String(displayIds[a]).localeCompare(String(displayIds[b]), undefined, { numeric: true, sensitivity: 'base' })
    );

    const data = [];
    const totalsDr = new Array(12).fill(0);
    const totalsCr = new Array(12).fill(0);
    const totalsBl = new Array(12).fill(0);
    let totalBbf = 0;

    for (const id of sortedIds) {
        const bbf = round2(bbfMap[id] || 0);
        let bl = bbf;
        let hasActivity = false;
        const drVals = [];
        const crVals = [];
        const blVals = [];

        for (let i = 0; i < 12; i++) {
            const cell = perMonth[i][id];
            const cr = cell ? round2(cell.cr) : 0;
            const dr = cell ? round2(cell.dr) : 0;
            if (cr !== 0 || dr !== 0) hasActivity = true;
            bl = round2(bl + cr - dr);
            drVals.push(dr);
            crVals.push(cr);
            blVals.push(bl);
        }

        if (!includeInactive && !hasActivity && Math.abs(bl) < 0.01) continue;

        for (let i = 0; i < 12; i++) {
            totalsDr[i] = round2(totalsDr[i] + drVals[i]);
            totalsCr[i] = round2(totalsCr[i] + crVals[i]);
            totalsBl[i] = round2(totalsBl[i] + blVals[i]);
        }
        totalBbf = round2(totalBbf + bbf);

        const lead = [displayIds[id], showMemberName ? meta[id].name : ''];
        const blank = showMemberName ? ['', ''] : [''];
        data.push(
            [...(showMemberName ? lead : [lead[0]]), "DR", null, ...drVals, sum(drVals)],
            [...blank, "CR", null, ...crVals, sum(crVals)],
            [...blank, "BL", bbf, ...blVals, bl]
        );
    }

    if (data.length > 0) {
        const totalLead = showMemberName ? ['TOTAL', ''] : ['TOTAL'];
        data.push(
            [...totalLead, "DR", null, ...totalsDr, sum(totalsDr)],
            [...totalLead, "CR", null, ...totalsCr, sum(totalsCr)],
            [...totalLead, "BL", totalBbf, ...totalsBl, totalsBl[11]]
        );
    }

    const enterprises = await fetchEnterprises(cooperativeId, true);
    const entName = enterprises.find(e => e.id === enterpriseId)?.account_name || 'Enterprise';
    let title = `${entName} REMITTANCE RECORD FOR ${fyLabel} FINANCIAL YEAR`;
    if (dateFrom || dateTo) {
        const fromStr = dateFrom || fiscalStartStr;
        const toStr = dateTo || fiscalLastStr;
        title += ` (${formatDate(fromStr)} to ${formatDate(toStr)})`;
    }

    return { data, headers, title, footerCount: data.length > 0 ? 3 : 0 };
}

export async function getPersonalLedgerData(cooperativeId, memberId) {
    const sql = `
        SELECT 
            r.id as remittance_id,
            r.remittance_date,
            e.account_name,
            e.account_type,
            rd.amount,
            r.transaction_type,
            r.description
        FROM remittance r
        JOIN remittance_detail rd ON r.id = rd.remittance_id
        LEFT JOIN enterprise e ON rd.enterprise_id = e.id
        WHERE r.cooperative_id = ? 
        AND r.member_id = ?
        AND r.status = 'Approved' AND r.is_deleted = 0
        ORDER BY r.remittance_date ASC, r.id ASC
    `;

    const rows = await queryRows(sql, [cooperativeId, memberId]);

    let runningBalance = 0;
    const data = rows.map((row, idx) => {
        runningBalance += row.amount;
        // DR/CR follows the account's normal balance: savings/liability and
        // revenue balances grow on the credit side; loans/assets/expenses on
        // the debit side (same convention as the General Ledger).
        const type = (row.account_type || '').toLowerCase();
        const creditNormal = !(type === 'asset' || type === 'loan' || type === 'expense');
        const amt = parseFloat(row.amount || 0);
        return [
            idx + 1,
            formatDate(row.remittance_date),
            row.account_name || 'N/A',
            row.transaction_type || 'N/A',
            creditNormal ? (amt > 0 ? amt : '') : (amt < 0 ? -amt : ''),
            creditNormal ? (amt < 0 ? -amt : '') : (amt > 0 ? amt : ''),
            runningBalance,
            row.description || ''
        ];
    });

    const headers = ['S/N', 'Date', 'Account', 'Type', 'Debit (DR)', 'Credit (CR)', 'Balance', 'Description'];

    let memberName = '';
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    const member = await queryRows('SELECT last_name, first_name, middle_name, registration_no, special_id FROM members WHERE id = ?', [memberId]);
    if (member.length > 0) {
        memberName = [member[0].last_name, member[0].first_name, member[0].middle_name].filter(Boolean).join(' ');
        const memberIdStr = useSpecialId ? (member[0].special_id || String(member[0].registration_no).padStart(4, '0')) : String(member[0].registration_no).padStart(4, '0');
        memberName += ` (${useSpecialId ? 'Member ID' : 'Reg No'}: ${memberIdStr})`;
    }

    return { data, headers, title: `Member Account Statement - ${memberName}` };
}
