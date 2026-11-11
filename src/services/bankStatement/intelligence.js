import { normalizePhone } from '../../utils/normalize.js';

/**
 * Normalizes text for token matching: lowercases, strips accents, keeps alphanumeric
 */
export function normalizeText(str) {
    return String(str || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Words that should never be used as unique name tokens
 */
const STOP_WORDS = new Set([
    'mrs', 'mr', 'miss', 'dr', 'prof', 'engr', 'alhaji', 'chief', 'pastor', 'rev',
    'bank', 'coop', 'cooperative', 'transfer', 'trf', 'nip', 'pos', 'web', 'atm',
    'pay', 'payment', 'ref', 'from', 'to', 'for', 'ltd', 'plc', 'savings', 'account',
    'uba', 'gtb', 'gtbank', 'access', 'zenith', 'firstbank', 'fcmb', 'fidelity', 'polaris',
    'credit', 'debit', 'deposit', 'withdrawal', 'charge', 'charges', 'fee', 'fees',
    'monthly', 'contrib', 'contribution', 'loan', 'repay', 'repayment', 'dues'
]);

function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Identifies a cooperative member from transaction description, reference, or payer
 */
export function matchMember(text, members = []) {
    if (!text || !members || members.length === 0) {
        return { member: null, confidence: 'None', candidates: [], reason: 'No text or members' };
    }

    const rawText = String(text);
    const lowerText = rawText.toLowerCase();
    const normHaystack = normalizeText(rawText);
    const compactText = lowerText.replace(/[^a-z0-9]/g, '');
    const haystackTokens = new Set(normHaystack.split(/\s+/).filter(t => t.length >= 2));
    const activeMembers = members.filter(m => m && m.id !== '0000000000' && !m.is_deleted && String(m.status || '').toLowerCase() !== 'archived');

    // 1. Exact Unique Special ID check
    for (const m of activeMembers) {
        const specialRaw = String(m.special_id || '').trim();
        if (specialRaw.length >= 3) {
            const specialLower = specialRaw.toLowerCase();
            const specialPattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(specialLower)}(?:$|[^a-z0-9])`, 'i');
            const specialNorm = normalizeText(specialRaw);
            const specialCompact = specialLower.replace(/[^a-z0-9]/g, '');

            if (specialPattern.test(lowerText) ||
                (specialNorm && normHaystack.includes(specialNorm)) ||
                (specialCompact.length >= 4 && compactText.includes(specialCompact))) {
                return {
                    member: m,
                    confidence: 'High',
                    matchType: 'special_id',
                    reason: `Matched Special ID: ${m.special_id}`
                };
            }
        }
    }

    // 2. Exact Unique Registration Number check
    for (const m of activeMembers) {
        const regRaw = String(m.registration_no || '').trim();
        if (regRaw.length >= 2) {
            const regLower = regRaw.toLowerCase();
            const regPattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(regLower)}(?:$|[^a-z0-9])`, 'i');
            const regNorm = normalizeText(regRaw);
            const regCompact = regLower.replace(/[^a-z0-9]/g, '');

            if (regPattern.test(lowerText) ||
                (regNorm && normHaystack.includes(regNorm)) ||
                (regCompact.length >= 4 && compactText.includes(regCompact))) {
                return {
                    member: m,
                    confidence: 'High',
                    matchType: 'registration_no',
                    reason: `Matched Registration No: ${m.registration_no}`
                };
            }
        }
    }

    // 3. Exact Phone Number check
    const digitsOnly = text.replace(/\D/g, '');
    if (digitsOnly.length >= 8) {
        for (const m of activeMembers) {
            const phone = normalizePhone(m.mobile || '');
            if (phone && phone.length >= 8 && digitsOnly.includes(phone)) {
                return {
                    member: m,
                    confidence: 'High',
                    matchType: 'phone',
                    reason: `Matched Phone Number: ${m.mobile}`
                };
            }
        }
    }

    // 4. Token-based First Name + Last Name matching
    const nameMatches = [];
    for (const m of activeMembers) {
        const first = normalizeText(m.first_name || '').split(/\s+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));
        const last = normalizeText(m.last_name || '').split(/\s+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));
        const middle = normalizeText(m.middle_name || '').split(/\s+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t));

        if (first.length === 0 || last.length === 0) continue;

        const hasFirst = first.some(t => haystackTokens.has(t));
        const hasLast = last.some(t => haystackTokens.has(t));
        const hasMiddle = middle.some(t => haystackTokens.has(t));

        if (hasFirst && hasLast) {
            nameMatches.push({
                member: m,
                score: (hasMiddle ? 3 : 2) + (first.length + last.length),
                hasMiddle
            });
        }
    }

    // If exactly one unique member matched both first and last name tokens
    if (nameMatches.length === 1) {
        const matched = nameMatches[0].member;
        const name = [matched.first_name, matched.last_name].filter(Boolean).join(' ');
        return {
            member: matched,
            confidence: 'High',
            matchType: 'name_exact',
            reason: `Confidently matched member: ${name} (Reg: ${matched.registration_no || 'N/A'})`
        };
    }

    // Ambiguous matches (multiple members with the same name tokens)
    if (nameMatches.length > 1) {
        // Check if middle name breaks the tie
        const middleWinners = nameMatches.filter(n => n.hasMiddle);
        if (middleWinners.length === 1) {
            const matched = middleWinners[0].member;
            return {
                member: matched,
                confidence: 'High',
                matchType: 'name_exact_middle_tiebreak',
                reason: `Disambiguated by middle name: ${matched.first_name} ${matched.middle_name} ${matched.last_name}`
            };
        }

        const candidateNames = nameMatches.map(n => `${n.member.first_name} ${n.member.last_name}`).join(', ');
        return {
            member: null,
            confidence: 'Low',
            candidates: nameMatches.map(n => n.member),
            reason: `Ambiguous match with multiple members (${candidateNames}). Sent to Unknown Payment for manual verification.`
        };
    }

    return {
        member: null,
        confidence: 'None',
        candidates: [],
        reason: 'No confident member match found in description.'
    };
}

/**
 * Known bank charge keywords that establish a confirmed expense
 */
const BANK_CHARGE_KEYWORDS = [
    'sms alert', 'alert fee', 'service charge', 'processing fee', 'processingfee',
    'custody fee', 'vat fee', 'vatfee', 'vat on', 'stamp duty', 'cheque charge',
    'chq charge', 'emt levy', 'emtl', 'account charge', 'bank charge', 'ledger fee',
    'maintenance fee', 'commission on turnover', 'cot', 'transfer charge', 'transfer fee',
    'nip fee', 'nip charge', 'pos charge', 'interbank fee'
];

/**
 * Known bank income keywords that establish confirmed income
 */
const BANK_INCOME_KEYWORDS = [
    'interest paid', 'credit interest', 'savings interest', 'interest earned',
    'investment return', 'dividend received', 'yield'
];

/**
 * Classifies an extracted transaction row
 */
export function classifyTransaction(txn, { members = [], loanEnterprises = [], defaultLoanEnterpriseId = null }) {
    const rawDesc = String(txn.description || '');
    const rawRef = String(txn.reference || '');
    const rawPayer = String(txn.payer || '');
    const combinedText = `${rawDesc} ${rawRef} ${rawPayer}`.trim();
    const normCombined = normalizeText(combinedText);
    const amount = Number(txn.amount || 0);

    // 1. Check for Confirmed Bank Expenses (debit transactions)
    if (amount < 0) {
        const isExpense = BANK_CHARGE_KEYWORDS.some(kw => normCombined.includes(kw));
        if (isExpense) {
            return {
                classification: 'Expense',
                transactionType: 'Financial & Banking Expenses',
                category: 'Finance Expense',
                memberId: '0000000000',
                member: null,
                confidence: 'High',
                enterpriseId: '',
                notes: 'Bank fee / charge identified directly from statement narration.'
            };
        }
    }

    // 2. Check for Confirmed Bank Income (credit transactions)
    if (amount > 0) {
        const isIncome = BANK_INCOME_KEYWORDS.some(kw => normCombined.includes(kw));
        if (isIncome) {
            return {
                classification: 'Income',
                transactionType: 'Other Income',
                category: 'Other Income',
                memberId: '0000000000',
                member: null,
                confidence: 'High',
                enterpriseId: '',
                notes: 'Bank interest / income identified directly from statement narration.'
            };
        }
    }

    // 3. Attempt confident member match
    const match = matchMember(combinedText, members);

    if (match.member && match.confidence === 'High') {
        if (amount > 0) {
            // Confident Positive Member Remittance
            return {
                classification: 'Remittance',
                transactionType: 'Member Deposit',
                category: 'Member Liability',
                memberId: match.member.id,
                member: match.member,
                confidence: 'High',
                enterpriseId: '',
                notes: match.reason
            };
        } else if (amount < 0) {
            // Confident Negative Member Outflow -> Loan
            const chosenLoanEntId = defaultLoanEnterpriseId || (loanEnterprises[0]?.id || '');
            return {
                classification: 'Loan',
                transactionType: 'Member Loan',
                category: 'Loan Asset',
                memberId: match.member.id,
                member: match.member,
                confidence: 'High',
                enterpriseId: chosenLoanEntId,
                notes: `${match.reason}. Member debit prepared for Loan Enterprise assignment (no loan child created until approval).`
            };
        }
    }

    // 4. Fallback: Everything uncertain is classified as Unknown Payment
    return {
        classification: 'Unknown',
        transactionType: 'Unknown Payments',
        category: 'Member Liability',
        memberId: '0000000000',
        member: null,
        confidence: match.confidence === 'Low' ? 'Low' : 'None',
        enterpriseId: '',
        candidates: match.candidates || [],
        notes: match.reason || 'Unidentified transaction; routed to Unknown Payment for investigation.'
    };
}
