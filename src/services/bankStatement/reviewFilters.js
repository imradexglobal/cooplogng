export function filterStatementTransactions(transactions, filter = 'all', searchTerm = '') {
    const term = String(searchTerm || '').toLowerCase().trim();

    return (transactions || []).filter(transaction => {
        if (filter === 'confident' && (transaction.confidence !== 'High' || transaction.classification === 'Unknown')) return false;
        if (filter === 'uncertain' && transaction.confidence === 'High' && transaction.classification !== 'Unknown') return false;
        if (filter === 'unknown' && transaction.classification !== 'Unknown') return false;
        if (filter === 'expense' && transaction.classification !== 'Expense') return false;
        if (filter === 'income' && transaction.classification !== 'Income') return false;
        if (filter === 'deposits' && transaction.classification !== 'Remittance') return false;
        if (filter === 'loan' && transaction.classification !== 'Loan') return false;
        if (filter === 'duplicates' && transaction.duplicateStatus === 'New') return false;

        if (term) {
            const description = String(transaction.description || '').toLowerCase();
            const reference = String(transaction.reference || '').toLowerCase();
            const memberName = transaction.member
                ? `${transaction.member.first_name || ''} ${transaction.member.last_name || ''}`.toLowerCase()
                : '';
            const registrationNo = String(transaction.member?.registration_no || '').toLowerCase();
            if (!description.includes(term) && !reference.includes(term) &&
                !memberName.includes(term) && !registrationNo.includes(term)) return false;
        }
        return true;
    });
}
