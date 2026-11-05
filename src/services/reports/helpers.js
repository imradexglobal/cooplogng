const INCOME_CLS = new Set(['Operating Income', 'Loan Income', 'Other Income', 'Revenue']);
const EXPENSE_CLS = new Set(['Operating Expense', 'Administrative Expense', 'Finance Expense', 'Welfare Expense', 'Other Operating Expense', 'Other Expenses', 'Expense', 'Expenses']);
const BALANCE_SHEET_CLS = new Set(['Asset', 'Fixed Asset', 'General Asset', 'Loan Asset', 'Liability', 'Member Liability', 'Equity']);

function isIncomeCls(cls) { return INCOME_CLS.has(cls); }
function isExpenseCls(cls) { return EXPENSE_CLS.has(cls); }
function isPnLCls(cls) { return isIncomeCls(cls) || isExpenseCls(cls); }
function isBalanceSheetCls(cls) { return BALANCE_SHEET_CLS.has(cls); }

function clsGroup(cls) {
    if (isIncomeCls(cls)) return 'Income';
    if (isExpenseCls(cls)) return 'Expense';
    if (cls === 'Transfer' || cls === 'Suspense') return 'Non-P&L';
    return 'Other';
}

function classifyTransactionType(typeName, ttMap) {
    if (!typeName || !ttMap) return '';
    return ttMap[typeName] || '';
}

function getMemberIdentifier(member) {
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    if (useSpecialId && member.special_id) {
        return member.special_id;
    }
    return member.registration_no ? String(member.registration_no).padStart(4, '0') : '';
}

function getMemberIdentifierFromFields(registrationNo, specialId) {
    const useSpecialId = localStorage.getItem('useSpecialIdInReports') === 'true';
    if (useSpecialId && specialId) {
        return specialId;
    }
    return registrationNo ? String(registrationNo).padStart(4, '0') : '';
}
