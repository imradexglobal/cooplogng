import {
    getMemberListData,
    getPaymentAdviseData,
    getMemberPerformanceAgingData,
    getGeneralNetworthData,
    getMemberMonthlyTransactionSummaryData
} from './memberReports.js';
import { getRemittanceListData, getRemittanceScheduleData, getEODReportData } from './remittanceReports.js';
import { getEnterpriseAccountData, getPersonalLedgerData } from './accountingReports.js';
import { formatDate } from '../../utils/formatters.js';

// Single source of truth for the report types: the Report Type dropdown, the
// filter visibility rules, the prefill defaults and the generate dispatch are
// all driven from this map, so adding a report type means adding one entry.
//
// Entry shape:
//   label         text shown in the Report Type select
//   filterGroups  selectors of the filter controls this type needs
//   title         static title, or null to use the title returned by build()
//   build(ctx)    async, returns { data, headers, title? }
//   prefill(ctx)  optional, seeds empty filter inputs when the type is picked
//   validate(ctx) optional, returns an error message to abort generate
//   fieldPicker   shows the Include Fields dropdown (Member Register)
//   autoGenerate  regenerate on type/filter change instead of a button press
//   directDownload the builder produces a file, not a preview (Accounting Pack)
//   buttonLabel / showHint  generate button wording and hint visibility
//
// ctx = { cooperativeId, cooperativeFullName, user, selectedFields, read(sel), el(sel) }

const toInputDate = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const prefillDateRange = (ctx) => {
    const from = ctx.el('#date-from');
    const to = ctx.el('#date-to');
    if (!from || !to || (from.value && to.value)) return;
    const today = new Date();
    const oneMonthAgo = new Date(today);
    oneMonthAgo.setMonth(today.getMonth() - 1);
    from.value = toInputDate(oneMonthAgo);
    to.value = toInputDate(today);
};

const prefillToday = (selector) => (ctx) => {
    const input = ctx.el(selector);
    if (input && !input.value) input.value = toInputDate(new Date());
};

export const REPORT_TYPES = {
    member_list: {
        label: 'Member Register',
        title: 'Member Register',
        filterGroups: ['.filter-member-status', '#member-fields-container'],
        fieldPicker: true,
        autoGenerate: true,
        build: (ctx) => getMemberListData(ctx.cooperativeId, ctx.user, {
            status: ctx.read('#member-status'),
            selectedFields: ctx.selectedFields
        })
    },
    remittance_list: {
        label: 'Transaction Journal',
        title: null,
        filterGroups: ['.filter-date', '.filter-bank', '.filter-txn-type'],
        prefill: prefillDateRange,
        build: async (ctx) => {
            const dateFrom = ctx.read('#date-from');
            const dateTo = ctx.read('#date-to');
            const result = await getRemittanceListData(ctx.cooperativeId, ctx.user, {
                dateFrom,
                dateTo,
                bank: ctx.read('#bank-filter'),
                transactionType: ctx.read('#txn-type-filter')
            });
            const range = dateFrom && dateTo ? `${formatDate(dateFrom)} - ${formatDate(dateTo)}`
                : dateFrom ? `From ${formatDate(dateFrom)}`
                : dateTo ? `Up to ${formatDate(dateTo)}`
                : '';
            result.title = 'Transaction Journal' + (range ? ` (${range})` : '');
            return result;
        }
    },
    enterprise_account: {
        label: 'Member Remittance Record (by Account)',
        title: null,
        filterGroups: ['.filter-enterprise', '.filter-fiscal-year', '.filter-ent-date', '.filter-ent-options', '.filter-zero-columns'],
        validate: (ctx) => {
            const from = ctx.read('#ent-date-from');
            const to = ctx.read('#ent-date-to');
            if (from && to && from > to) return 'Start date must not be after end date';
            return null;
        },
        build: (ctx) => getEnterpriseAccountData(ctx.cooperativeId, ctx.user, {
            enterpriseId: ctx.read('#ent-filter'),
            fyLabel: ctx.el('#fy-filter').selectedOptions[0].textContent,
            useSpecialId: localStorage.getItem('useSpecialIdInReports') === 'true',
            showMemberName: ctx.el('#ent-show-name')?.checked,
            includeInactive: ctx.el('#ent-include-inactive')?.checked,
            dateFrom: ctx.read('#ent-date-from'),
            dateTo: ctx.read('#ent-date-to')
        })
    },
    remittance_schedule: {
        label: 'Monthly Deduction Schedule',
        title: null,
        filterGroups: ['.filter-schedule-month', '.filter-schedule-year', '.filter-schedule-type', '.filter-schedule-member-name', '.filter-zero-columns'],
        build: async (ctx) => {
            const month = parseInt(ctx.read('#schedule-month'));
            const year = parseInt(ctx.read('#schedule-year'));
            const positive = ctx.read('#schedule-type') === 'positive';
            // Checkbox: read .checked, since .value stays "on" either way.
            const showMemberName = ctx.el('#schedule-show-member-name')?.checked !== false;
            const result = await getRemittanceScheduleData(ctx.cooperativeId, ctx.user, month, year, positive, { showMemberName });
            const monthName = ctx.el('#schedule-month').selectedOptions[0].textContent;
            result.title = `Monthly Deduction Schedule for ${monthName} ${year} (${positive ? 'Deposit' : 'Loan'})`;
            return result;
        }
    },
    payment_advise: {
        label: 'Payment Advice',
        title: null,
        filterGroups: ['.filter-member-status', '.filter-advise-ent'],
        build: (ctx) => getPaymentAdviseData(ctx.cooperativeId, ctx.user, {
            status: ctx.read('#member-status'),
            enterprise: ctx.read('#advise-ent-filter')
        })
    },
    eod_report: {
        label: 'Daily Transactions Summary',
        title: null,
        filterGroups: ['.filter-eod-date-from', '.filter-eod-date-to'],
        prefill: (ctx) => {
            prefillToday('#eod-date-from')(ctx);
            prefillToday('#eod-date-to')(ctx);
        },
        build: (ctx) => getEODReportData(ctx.cooperativeId, ctx.read('#eod-date-from'), ctx.read('#eod-date-to'))
    },
    personal_ledger: {
        label: 'Member Account Statement',
        title: null,
        filterGroups: ['.filter-personal-member'],
        build: (ctx) => getPersonalLedgerData(ctx.cooperativeId, ctx.read('#personal-member'))
    },
    member_performance_aging: {
        label: 'Loan Aging Analysis',
        title: null,
        filterGroups: ['.filter-zero-columns'],
        build: (ctx) => getMemberPerformanceAgingData(ctx.cooperativeId)
    },
    general_networth: {
        label: 'Member Balances Summary (As At Date)',
        title: null,
        filterGroups: ['.filter-networth-date', '.filter-zero-columns'],
        prefill: prefillToday('#networth-date'),
        validate: (ctx) => (ctx.read('#networth-date') ? null : 'Please select an As At date'),
        build: (ctx) => getGeneralNetworthData(ctx.cooperativeId, ctx.user, ctx.read('#networth-date'))
    },
    member_monthly_summary: {
        label: 'Member Monthly Transaction Summary',
        title: null,
        filterGroups: ['.filter-monthly-summary-fy', '.filter-monthly-summary-type', '.filter-zero-columns'],
        build: (ctx) => getMemberMonthlyTransactionSummaryData(
            ctx.cooperativeId,
            ctx.user,
            ctx.el('#monthly-summary-fy').selectedOptions[0].textContent,
            ctx.read('#monthly-summary-type')
        )
    },
    accounting_pack: {
        label: 'Accounting Pack (Excel workbook)',
        title: 'Accounting Pack',
        filterGroups: ['.filter-date'],
        directDownload: true,
        buttonLabel: 'Generate Accounting Pack',
        showHint: true,
        prefill: prefillDateRange,
        validate: (ctx) => {
            const dateFrom = ctx.read('#date-from');
            const dateTo = ctx.read('#date-to');
            if (!dateFrom || !dateTo) return 'Please select both a start and an end date';
            if (dateFrom > dateTo) return 'Start date must not be after end date';
            return null;
        },
        build: null
    }
};

// Every filter control in the screen, so the UI can hide them all before
// showing the groups belonging to the selected type.
export const REPORT_TYPE_FILTER_GROUPS = [...new Set(
    Object.values(REPORT_TYPES).flatMap((cfg) => cfg.filterGroups || [])
)];

export const REPORT_TYPE_OPTIONS = Object.entries(REPORT_TYPES).map(([value, cfg]) => ({
    value,
    label: cfg.label
}));
