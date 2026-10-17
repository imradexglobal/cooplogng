import { formatDate } from '../../utils/formatters.js';

export function useSpecialIdInReports() {
    return localStorage.getItem('useSpecialIdInReports') === 'true';
}

const pad4 = (v) => (v ? String(v).padStart(4, '0') : '');

const shortName = (m) => {
    const last = m.last_name || '';
    const fInit = String(m.first_name || '').charAt(0);
    const mInit = String(m.middle_name || '').charAt(0);
    return `${last} ${fInit}${fInit ? '.' : ''}${mInit}${mInit ? '.' : ''}`.trim();
};

const fullName = (m) => `${m.last_name || ''} ${m.first_name || ''} ${m.middle_name || ''}`.trim();

// Single source of truth for the Member Register columns: the Reports field
// picker and the data builder both read from this list, so a column can never
// be offered in the UI without a value/label in the export (and vice versa).
// `label` is the header written to the preview/Excel/PDF, `uiLabel` (when set)
// is the friendlier text shown in the dropdown, and `altLabel`/`altValue` are
// used when the "Use Special ID in Reports" setting is on.
export const MEMBER_FIELDS = [
    { key: 'short_name', label: 'Short Name', value: shortName },
    { key: 'full_name', label: 'Full Name', value: fullName },
    {
        key: 'registration_no',
        label: 'Reg No',
        altLabel: 'Member ID',
        value: (m) => pad4(m.registration_no),
        altValue: (m) => m.special_id || pad4(m.registration_no)
    },
    { key: 'mobile', label: 'Mobile', value: (m) => m.mobile || '' },
    { key: 'sex', label: 'Sex', value: (m) => m.sex || '' },
    { key: 'status', label: 'Status', value: (m) => m.status || '' },
    { key: 'date_joined', label: 'Date Joined', value: (m) => formatDate(m.date_joined) },
    { key: 'address', label: 'Address', value: (m) => m.address || '' },
    { key: 'account_manager', label: 'Account Manager', uiLabel: 'Manager', value: (m) => m.account_manager || '' }
];

export const DEFAULT_MEMBER_FIELDS = ['full_name', 'registration_no', 'mobile', 'sex', 'status'];

// Unknown keys (stale persisted state) are dropped; an empty selection falls
// back to the defaults so the report can never collapse to an S/N column.
export function selectMemberFields(keys) {
    const requested = new Set(Array.isArray(keys) && keys.length > 0 ? keys : DEFAULT_MEMBER_FIELDS);
    return MEMBER_FIELDS.filter((f) => requested.has(f.key));
}

export function memberFieldHeader(field) {
    return useSpecialIdInReports() && field.altLabel ? field.altLabel : field.label;
}

export function memberFieldValue(field, member) {
    return useSpecialIdInReports() && field.altValue ? field.altValue(member) : field.value(member);
}

export function memberFieldOptions() {
    const useAlt = useSpecialIdInReports();
    return MEMBER_FIELDS.map((f) => ({
        key: f.key,
        label: useAlt && f.altLabel ? f.altLabel : (f.uiLabel || f.label)
    }));
}
