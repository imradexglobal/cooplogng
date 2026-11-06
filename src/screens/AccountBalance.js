import { buildAccountBalance, fetchEnterprises, fetchRemittances, fetchAllMembers, fetchBanks, fetchMemberPaymentAdvise } from '../services/dataService.js'
import { buildWeeklyActivity, reconstructBalances, areaChartSVG, weekPctChange, compactCurr, CHART_WEEKS } from '../components/weeklyChart.js'
import { showWorkspaceSpinner } from '../components/workspaceSpinner.js'
import { hasPermission } from '../services/permissionService.js'
import { formatCurrency, escapeHtml, escapeAttribute, formatDate, getInitials } from '../utils/formatters.js'
import { normalizePhone } from '../utils/normalize.js'
import { getPendingQueue, queryRows, getAllForCoop, loadDoc } from '../services/sqliteService.js'
import { showToast } from '../services/toastService.js'
import { showWithdrawalWizard } from '../components/WithdrawalWizard.js'

// ─── Classification Helpers ─────────────────────────────────────────────────
function isDashboardIncome(cls) {
    return cls === 'Revenue' || cls === 'Operating Income' || cls === 'Loan Income' || cls === 'Other Income';
}
function isDashboardExpense(cls) {
    return cls === 'Expense' || cls === 'Expenses' || cls === 'Operating Expense' || cls === 'Administrative Expense' || cls === 'Finance Expense' || cls === 'Welfare Expense' || cls === 'Other Operating Expense' || cls === 'Other Expenses';
}

// Persist mask/unmask state using localStorage
const MASK_PREF_KEY = 'cooplog_balance_mask'
const SHOW_ZERO_BALANCE_KEY = 'cooplog_show_zero_balance'
const dashboardExpandedRemittances = new Set()

function getMaskPreference() {
  try {
    const stored = localStorage.getItem(MASK_PREF_KEY)
    return stored !== null ? stored === 'true' : true
  } catch (e) {
    return true
  }
}

function getShowZeroBalancePreference() {
  try {
    const stored = localStorage.getItem(SHOW_ZERO_BALANCE_KEY)
    return stored !== null ? stored === 'true' : false
  } catch (e) {
    return false
  }
}

let maskBalances = getMaskPreference()
let showZeroBalances = getShowZeroBalancePreference()

// Which card chart is open (metric key). Module-level so a dashboard
// auto-refresh re-renders with the same chart still open.
let openChartKey = null
// Escape-key closer is bound once (re-renders must not stack it).
let chartModalEscBound = false
// Signature of the last painted dashboard figures. Background refreshes that
// recompute identical figures skip the DOM write entirely — no spinner, no
// flicker; only genuinely changed figures repaint (still with no spinner).
let _lastDashboardSig = null

// Money canonicalized to display precision so float dust (e.g. summation
// order differences in the last ulp) can never trigger a repaint.
function _sigMoney(n) {
    const v = Number(n)
    return Number.isFinite(v) ? v.toFixed(2) : '0.00'
}



function saveMaskPreference(value) {
  try {
    localStorage.setItem(MASK_PREF_KEY, String(value))
  } catch (e) {
    console.warn('Could not save mask preference', e)
  }
}

function saveShowZeroBalancePreference(value) {
  try {
    localStorage.setItem(SHOW_ZERO_BALANCE_KEY, String(value))
  } catch (e) {
    console.warn('Could not save show zero preference', e)
  }
}

export async function renderAccountBalance(container, user) {
    const isAdmin = user.isAdmin || hasPermission(user.permissions, 'admin') || user.username?.toLowerCase() === 'admin'
    const isMember = user.role === 'member'
    const isStaff = !isAdmin && !isMember
    const hasDashboardAccess = isAdmin || isMember || hasPermission(user.permissions, 'dashboard_view');

    if (!hasDashboardAccess) {
        container.innerHTML = `
      <div class="page-header">
        <h2>Dashboard</h2>
      </div>
      <div class="page-container">
        <div style="background: var(--danger-bg); color: var(--danger); padding: 1.5rem; border-radius: var(--radius-md); text-align: center; font-weight: 600; border: 1px solid var(--danger);">
          Access Denied: You do not have permission to view the Dashboard.
        </div>
      </div>
    `
        return;
    }



    const headerHtml = `
    <div class="page-header dashboard-page-header" style="display: flex; flex-direction: column; gap: 1rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
        <div>
          <h2 style="margin: 0; color: var(--text-primary);">Dashboard</h2>
          <p class="subtitle" style="margin: 0.25rem 0 0 0; color: var(--text-muted);">Welcome back!</p>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <button id="toggle-mask-btn" class="ghost-button" style="
            width: 2.25rem;
            height: 2.25rem;
            padding: 0.375rem;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
          ">
            ${maskBalances ? `
              <!-- Visible eye -->
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 12C2 12 5.63636 5 12 5C18.3636 5 22 12 22 12C22 12 18.3636 19 12 19C5.63636 19 2 12 2 12Z"/>
                <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"/>
              </svg>
            ` : `
              <!-- Hidden eye -->
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.9449 17.9449C16.3991 19.2325 14.2839 20 12 20C5.63636 20 2 12 2 12C3.8607 8.49382 6.66692 5.90325 10 4.99988M9.9 4.30021C10.5861 4.10767 11.2873 4.00024 12 4.00024C18.3636 4.00024 22 12 22 12C21.3037 13.3719 20.3339 14.6377 19.169 15.711M15 11.5C15 13.1569 13.6569 14.5 12 14.5C10.6362 14.5 9.47666 13.6048 9.09204 12.335M4 4L20 20"/>
              </svg>
            `}
          </button>
          <button id="theme-toggle-btn-dashboard" class="ghost-button" style="
            width: 2.25rem;
            height: 2.25rem;
            padding: 0.375rem;
            border-radius: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
          " title="Toggle theme">
            <!-- Filled dynamically by js -->
          </button>
        </div>
      </div>



    </div>
    <div class="page-container" id="balance-content"></div>
  `

    // Declared outside try so the catch block can also tell first paint
    // (spinner/empty container) apart from a background update.
    let isFirstPaint = !container.querySelector('#balance-content')
    try {
        // Spinner only on first paint. Updates reuse the live DOM (see the
        // signature check below) so figures change without any flicker.
        if (isFirstPaint) showWorkspaceSpinner(container);
        let visibleBalance = []

        const queryUser = JSON.parse(JSON.stringify(user));
        const coopId = String(user.cooperativeId);

        // ONE shared remittance load for balance + recent + revenue + counts
        // (previously the full set was loaded 2x, 3x with the retry below).
        // All independent reads then run in parallel (previously sequential).
        // Computation below is unchanged, so figures are identical.
        const sharedRemittances = await fetchRemittances(user.cooperativeId, queryUser)

        // Derived in-memory from the single shared load above. Previously this
        // screen re-scanned the whole remittance table 3 more times (bank cash,
        // monthly stats, plus a remittance×detail JOIN that materialized the
        // cartesian product) — 4 concurrent full-DB copies per paint, which is
        // what OOMs long-lived Electron sessions on large cooperatives.
        // Full-scope users (admin/all-access) get bit-identical figures; scoped
        // users now see scope-consistent figures instead of global ones.
        let _bankCashTotal = 0
        const monthlyRows = []
        for (const _r of sharedRemittances) {
            if (_r.status !== 'Approved') continue
            if (_r.bank_name == null || _r.bank_name !== 'Internal Transfer') {
                _bankCashTotal += parseFloat(_r.amount || 0)
            }
            monthlyRows.push({
                amount: _r.amount,
                category: _r.category,
                transaction_type: _r.transaction_type,
                remittance_date: _r.remittance_date
            })
        }
        const bankBalResult = [{ net_balance: _bankCashTotal }]
        // Same rows + filter as the old GROUP BY query, grouped in memory over
        // the already-attached details (no extra IndexedDB scan).
        const loanDetailRows = []
        {
            const _bal = new Map()
            for (const _r of sharedRemittances) {
                if (_r.status !== 'Approved') continue
                for (const _d of (_r.details || [])) {
                    const _k = `${_r.member_id}|||${_d.enterprise_id || _d.item || ''}`
                    _bal.set(_k, (_bal.get(_k) || 0) + parseFloat(_d.amount || 0))
                }
            }
            for (const [_k, _net] of _bal) {
                const _i = _k.indexOf('|||')
                loanDetailRows.push({
                    member_id: _k.slice(0, _i),
                    enterprise_id: _k.slice(_i + 3),
                    net_amt: _net
                })
            }
        }
        const loansSql = `SELECT * FROM loans WHERE cooperative_id = ? AND is_deleted = 0`;
        // Members scope flag must be computed BEFORE the parallel fetch below.
        // Identical to the original: hasAllAccess is only ever true for staff
        // whose rights include 'all' (plus admins via isAdmin).
        const _rightsTokens = String(user.enterprise_rights || user.enterprises || '').split(',').map(p => p.trim()).filter(p => p.length > 0);
        const _allAccessForMembers = isAdmin || (isStaff && _rightsTokens.some(r => r.toLowerCase() === 'all'));

        const memberAdviceId = (queryUser.memberId && queryUser.memberId !== '0000000000') ? queryUser.memberId : (isMember ? user.memberId : null);
        const [
            enterpriseRows,
            banks,
            membersAll,
            loansAll,
            syncQueue,
            memberAdviceRows,
            coopRows,
            memberRow,
        ] = await Promise.all([
            fetchEnterprises(user.cooperativeId, true),
            fetchBanks(user.cooperativeId),
            fetchAllMembers(user.cooperativeId, user.username, _allAccessForMembers),
            queryRows(loansSql, [coopId]).catch(e => { console.warn('Error fetching loans for stats:', e); return []; }),
            getPendingQueue(user.cooperativeId),
            (memberAdviceId ? fetchMemberPaymentAdvise(memberAdviceId).catch(() => []) : Promise.resolve([])),
            getAllForCoop(coopId, 'cooperatives').catch(() => []),
            (isMember && user.memberId && user.memberId !== '0000000000' ? loadDoc('members', user.memberId, coopId).catch(() => null) : Promise.resolve(null)),
        ]);

        const coopRow = Array.isArray(coopRows) ? (coopRows[0] || null) : null;

        let { accountBalance } = await buildAccountBalance(user.cooperativeId, queryUser, null, { remittances: sharedRemittances, enterprises: enterpriseRows })
        visibleBalance = accountBalance
        const allEnts = {}
        const entObjMap = {}
        enterpriseRows.forEach(e => {
            allEnts[e.id] = e.account_name
            entObjMap[e.id] = e
        })

        // Guard: if enterprises exist but balance is all zero, retry once with a brief delay
        if (enterpriseRows.length > 0 && (accountBalance.length === 0 || accountBalance.every(b => (b.sum_of_amount || 0) === 0))) {
            await new Promise(r => setTimeout(r, 150))
            const retried = await buildAccountBalance(user.cooperativeId, queryUser)
            if (retried.accountBalance.some(b => (b.sum_of_amount || 0) !== 0)) {
                accountBalance = retried.accountBalance
                visibleBalance = accountBalance
            }
        }

        const existingIds = new Set(visibleBalance.map(b => b.id))
        Object.keys(allEnts).forEach(id => {
            if (!existingIds.has(id)) {
                visibleBalance.push({ id, account_name: allEnts[id], sum_of_amount: 0 })
            }
        })
        visibleBalance.sort((a, b) => a.account_name.localeCompare(b.account_name))

        // ── Current payment advice (member dashboard card) ──────────────
        // Sum of the member's monthly advice, split savings vs auto loans.
        // Uses the payment_advise table directly (most reliable source).
        let adviceTotal = 0;
        let adviceSavings = 0;
        let adviceLoans = 0;
        let adviceActiveCount = 0;
        try {
            const entTypeById = {};
            (enterpriseRows || []).forEach(e => { entTypeById[String(e.id)] = (e.account_type || '').toLowerCase(); });
            (memberAdviceRows || []).forEach(a => {
                if (a && a.is_deleted) return;
                const amt = parseFloat(a.amount) || 0;
                if (amt === 0) return;
                adviceTotal += amt;
                adviceActiveCount++;
                if (entTypeById[String(a.enterprise_id)] === 'loan') adviceLoans += amt;
                else adviceSavings += amt;
            });
        } catch (e) { console.warn('Advice total calc failed:', e?.message); }

        let allowedEntIds = [];
        let allowedEntNames = [];
        let hasAllAccess = false;

        if (isStaff) {
            const rightsString = user.enterprise_rights || user.enterprises || '';
            const rights = rightsString.split(',').map(p => p.trim()).filter(p => p.length > 0);

            if (rights.some(r => r.toLowerCase() === 'all')) {
                hasAllAccess = true;
            } else {
                rights.forEach(r => {
                    const matchId = Object.keys(allEnts).find(id => id.toLowerCase() === r.toLowerCase());
                    if (matchId) {
                        allowedEntIds.push(matchId);
                    } else {
                        allowedEntNames.push(r.toLowerCase());
                    }
                });
            }
        }

        let visibleTotal = 0;
        let totalSavingsLiabilities = 0;
        let totalLoansOutstandingAssets = 0;
        let totalRevenueCollected = 0;
        let totalExpensesAllTime = 0;

        visibleBalance = visibleBalance.map(b => {
            const hasAccess = isAdmin || isMember || hasAllAccess ||
                allowedEntIds.includes(b.id) ||
                allowedEntNames.includes((b.account_name || '').toLowerCase());

            if (!hasAccess) {
                return { ...b, sum_of_amount: 0, isRestricted: true };
            }

            const entObj = entObjMap[b.id];
            const isRevenue = entObj && (entObj.revenue == 1 || entObj.revenue === '1' || entObj.revenue === 'true' || entObj.revenue === true || entObj.account_type === 'revenue');
            const isPenalty = entObj && (entObj.is_penalty == 1 || entObj.is_penalty === '1' || entObj.is_penalty === 'true' || entObj.is_penalty === true);
            // Dues & penalties are member obligations: they count toward
            // networth (member + admin) even when flagged as revenue.
            // Pure-revenue enterprises stay hidden from members as before.
            const isDue = entObj && (entObj.compulsory_due == 1 || entObj.compulsory_due === '1' || entObj.compulsory_due === 'true' || entObj.compulsory_due === true);
            const isDuePenalty = !!(isDue || isPenalty);
            if (isMember && isRevenue && !isDuePenalty) {
                return null;
            }

            const type = entObj ? (entObj.account_type || '').toLowerCase() : '';
            if (isRevenue && !isDuePenalty) {
                // revenue captured from transaction details below, not from balance
            } else if ((type === 'savings' || type === 'liability')) {
                totalSavingsLiabilities += (b.sum_of_amount || 0);
            } else if (type === 'loan' || type === 'asset') {
                totalLoansOutstandingAssets += Math.abs(b.sum_of_amount || 0);
            }

            visibleTotal += (b.sum_of_amount || 0)
            return b;
        }).filter(Boolean)

        let totalBankCash = parseFloat(bankBalResult[0]?.net_balance || 0);

        const subtitleEl = container.querySelector('.subtitle')
        if (subtitleEl) {
            if (isMember) {
                subtitleEl.innerHTML = `Welcome back, <strong style="color: var(--accent-primary);">${escapeHtml(user.memberName || user.fullName || 'Member')}</strong>`
            } else {
                subtitleEl.innerHTML = `Viewing <strong>${isAdmin ? 'Global' : 'Accessible'}</strong> cooperative data.`
            }
        }

        // Reuses the single shared remittance load above (same rows, same order)
        let remittances = sharedRemittances
        if (queryUser.memberId && queryUser.memberId !== '0000000000') {
            remittances = remittances.filter(r => r.member_id === queryUser.memberId);
        }

        // Group autogen children under their parents (same logic as remittance page)
        const parentMap = new Map();
        const orphans = [];
        for (const r of remittances) {
            if (r.autogen !== 1) {
                r.children = [];
                parentMap.set(String(r.id), r);
            }
        }
        for (const r of remittances) {
            if (r.autogen !== 1) continue;
            const childId = String(r.id);
            const parentId = r.parent_remittance_id || r.loan_id;
            let parent = parentMap.get(String(parentId));
            if (!parent) {
                const dashIdx = childId.lastIndexOf('-');
                if (dashIdx > 0) {
                    const prefix = childId.substring(0, dashIdx);
                    parent = parentMap.get(prefix);
                }
            }
            if (parent) {
                parent.children.push(r);
            } else {
                orphans.push(r);
            }
        }
        const groupedRemittances = [...parentMap.values(), ...orphans];
        groupedRemittances.sort((a, b) => {
            const createdCmp = String(b.created_at || '').localeCompare(String(a.created_at || ''));
            if (createdCmp !== 0) return createdCmp;
            const dateCmp = new Date(b.remittance_date || 0) - new Date(a.remittance_date || 0);
            if (dateCmp !== 0) return dateCmp;
            return String(b.id).localeCompare(String(a.id));
        });
        const recentRemittances = groupedRemittances.slice(0, 10)
        window.__dashRecentRemittances = recentRemittances;

        // Accounting lives on the remittance header (transaction_type/category):
        // revenue counts income-category headers at header amount, expenses
        // count expense-category headers. Details are only for member-level
        // enterprise breakdowns, not accounting.
        for (const rem of remittances) {
            if (rem.status !== 'Approved') continue;
            if (isDashboardIncome(rem.category || '')) {
                totalRevenueCollected += parseFloat(rem.amount || 0);
            } else if (isDashboardExpense(rem.category || '')) {
                // Signed: a +ve expense header (refund/reversal) nets off.
                totalExpensesAllTime -= parseFloat(rem.amount || 0);
            }
        }
        // Total revenue is net of expenses (all-time).
        const totalRevenue = totalRevenueCollected - totalExpensesAllTime;

        // Fetch statistics (pre-fetched above)
        let members = membersAll
        if (queryUser.memberId && queryUser.memberId !== '0000000000') {
            members = members.filter(m => m.id === queryUser.memberId);
        }
        const now = Date.now()
        const thisMonthStart = new Date(now).setDate(1)
        let newThisMonth = 0
        let activeMembers = 0
        members.forEach(m => {
            if (m.status === 'Active') activeMembers++;
            if (m.date_joined) {
                const joinedMs = new Date(m.date_joined).getTime()
                if (!isNaN(joinedMs) && joinedMs >= thisMonthStart) {
                    newThisMonth++
                }
            }
        })

        const pendingRemittances = remittances.filter(r => r.status === 'Pending').length
        const approvedThisMonth = remittances.filter(r => {
            const remitDate = new Date(r.remittance_date).getTime()
            return r.status === 'Approved' && remitDate >= thisMonthStart
        }).length

        // Calculate organizational revenue, expenses, net position at header
        // level (rows pre-fetched in parallel above; accounting follows the
        // remittance category, not the member-level details).
        let organizationalRevenue = 0
        let organizationalExpenses = 0
        {
            monthlyRows.forEach(row => {
                const remDate = new Date(row.remittance_date).getTime();
                if (isNaN(remDate) || remDate < thisMonthStart) return;
                const amt = parseFloat(row.amount || 0);
                const cls = row.category || '';
                if (isDashboardIncome(cls)) {
                    organizationalRevenue += amt;
                } else if (isDashboardExpense(cls)) {
                    // Signed: a +ve expense header (refund/reversal) nets off.
                    organizationalExpenses -= amt;
                }
            });
        }
        const netPosition = organizationalRevenue - organizationalExpenses
        
        // Fetch loans outstanding balances (rows pre-fetched in parallel above)
        let activeLoans = 0
        let activeLoansAmount = 0
        let overdueLoans = 0
        let overdueLoansAmount = 0
        {
            let loans = loansAll
            if (queryUser.memberId && queryUser.memberId !== '0000000000') {
                loans = loans.filter(l => l.member_id === queryUser.memberId);
            }

            const loanBalMap = {};
            loanDetailRows.forEach(row => {
                const key = `${row.member_id}_${row.enterprise_id}`;
                loanBalMap[key] = Math.abs(parseFloat(row.net_amt || 0));
            });

            loans.forEach(l => {
                const key = `${l.member_id}_${l.enterprise_id}`;
                const outstanding = loanBalMap[key] !== undefined ? loanBalMap[key] : parseFloat(l.principal_amount || 0);

                if (l.status === 'Active') {
                    activeLoans++;
                    activeLoansAmount += outstanding;
                }
                if (l.status === 'Overdue') {
                    overdueLoans++;
                    overdueLoansAmount += outstanding;
                }
            })
        }

        // Weekly trend buckets from the same (possibly member-filtered)
        // approved flows the cards above are built from — chart and card
        // can never disagree.
        const weekly = buildWeeklyActivity(remittances, entObjMap, CHART_WEEKS)
        const weekLabels = weekly.buckets.map(b => b.label)
        const weekFlow = (key) => weekly.buckets.map(b => b.sums[key] || 0)

        // Weekly new-member joins (for the members card chart).
        const weekJoins = weekly.buckets.map(() => 0)
        members.forEach(m => {
            if (!m.date_joined) return
            const ms = new Date(m.date_joined).getTime()
            if (isNaN(ms)) return
            for (let i = weekly.buckets.length - 1; i >= 0; i--) {
                if (ms >= weekly.buckets[i].start.getTime()) { weekJoins[i] += 1; break }
            }
        })

        // ── Paint-skip: every displayed figure, canonicalized ──────────────
        // Background refreshes recompute the same values 99% of the time. When
        // the signature matches the last paint, return WITHOUT touching the
        // DOM — no spinner (already skipped above), no innerHTML swap, charts
        // and scroll position untouched. Money is rounded to display precision
        // so float dust can never cause a repaint loop.
        const _sig = JSON.stringify([
            String(coopId), String(queryUser.memberId || queryUser.userId || user.username || ''),
            isMember ? 1 : 0, maskBalances ? 1 : 0, showZeroBalances ? 1 : 0,
            visibleBalance.map(b => [String(b.id), _sigMoney(b.sum_of_amount), b.isRestricted ? 1 : 0]),
            [_sigMoney(visibleTotal), _sigMoney(totalSavingsLiabilities), _sigMoney(totalLoansOutstandingAssets),
             _sigMoney(totalRevenueCollected), _sigMoney(totalExpensesAllTime), _sigMoney(totalRevenue), _sigMoney(totalBankCash), _sigMoney(organizationalRevenue),
             _sigMoney(organizationalExpenses), _sigMoney(netPosition)],
            [activeLoans, _sigMoney(activeLoansAmount), overdueLoans, _sigMoney(overdueLoansAmount)],
            [_sigMoney(adviceTotal), _sigMoney(adviceSavings), _sigMoney(adviceLoans), adviceActiveCount],
            [members.length, newThisMonth, activeMembers, pendingRemittances, approvedThisMonth, syncQueue.length],
            recentRemittances.map(r => [String(r.id), _sigMoney(r.amount), String(r.status || ''),
                String(r.remittance_date || ''), String(r.description || ''), String(r.bank_name || ''), String(r.member_id || '')]),
            (banks || []).filter(b => (b.is_visible ?? true) && b.id !== 'internal' && b.id !== 'internal_transfer'
                && !String(b.bank_name || '').toLowerCase().includes('internal'))
                .map(b => [String(b.id), String(b.bank_name || ''), String(b.account_name || ''),
                    String(b.account_number || ''), String(b.branch_name || ''), String(b.swift_code || '')]),
            weekly.buckets.map(b => [String(b.label), ...Object.keys(b.sums || {}).sort().map(k => _sigMoney(b.sums[k]))]),
            weekJoins,
            [coopRow?.full_name || '', coopRow?.short_name || '', coopRow?.contact_number || '', coopRow?.email || '', coopRow?.address || '', coopRow?.logo_path ? '1' : '0'],
            [memberRow?.registration_no || '', memberRow?.date_joined || '', memberRow?.status || '', memberRow?.mobile || ''],
        ])
        if (!isFirstPaint && _sig === _lastDashboardSig) return
        _lastDashboardSig = _sig

        // Sync queue (pre-fetched in parallel above)

        const maskValue = (value) => {
            if (maskBalances) {
                return '••••••••'
            }
            return formatCurrency(value)
        }

        const isMemberView = isMember;

        let contentHtml = `
        <style>
            .dashboard-stats-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 1rem;
                margin-bottom: 2rem;
            }
            
            .dashboard-stat-card {
                background: var(--bg-card);
                border-radius: 1.25rem;
                padding: 1rem 1.5rem;
                position: relative;
                overflow: hidden;
                border: 1px solid var(--border-light);
            }
            
            .dashboard-stat-card::before {
                content: '';
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                width: 4px;
                border-radius: 4px 0 0 4px;
            }
            
            .dashboard-stat-card.blue::before {
                background: linear-gradient(180deg, #3B82F6, #60A5FA);
            }
            
            .dashboard-stat-card.yellow::before {
                background: linear-gradient(180deg, #F59E0B, #FBBF24);
            }
            
            .dashboard-stat-card.red::before {
                background: linear-gradient(180deg, #EF4444, #F87171);
            }
            
            .dashboard-stat-card.green::before {
                background: linear-gradient(180deg, #10B981, #34D399);
            }
            
            .dashboard-stat-card.purple::before {
                background: linear-gradient(180deg, #8B5CF6, #A78BFA);
            }
            
            .stat-card-label {
                font-size: 0.75rem;
                font-weight: 700;
                color: var(--text-muted);
                text-transform: uppercase;
                margin-bottom: 0.25rem;
            }
            
            .stat-card-value {
                font-size: 1.75rem;
                font-weight: 800;
                color: var(--text-primary);
                margin-bottom: 0.25rem;
            }
            
            .stat-card-subvalue {
                font-size: 0.75rem;
                color: var(--text-muted);
            }
            
            .stat-card-subvalue span {
                margin-right: 0.5rem;
            }
            
            .stat-card-new {
                color: var(--accent-primary);
            }
            
            .stat-card-issues {
                color: var(--danger);
            }

            [data-chart] { cursor: pointer; }
            .tap-hint {
                font-size: 0.68rem;
                opacity: 0.8;
                margin-top: 0.4rem;
                font-weight: 600;
            }
            .chart-modal-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.65);
                backdrop-filter: blur(3px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                padding: 1.25rem;
                overflow-y: auto;
            }
            .chart-modal {
                background: var(--bg-card);
                border: 1px solid var(--border-light);
                border-radius: 1.25rem;
                width: 100%;
                max-width: 920px;
                max-height: 92vh;
                overflow-y: auto;
                padding: 1.5rem 1.75rem;
                box-shadow: var(--shadow-xl, 0 25px 60px rgba(0,0,0,0.45));
            }
            @media (max-width: 640px) {
                .chart-modal-overlay { padding: 0.75rem; align-items: flex-end; }
                .chart-modal { padding: 1.1rem 1rem; border-radius: 1rem 1rem 0 0; max-height: 94vh; }
            }
            .chart-change-up { color: #10b981; }
            .chart-change-down { color: #ef4444; }
            .chart-change-flat { color: var(--text-muted); }
            
            #balance-content.hide-zero-ents .enterprise-card[data-balance-raw="0"],
            #balance-content.hide-zero-ents .enterprise-card[data-balance-raw="0.00"] {
                display: none;
            }
            @media (min-width: 1000px) {
                .dashboard-stats-grid {
                    grid-template-columns: repeat(4, 1fr);
                }
            }
            @media (max-width: 999px) {
                .fab-container {
                    bottom: calc(64px + 1rem) !important;
                }
            }
            
            .fab-container {
                position: fixed;
                bottom: 1.5rem;
                right: 1.5rem;
                z-index: 999;
                display: flex;
                flex-direction: column-reverse;
                align-items: center;
                gap: 0.5rem;
            }
            .fab-trigger {
                width: 3.25rem;
                height: 3.25rem;
                border-radius: 50%;
                background: var(--accent-primary);
                color: white;
                border: none;
                font-size: 1.5rem;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0,0,0,0.25);
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s ease;
            }
            .fab-trigger:hover { transform: scale(1.1); }
            .fab-trigger.open { transform: rotate(45deg); }
            .fab-menu {
                display: none;
                flex-direction: column;
                gap: 0.5rem;
                align-items: flex-end;
            }
            .fab-menu.open { display: flex; }
            .fab-item {
                padding: 0.6rem 1rem;
                border-radius: 0.75rem;
                background: var(--bg-card);
                border: 1px solid var(--border-light);
                font-weight: 600;
                cursor: pointer;
                color: var(--text-primary);
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 0.5rem;
                transition: background 0.15s;
            }
            .fab-item:hover { background: var(--bg-hover); }
        </style>
        
        
        <div class="fab-container">
          <button class="fab-trigger" id="fab-trigger">+</button>
          <div class="fab-menu" id="fab-menu">
            ${(() => {
              const items = [];
              if (isAdmin) {
                items.push({ action: 'members', icon: '👥', label: 'Add Member' });
                items.push({ action: 'log', icon: '💰', label: 'Log Remittance' });
                items.push({ action: 'reports', icon: '📊', label: 'Reports' });
                items.push({ action: 'settings', icon: '⚙️', label: 'Settings' });
                items.push({ action: 'withdrawal-request', icon: '💸', label: 'Withdrawal Request' });
              } else if (isStaff) {
                items.push({ action: 'members', icon: '👥', label: 'Add Member' });
                items.push({ action: 'log', icon: '💰', label: 'Log Payment' });
                items.push({ action: 'reports', icon: '📊', label: 'Reports' });
                items.push({ action: 'withdrawal-request', icon: '💸', label: 'Withdrawal Request' });
              } else {
                items.push({ action: 'ledger', icon: '📈', label: 'My Ledger' });
                items.push({ action: 'history', icon: '📜', label: 'History' });
                items.push({ action: 'withdrawal-request', icon: '💸', label: 'Withdrawal Request' });
              }
              return items.map(item => `
                <button class="fab-item" data-quick-action="${item.action}" style="padding: 0.6rem 1rem; border-radius: 0.75rem; background: var(--bg-card); border: 1px solid var(--border-light); font-weight: 600; cursor: pointer; color: var(--text-primary); box-shadow: 0 2px 8px rgba(0,0,0,0.15); white-space: nowrap; display: flex; align-items: center; gap: 0.5rem;">
                  <span>${item.icon}</span>
                  <span>${item.label}</span>
                </button>
              `).join('');
            })()}
          </div>
        </div>
        ${isMemberView ? `
        <div style="display: grid; grid-template-columns: 1fr; gap: 1rem; margin-bottom: 2rem;">
          <div data-chart="portfolio" title="Tap for weekly trend" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">MY NET PORTFOLIO</div>
            <div style="font-size: 2rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${visibleTotal}">${maskValue(visibleTotal)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-action="nav-tab" data-tab="advice" title="Manage payment advice" style="background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%); border-radius: 1.5rem; padding: 1.5rem; color: white; cursor: pointer; position: relative; overflow: hidden;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">CURRENT PAYMENT ADVICE · MONTHLY</div>
            <div style="font-size: 2rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${adviceTotal}">${maskValue(adviceTotal)}</div>
            <div style="font-size: 0.78rem; opacity: 0.9; margin-top: 0.35rem;">Savings <span data-balance-value="${adviceSavings}">${maskValue(adviceSavings)}</span> · Loans (auto) <span data-balance-value="${adviceLoans}">${maskValue(adviceLoans)}</span> · ${adviceActiveCount} active</div>
            <div class="tap-hint" style="color: #fff;">Manage advice ›</div>
          </div>
        </div>` : `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
          <div data-chart="savings" title="Tap for weekly trend" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">TOTAL MEMBER SAVINGS (LIABILITY)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${totalSavingsLiabilities}">${maskValue(totalSavingsLiabilities)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="loans" title="Tap for weekly trend" style="background: linear-gradient(135deg, #f87171 0%, #ef4444 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">TOTAL OUTSTANDING LOANS (ASSETS)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${totalLoansOutstandingAssets}">${maskValue(totalLoansOutstandingAssets)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="cash" title="Tap for weekly trend" style="background: linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">Cash + Bank Balance</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${totalBankCash}">${maskValue(totalBankCash)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="revenue" title="Tap for weekly trend" style="background: linear-gradient(135deg, #10b981 0%, #34d399 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">NET REVENUE (ALL-TIME)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${totalRevenue}">${maskValue(totalRevenue)}</div>
            <div style="font-size: 0.75rem; opacity: 0.85; margin-top: 0.25rem;">Gross <span data-balance-value="${totalRevenueCollected}">${maskValue(totalRevenueCollected)}</span> · Expenses <span data-balance-value="${totalExpensesAllTime}">${maskValue(totalExpensesAllTime)}</span></div>
            <div class="tap-hint">Net = gross − expenses · all-time ›</div>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem;">
          <div data-chart="tx" title="Tap for weekly trend" style="background: linear-gradient(135deg, #11998e 0%, #34d399 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">TRANSACTIONS (THIS MONTH)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;">${approvedThisMonth}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="revM" title="Tap for weekly trend" style="background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">REVENUE (THIS MONTH)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${organizationalRevenue}">${maskValue(organizationalRevenue)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="expM" title="Tap for weekly trend" style="background: linear-gradient(135deg, #ef4444 0%, #f87171 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">EXPENSES (THIS MONTH)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${organizationalExpenses}">${maskValue(organizationalExpenses)}</div>
            <div class="tap-hint">Tap for weekly trend ›</div>
          </div>
          <div data-chart="netM" title="Tap for weekly trend" style="background: linear-gradient(135deg, #8B5CF6 0%, #A78BFA 100%); border-radius: 1.5rem; padding: 1.5rem; color: white;">
            <div style="font-size: 0.875rem; opacity: 0.9; text-transform: uppercase; font-weight: 600;">NET POSITION (CALENDAR MONTH)</div>
            <div style="font-size: 1.75rem; font-weight: 800; margin-top: 0.5rem;" data-balance-value="${netPosition}">${maskValue(netPosition)}</div>
            <div class="tap-hint">Revenue − expenses · calendar month ›</div>
          </div>
        </div>`}
        
        ${isMemberView ? `
        <div class="dashboard-stats-grid">
            <div class="dashboard-stat-card blue" data-chart="aloans" title="Tap for weekly trend">
                <div class="stat-card-label">ACTIVE LOANS</div>
                <div class="stat-card-value">${activeLoans}</div>
                <div class="stat-card-subvalue">
                    <span data-balance-value="${activeLoansAmount}">${maskValue(activeLoansAmount)}</span>
                </div>
                <div class="stat-card-subvalue tap-hint" style="color: var(--text-muted);">Tap for weekly trend ›</div>
            </div>
            <div class="dashboard-stat-card red" data-chart="oloans" title="Tap for weekly trend">
                <div class="stat-card-label">OVERDUE</div>
                <div class="stat-card-value">${overdueLoans}</div>
                <div class="stat-card-subvalue">
                    <span data-balance-value="${overdueLoansAmount}">${maskValue(overdueLoansAmount)}</span>
                </div>
                <div class="stat-card-subvalue tap-hint" style="color: var(--text-muted);">Tap for weekly trend ›</div>
            </div>
        </div>` : `
        <div class="dashboard-stats-grid">
            <div class="dashboard-stat-card blue" data-chart="members" title="Tap for weekly trend">
                <div class="stat-card-label">TOTAL MEMBERS</div>
                <div class="stat-card-value">${members.length}</div>
                <div class="stat-card-subvalue">
                    <span class="stat-card-new">+${newThisMonth} new</span>
                    <span>• ${activeMembers} active</span>
                </div>
                <div class="stat-card-subvalue tap-hint" style="color: var(--text-muted);">Tap for weekly trend ›</div>
            </div>
            
            <div class="dashboard-stat-card yellow" data-chart="pending" title="Tap for weekly trend">
                <div class="stat-card-label">PENDING APPROVALS</div>
                <div class="stat-card-value">${pendingRemittances}</div>
                <div class="stat-card-subvalue">
                    <span>needs attention</span>
                </div>
                ${pendingRemittances > 0 ? `
                <button type="button" id="review-pending-btn" class="ghost-button" style="margin-top: 0.6rem; font-size: 0.75rem; font-weight: 700; padding: 0.4rem 0.9rem; border-radius: 999px; border: 1px solid var(--warning, #d97706); color: var(--warning, #d97706); cursor: pointer; background: transparent;">Review pending →</button>
                ` : ``}
                <div class="stat-card-subvalue tap-hint" style="color: var(--text-muted);">Tap for weekly trend ›</div>
            </div>
            
            <div class="dashboard-stat-card red" data-chart="aloans" title="Tap for weekly trend">
                <div class="stat-card-label">ACTIVE LOANS</div>
                <div class="stat-card-value">${activeLoans}</div>
                <div class="stat-card-subvalue">
                    <span data-balance-value="${activeLoansAmount}">${maskValue(activeLoansAmount)}</span>
                </div>
                <div class="stat-card-subvalue tap-hint" style="color: var(--text-muted);">Tap for weekly trend ›</div>
            </div>
            
            <div class="dashboard-stat-card green">
                <div class="stat-card-label">SYNC QUEUE</div>
                <div class="stat-card-value">${syncQueue.length}</div>
                <div class="stat-card-subvalue">
                    <span>Records waiting</span>
                </div>
            </div>
        </div>`}
        
        ${(isMemberView || (!isMemberView && visibleBalance.length > 0)) ? `
        <div style="margin-bottom: 2rem;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
            <h3 style="color: var(--text-primary); margin: 0;">${isMember ? 'My Account Balances' : 'Enterprise Balances'}</h3>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span style="color: var(--text-muted); font-size: 0.875rem;">Show Zero Balances</span>
              <label style="
                position: relative;
                display: inline-flex;
                align-items: center;
                cursor: pointer;
              ">
                <input type="checkbox" id="toggle-zero-balances" ${showZeroBalances ? 'checked' : ''} style="display: none;">
                <div style="
                  width: 44px;
                  height: 24px;
                  background: ${showZeroBalances ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : 'var(--border-light)'};
                  border-radius: 9999px;
                  transition: all 0.3s ease;
                  position: relative;
                ">
                  <div style="
                    position: absolute;
                    top: 2px;
                    left: ${showZeroBalances ? '22px' : '2px'};
                    width: 20px;
                    height: 20px;
                    background: white;
                    border-radius: 50%;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
                    transition: all 0.3s ease;
                  "></div>
                </div>
              </label>
            </div>
          </div>
          <div class="enterprise-grid">
        ` : ''}
    `

        if (isMemberView || (!isMemberView && visibleBalance.length > 0)) {
            if (visibleBalance.length === 0) {
                contentHtml += `<div class="card" style="width: 100%; border-radius: var(--radius-md); padding: 2rem; color: var(--text-muted); text-align: center;">No account balance found.</div>`
            } else {
                visibleBalance.forEach((ent) => {
                    contentHtml += `
              <div class="enterprise-card" data-balance-raw="${ent.sum_of_amount || 0}" data-chart="ent:${escapeAttribute(String(ent.id || ''))}" title="Tap for weekly trend">
                <div class="enterprise-name">${escapeHtml(ent.account_name)}</div>
                <div class="enterprise-amt ${ent.sum_of_amount < 0 ? 'text-red' : ''}" data-balance-value="${ent.sum_of_amount || 0}">${maskValue(ent.sum_of_amount)}</div>
              </div>
            `
                })
            }

            contentHtml += `</div></div>`
        }

        contentHtml += `
        <div id="card-chart-mount"></div>
        <div style="margin-bottom: 2rem;">
          <h3 style="color: var(--text-primary); margin-bottom: 1rem;">Recent Activity</h3>
          <div style="background: var(--bg-card); border-radius: 0.75rem; overflow: hidden; border: 1px solid var(--border-light);">
    `

        if (recentRemittances.length === 0) {
            contentHtml += `<div style="padding: 2rem; color: var(--text-muted); text-align: center;">No recent activity found.</div>`
        } else {
            contentHtml += `
        <table class="recent-activity-table" style="width: 100%; border-collapse: collapse;">
          <thead style="background: var(--bg-secondary);">
            <tr>
              <th style="padding: 0.75rem 1rem; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">DATE</th>
              <th style="padding: 0.75rem 1rem; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">DESCRIPTION</th>
              <th style="padding: 0.75rem 1rem; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">BANK</th>
              <th style="padding: 0.75rem 1rem; text-align: left; font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">STATUS</th>
              <th style="padding: 0.75rem 1rem; text-align: right; font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted);">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
      `
            recentRemittances.forEach(remit => {
                const childCount = remit.children ? remit.children.length : 0;
                const isExpanded = dashboardExpandedRemittances.has(remit.id);
                contentHtml += `
          <tr style="border-top: 1px solid var(--border-light); cursor: pointer;" data-action="view-details" data-remittance='${JSON.stringify(remit).replace(/'/g, "&#39;")}'>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-secondary);">${escapeHtml(new Date(remit.remittance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))}</td>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-primary);">
              ${childCount > 0 ? `<span class="expand-toggle" data-toggle-id="${remit.id}" style="cursor:pointer;margin-right:4px;color:var(--accent-primary);font-weight:700;user-select:none;">${isExpanded ? '▼' : '▶'}</span>` : ''}
              ${escapeHtml(remit.description || 'No description')}
              ${childCount > 0 ? `<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">(${childCount})</span>` : ''}
            </td>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-secondary);">${escapeHtml(remit.bank_name || '-')}</td>
            <td style="padding: 0.75rem 1rem;">
              <span style="display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; ${remit.status === 'Approved' ? 'background: #d1fae5; color: #065f46;' : remit.status === 'Pending' ? 'background: #fef3c7; color: #92400e;' : 'background: #fee2e2; color: #991b1b;'}">${escapeHtml(remit.status || 'Pending')}</span>
            </td>
            <td style="padding: 0.75rem 1rem; text-align: right; font-size: 0.875rem; font-weight: 600; color: ${remit.amount < 0 ? 'var(--danger)' : 'var(--text-primary)'};" data-balance-value="${remit.amount}">
              ${maskValue(remit.amount)}
            </td>
          </tr>
        `
                if (childCount > 0 && isExpanded) {
                    remit.children.forEach(child => {
                        contentHtml += `
          <tr style="border-top: 1px solid var(--border-light); background: var(--bg-secondary); cursor: pointer;" data-action="view-details" data-remittance='${JSON.stringify(child).replace(/'/g, "&#39;")}'>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(new Date(child.remittance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))}</td>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-primary);">
              <span style="color:var(--text-muted);margin-right:4px;">└</span>
              ${escapeHtml(child.description || 'No description')}
            </td>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(child.bank_name || '-')}</td>
            <td style="padding: 0.5rem 1rem;">
              <span style="display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; ${child.status === 'Approved' ? 'background: #d1fae5; color: #065f46;' : child.status === 'Pending' ? 'background: #fef3c7; color: #92400e;' : 'background: #fee2e2; color: #991b1b;'}">${escapeHtml(child.status || 'Pending')}</span>
            </td>
            <td style="padding: 0.5rem 1rem; text-align: right; font-size: 0.8rem; font-weight: 600; color: ${child.amount < 0 ? 'var(--danger)' : 'var(--text-primary)'};" data-balance-value="${child.amount}">
              ${maskValue(child.amount)}
            </td>
          </tr>
        `
                    })
                }
            })
            contentHtml += `</tbody></table>`
        }

        contentHtml += `</div></div>`

        // Filter banks to show only visible ones, exclude internal transfers
        const visibleBanks = banks.filter(b => 
            (b.is_visible ?? true) && 
            b.id !== 'internal' && 
            b.id !== 'internal_transfer' &&
            !b.bank_name?.toLowerCase().includes('internal')
        )

        if (visibleBanks.length > 0) {
            contentHtml += `
            <div>
              <h3 style="color: var(--text-primary); margin-bottom: 1rem;">Cooperative Bank Accounts</h3>
              <div style="display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));">
        `

            visibleBanks.forEach(bank => {
                contentHtml += `
              <div style="
                background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, var(--bg-card) 100%);
                border-radius: 1.5rem;
                padding: 1.5rem;
                border: 1px solid var(--border-light);
                position: relative;
                overflow: hidden;
              ">
                <div style="
                  position: absolute;
                  left: 0;
                  top: 0;
                  bottom: 0;
                  width: 8px;
                  background: linear-gradient(180deg, #6366f1 0%, #8b5cf6 100%);
                  border-radius: 1.5rem 0 0 1.5rem;
                "></div>
                <div style="
                  font-weight: 800;
                  color: var(--text-primary);
                  font-size: 1.25rem;
                  margin-bottom: 1rem;
                ">${escapeHtml(bank.bank_name)}</div>
                ${bank.account_name ? `<div style="
                  font-size: 0.875rem;
                  color: var(--text-secondary);
                  margin-bottom: 0.5rem;
                ">
                  <span style="color: var(--text-muted); font-weight: 600;">Acc Name:</span> ${escapeHtml(bank.account_name)}
                </div>` : ''}
                ${bank.account_number ? `<div style="
                  font-size: 0.875rem;
                  color: var(--text-secondary);
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                ">
                  <span style="color: var(--text-muted); font-weight: 600;">Acc Number:</span>
                  <span style="font-weight: 700;">${escapeHtml(bank.account_number)}</span>
                  <button style="
                    background: rgba(99, 102, 241, 0.1);
                    border: none;
                    border-radius: 0.5rem;
                    padding: 0.25rem 0.75rem;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--accent-primary);
                    gap: 0.25rem;
                  " data-copy="${escapeHtml(bank.account_number)}">📋 Copy</button>
                </div>` : ''}
                ${bank.branch_name ? `<div style="
                  font-size: 0.875rem;
                  color: var(--text-secondary);
                  margin-top: 0.5rem;
                ">
                  <span style="color: var(--text-muted); font-weight: 600;">Branch:</span> ${escapeHtml(bank.branch_name)}
                </div>` : ''}
                ${bank.swift_code ? `<div style="
                  font-size: 0.875rem;
                  color: var(--text-secondary);
                  margin-top: 0.5rem;
                ">
                  <span style="color: var(--text-muted); font-weight: 600;">SWIFT:</span> ${escapeHtml(bank.swift_code)}
                </div>` : ''}
              </div>
            `
            })

            contentHtml += `</div></div>`
        }

        container.innerHTML = headerHtml
        document.getElementById('balance-content').innerHTML = contentHtml

        // Apply zero-balance visibility
        const bcEl = document.getElementById('balance-content')
        if (bcEl) bcEl.classList.toggle('hide-zero-ents', !showZeroBalances)

        // ── Click-a-card weekly charts ─────────────────────────────
        // Series reuse the exact buckets above, so chart and card agree.
        const countFmt = (v) => String(Math.round(v || 0))
        const revWeek = weekFlow('revM')
        const expWeek = weekFlow('expM')
        const chartDefs = {
            savings: { title: 'Total Savings — weekly trend', color: '#8b5cf6', kind: 'balance', flows: weekFlow('savings'), current: totalSavingsLiabilities, fmt: compactCurr, note: 'Balance reconstructed from dated approved activity.' },
            loans: { title: 'Outstanding Loans — weekly trend', color: '#ef4444', kind: 'balance', flows: weekFlow('loans'), current: totalLoansOutstandingAssets, fmt: compactCurr, note: 'Approximate: reconstructed from dated loan flows.' },
            cash: { title: 'Cash + Bank — weekly trend', color: '#3b82f6', kind: 'balance', flows: weekFlow('cash'), current: totalBankCash, fmt: compactCurr, note: 'Balance reconstructed from dated approved activity.' },
            revenue: { title: 'Revenue — weekly collections', color: '#10b981', kind: 'flow', flows: weekFlow('revenue'), current: totalRevenueCollected, fmt: compactCurr, note: 'Weekly collections; total is all-time.' },
            tx: { title: 'Transactions — weekly count', color: '#14b8a6', kind: 'count', flows: weekFlow('tx'), current: approvedThisMonth, fmt: countFmt, note: 'Approved transactions per week; total is this month.' },
            revM: { title: 'Revenue — weekly', color: '#f59e0b', kind: 'flow', flows: revWeek, current: organizationalRevenue, fmt: compactCurr, note: 'Weekly revenue; total is this month.' },
            expM: { title: 'Expenses — weekly', color: '#ef4444', kind: 'flow', flows: expWeek, current: organizationalExpenses, fmt: compactCurr, note: 'Weekly expenses; total is this month.' },
            netM: { title: 'Net position — weekly', color: '#8b5cf6', kind: 'flow', flows: revWeek.map((v, i) => v - expWeek[i]), current: netPosition, fmt: compactCurr, note: 'Weekly revenue minus expenses; total is this month.' },
            members: { title: 'New members — weekly', color: '#3b82f6', kind: 'count', flows: weekJoins, current: members.length, fmt: countFmt, note: 'New joins per week; total is all members.' },
            pending: { title: 'Submissions — weekly', color: '#f59e0b', kind: 'count', flows: weekFlow('submitted'), current: pendingRemittances, fmt: countFmt, note: 'Submitted remittances per week; total is currently pending.' },
            aloans: { title: 'Loan activity — weekly', color: '#ef4444', kind: 'flow', flows: weekFlow('loans'), current: activeLoansAmount, fmt: compactCurr, note: 'Weekly loan flows; total is active outstanding.' },
            oloans: { title: 'Overdue scope — weekly loan activity', color: '#ef4444', kind: 'flow', flows: weekFlow('loans'), current: overdueLoansAmount, fmt: compactCurr, note: 'Weekly loan flows; total is overdue outstanding.' },
            portfolio: { title: 'My portfolio — weekly trend', color: '#667eea', kind: 'balance', flows: weekFlow('savings').map((v, i) => v + weekFlow('loans')[i] + weekFlow('cash')[i] + weekFlow('revenue')[i]), current: visibleTotal, fmt: compactCurr, note: 'Balance reconstructed from your dated activity.' },
        }

        const resolveChartDef = (key) => {
            if (!key) return null
            if (key.indexOf('ent:') === 0) {
                const id = key.slice(4)
                const ent = (visibleBalance || []).find(b => String(b.id) === id)
                if (!ent || ent.isRestricted) return null
                const flows = weekly.buckets.map(() => 0)
                remittances.forEach((rem) => {
                    if (rem.status !== 'Approved') return
                    const ms = new Date(rem.remittance_date).getTime()
                    if (isNaN(ms)) return
                    for (let i = weekly.buckets.length - 1; i >= 0; i--) {
                        if (ms >= weekly.buckets[i].start.getTime()) {
                            ;(rem.details || []).forEach((d) => {
                                if (String(d.enterprise_id) === id) flows[i] += parseFloat(d.amount || 0)
                            })
                            break
                        }
                    }
                })
                return { title: (ent.account_name || 'Enterprise') + ' — weekly trend', color: '#6366f1', kind: 'balance', flows: flows, current: (ent.sum_of_amount || 0), fmt: compactCurr, note: 'Balance reconstructed from dated approved activity.' }
            }
            return chartDefs[key] || null
        }

        const closeChartModal = () => { openChartKey = null; paintChartModal() }

        const paintChartModal = () => {
            const mount = document.getElementById('card-chart-mount')
            if (!mount) return
            if (!openChartKey) { mount.innerHTML = ''; return }
            const def = resolveChartDef(openChartKey)
            if (!def) { mount.innerHTML = ''; openChartKey = null; return }
            let bodyHtml
            if (maskBalances) {
                bodyHtml = `
                <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                  <div style="font-size: 1.5rem;">🔒</div>
                  <div style="flex: 1; min-width: 200px;">
                    <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(def.title)}</div>
                    <div style="font-size: 0.82rem; color: var(--text-muted);">Charts are hidden while balances are masked. Tap the eye icon above to unmask.</div>
                  </div>
                </div>`
            } else {
                const series = def.kind === 'balance' ? reconstructBalances(def.current, def.flows) : def.flows
                const pct = weekPctChange(series)
                const pctHtml = pct === null
                    ? '<span class="chart-change-flat">— vs first week</span>'
                    : (pct > 0
                        ? `<span class="chart-change-up">▲ +${(pct * 100).toFixed(1)}% vs first week</span>`
                        : (pct < 0
                            ? `<span class="chart-change-down">▼ ${(pct * 100).toFixed(1)}% vs first week</span>`
                            : '<span class="chart-change-flat">0% vs first week</span>'))
                bodyHtml = `
                <div style="font-size: 1.6rem; font-weight: 800; color: var(--text-primary); margin-top: 0.25rem;">${escapeHtml(def.fmt(def.current))}</div>
                <div style="font-size: 0.8rem; margin-top: 0.15rem; margin-bottom: 0.75rem;">${pctHtml}</div>
                <div style="color: var(--text-primary);">${areaChartSVG(series, weekLabels, { id: openChartKey, color: def.color, format: def.fmt })}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.5rem;">Last ${weekLabels.length} weeks · ${escapeHtml(def.note)}</div>`
            }
            mount.innerHTML = `
            <div class="chart-modal-overlay" data-chart-overlay>
              <div class="chart-modal" role="dialog" aria-label="${escapeHtml(def.title)}">
                <div style="display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 0.5rem;">
                  <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 800; font-size: 1.15rem; color: var(--text-primary);">${escapeHtml(def.title)}</div>
                  </div>
                  <button data-chart-close style="border: 1px solid var(--border-medium); background: transparent; color: var(--text-muted); border-radius: 0.5rem; padding: 0.4rem 0.8rem; cursor: pointer; flex-shrink: 0;">Close ✕</button>
                </div>
                ${bodyHtml}
              </div>
            </div>`
            mount.querySelector('[data-chart-close]')?.addEventListener('click', closeChartModal)
            mount.querySelector('[data-chart-overlay]')?.addEventListener('click', (e) => {
                if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-chart-overlay')) closeChartModal()
            })
            if (!chartModalEscBound) {
                chartModalEscBound = true
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && openChartKey) closeChartModal()
                })
            }
        }

        container.querySelectorAll('[data-chart]').forEach(el => {
            el.addEventListener('click', () => {
                const key = el.getAttribute('data-chart')
                openChartKey = (openChartKey === key) ? null : key
                paintChartModal()
            })
        })
        if (openChartKey) paintChartModal()

        // FAB toggle (element listeners die with innerHTML; the document-level
        // outside-click handler is bound ONCE — per-render closures here used
        // to pile up on every 60s auto-refresh + sync re-render and retain
        // the whole dashboard dataset in long-lived Electron sessions).
        const fabTrigger = document.getElementById('fab-trigger');
        const fabMenu = document.getElementById('fab-menu');
        const isFabOpen = () => !!fabMenu?.classList.contains('open');
        const toggleFab = (open) => {
            const next = open !== undefined ? open : !isFabOpen();
            fabTrigger?.classList.toggle('open', next);
            fabMenu?.classList.toggle('open', next);
        };
        fabTrigger?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFab();
        });
        // Close FAB when clicking outside
        if (!window._dashFabOutside) {
            window._dashFabOutside = (e) => {
                const fab = document.querySelector('.fab-container');
                const menu = document.getElementById('fab-menu');
                const trigger = document.getElementById('fab-trigger');
                if (menu?.classList.contains('open') && fab && !fab.contains(e.target)) {
                    menu.classList.remove('open');
                    trigger?.classList.remove('open');
                }
            };
            document.addEventListener('click', window._dashFabOutside);
        }
        
        // Quick actions handlers
        document.querySelectorAll('[data-quick-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.getAttribute('data-quick-action')
                toggleFab(false);
                if (action === 'members') {
                    window.location.hash = 'members'
                } else if (action === 'log') {
                    window.location.hash = 'log'
                } else if (action === 'reports') {
                    window.location.hash = 'reports'
                } else if (action === 'settings') {
                    window.location.hash = 'settings'
                } else if (action === 'ledger') {
                    window.location.hash = 'monthly-summary'
                } else if (action === 'history') {
                    window.location.hash = 'history'
                } else if (action === 'withdrawal-request') {
                    showWithdrawalWizard();
                    return;
                }
                window.dispatchEvent(new Event('hashchange'))
            })
        })

        // Pending-approvals shortcut: open the remittance page with the
        // history table pre-filtered to Pending (button only renders when > 0).
        // stopPropagation so the card's own chart-modal tap doesn't also fire.
        // NOTE: no manual hashchange dispatch — assigning location.hash fires
        // it natively, and a second mount would consume the one-shot status
        // flag and reload the table unfiltered.
        document.getElementById('review-pending-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            try { sessionStorage.setItem('cooplog-history-status', 'Pending'); } catch {}
            window.location.hash = 'payments';
        });

        const toggleMaskBtn = document.getElementById('toggle-mask-btn')
        if (toggleMaskBtn) {
            toggleMaskBtn.addEventListener('click', () => {
                maskBalances = !maskBalances
                saveMaskPreference(maskBalances)
                // Update all balance value displays in-place (no full re-render)
                document.querySelectorAll('[data-balance-value]').forEach(el => {
                    const raw = parseFloat(el.dataset.balanceValue) || 0
                    el.textContent = maskBalances ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : formatCurrency(raw)
                })
                // Update the eye icon
                toggleMaskBtn.innerHTML = maskBalances ? `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 12C2 12 5.63636 5 12 5C18.3636 5 22 12 22 12C22 12 18.3636 19 12 19C5.63636 19 2 12 2 12Z"/>
                    <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"/>
                  </svg>
                ` : `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.9449 17.9449C16.3991 19.2325 14.2839 20 12 20C5.63636 20 2 12 2 12C3.8607 8.49382 6.66692 5.90325 10 4.99988M9.9 4.30021C10.5861 4.10767 11.2873 4.00024 12 4.00024C18.3636 4.00024 22 12 22 12C21.3037 13.3719 20.3339 14.6377 19.169 15.711M15 11.5C15 13.1569 13.6569 14.5 12 14.5C10.6362 14.5 9.47666 13.6048 9.09204 12.335M4 4L20 20"/>
                  </svg>
                `

                // Keep mobile mask button in sync
                const maskBtnMobile = document.getElementById('mask-toggle-mobile-btn');
                if (maskBtnMobile) {
                    maskBtnMobile.innerHTML = maskBalances ? `
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    ` : `
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    `;
                }
                // Keep an open card chart in sync (masked lock vs live chart).
        if (openChartKey) paintChartModal()

        // Expand/collapse child rows in Recent Activity table (event delegation)
        if (!window._dashExpandBound) {
            window._dashExpandBound = true;
            document.addEventListener('click', (e) => {
                const toggle = e.target.closest('.expand-toggle');
                if (!toggle) return;
                e.stopPropagation();
                const id = toggle.dataset.toggleId;
                if (!id) return;
                if (dashboardExpandedRemittances.has(id)) {
                    dashboardExpandedRemittances.delete(id);
                } else {
                    dashboardExpandedRemittances.add(id);
                }
                const tableEl = document.querySelector('.recent-activity-table');
                if (!tableEl) return;
                const tbody = tableEl.querySelector('tbody');
                if (!tbody) return;
                const expandedRemittances = window.__dashRecentRemittances || [];
                let rowsHtml = '';
                expandedRemittances.forEach(remit => {
                    const childCount = remit.children ? remit.children.length : 0;
                    const isExpanded = dashboardExpandedRemittances.has(remit.id);
                    rowsHtml += `
          <tr style="border-top: 1px solid var(--border-light); cursor: pointer;" data-action="view-details" data-remittance='${JSON.stringify(remit).replace(/'/g, "&#39;")}'>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-secondary);">${escapeHtml(new Date(remit.remittance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))}</td>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-primary);">
              ${childCount > 0 ? `<span class="expand-toggle" data-toggle-id="${remit.id}" style="cursor:pointer;margin-right:4px;color:var(--accent-primary);font-weight:700;user-select:none;">${isExpanded ? '\u25BC' : '\u25B6'}</span>` : ''}
              ${escapeHtml(remit.description || 'No description')}
              ${childCount > 0 ? `<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">(${childCount})</span>` : ''}
            </td>
            <td style="padding: 0.75rem 1rem; font-size: 0.875rem; color: var(--text-secondary);">${escapeHtml(remit.bank_name || '-')}</td>
            <td style="padding: 0.75rem 1rem;">
              <span style="display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; ${remit.status === 'Approved' ? 'background: #d1fae5; color: #065f46;' : remit.status === 'Pending' ? 'background: #fef3c7; color: #92400e;' : 'background: #fee2e2; color: #991b1b;'}">${escapeHtml(remit.status || 'Pending')}</span>
            </td>
            <td style="padding: 0.75rem 1rem; text-align: right; font-size: 0.875rem; font-weight: 600; color: ${remit.amount < 0 ? 'var(--danger)' : 'var(--text-primary)'};" data-balance-value="${remit.amount}">
              ${maskValue(remit.amount)}
            </td>
          </tr>
        `
                    if (childCount > 0 && isExpanded) {
                        remit.children.forEach(child => {
                            rowsHtml += `
          <tr style="border-top: 1px solid var(--border-light); background: var(--bg-secondary); cursor: pointer;" data-action="view-details" data-remittance='${JSON.stringify(child).replace(/'/g, "&#39;")}'>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(new Date(child.remittance_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }))}</td>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-primary);">
              <span style="color:var(--text-muted);margin-right:4px;">\u2514</span>
              ${escapeHtml(child.description || 'No description')}
            </td>
            <td style="padding: 0.5rem 1rem; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(child.bank_name || '-')}</td>
            <td style="padding: 0.5rem 1rem;">
              <span style="display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; ${child.status === 'Approved' ? 'background: #d1fae5; color: #065f46;' : child.status === 'Pending' ? 'background: #fef3c7; color: #92400e;' : 'background: #fee2e2; color: #991b1b;'}">${escapeHtml(child.status || 'Pending')}</span>
            </td>
            <td style="padding: 0.5rem 1rem; text-align: right; font-size: 0.8rem; font-weight: 600; color: ${child.amount < 0 ? 'var(--danger)' : 'var(--text-primary)'};" data-balance-value="${child.amount}">
              ${maskValue(child.amount)}
            </td>
          </tr>
        `
                        })
                    }
                })
                tbody.innerHTML = rowsHtml;
                // Re-apply mask state to newly rendered elements
                if (typeof maskBalances !== 'undefined' && maskBalances) {
                    tbody.querySelectorAll('[data-balance-value]').forEach(el => {
                        el.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
                    });
                }
            });
        }
            })
        }

        const themeToggleBtnDash = document.getElementById('theme-toggle-btn-dashboard')
        if (themeToggleBtnDash) {
            const updateDashThemeIcon = () => {
                const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
                const isDark = currentTheme === 'dark';
                themeToggleBtnDash.innerHTML = isDark
                    ? `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l.707-.707M6.343 6.343l.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"></path></svg>`
                    : `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>`;
            }
            updateDashThemeIcon()
            themeToggleBtnDash.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme') || 'light';
                const nextTheme = current === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', nextTheme);
                localStorage.setItem('theme', nextTheme);
                updateDashThemeIcon();
                // Sync mobile button representation if active
                const mobileThemeBtn = document.getElementById('theme-toggle-mobile-btn');
                if (mobileThemeBtn) {
                    const isDark = nextTheme === 'dark';
                    const svgContent = isDark
                        ? `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l.707-.707M6.343 6.343l.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"></path></svg>`
                        : `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>`;
                    mobileThemeBtn.innerHTML = svgContent;
                }
            })
        }

        // Copy account number functionality
        document.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const value = e.currentTarget.getAttribute('data-copy')
                try {
                    await navigator.clipboard.writeText(value)
                    showToast('Account number copied!', 'success')
                } catch (err) {
                    console.error('Failed to copy:', err)
                    showToast('Failed to copy account number', 'error')
                }
            })
        })

        // Zero balance toggle
        const toggleZeroBtn = document.getElementById('toggle-zero-balances')
        if (toggleZeroBtn) {
            toggleZeroBtn.addEventListener('change', (e) => {
                showZeroBalances = e.target.checked
                saveShowZeroBalancePreference(showZeroBalances)
                const bcEl = document.getElementById('balance-content')
                if (bcEl) bcEl.classList.toggle('hide-zero-ents', !showZeroBalances)
                // Update toggle visual
                const labelEl = e.target.closest('label')
                if (labelEl) {
                    const track = labelEl.querySelector('div:first-of-type')
                    if (track) {
                        track.style.background = showZeroBalances ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : 'var(--border-light)'
                        const knob = track.querySelector('div')
                        if (knob) knob.style.left = showZeroBalances ? '22px' : '2px'
                    }
                }
            })
        }


    } catch (err) {
        // First paint: show the error (nothing else to display). Background
        // update: keep the last painted figures — never wipe live values.
        if (isFirstPaint) {
            container.innerHTML = headerHtml
            document.getElementById('balance-content').innerHTML = `<div class="alert">Could not load dashboard: ${escapeHtml(err.message)}</div>`
        } else {
            console.warn('[Dashboard] Background refresh failed, keeping last painted figures:', err?.message)
        }
    }
}
