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

function editDistance(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}

function findNameFieldHits(value, descriptionTokens) {
    const tokens = normalizeText(value).split(/\s+/).filter(token => token.length >= 2 && !STOP_WORDS.has(token));
    if (!tokens.length) return [];

    const variants = new Set(tokens);
    const compactName = tokens.join('');
    if (compactName.length >= 4) variants.add(compactName);

    const bestBySpan = new Map();
    for (const variant of variants) {
        for (let start = 0; start < descriptionTokens.length; start++) {
            let phrase = '';
            for (let width = 1; width <= 3 && start + width <= descriptionTokens.length; width++) {
                const token = descriptionTokens[start + width - 1];
                if (!/^[a-z]+$/.test(token)) break;
                phrase += token;
                // Names must match exactly after normalization; punctuation and
                // letter casing may differ, but spelling differences may not.
                if (variant !== phrase) continue;

                const indexes = Array.from({ length: width }, (_, offset) => start + offset);
                const key = indexes.join(',');
                const hit = { indexes, exact: true, distance: 0 };
                const previous = bestBySpan.get(key);
                if (!previous || Number(hit.exact) > Number(previous.exact) ||
                    (hit.exact === previous.exact && hit.distance < previous.distance)) {
                    bestBySpan.set(key, hit);
                }
            }
        }
    }

    return Array.from(bestBySpan.values())
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance || a.indexes.length - b.indexes.length)
        .slice(0, 15);
}

function matchMemberName(member, descriptionTokens) {
    const fields = [member.first_name, member.middle_name, member.last_name];
    const hitsByField = fields.map(value => findNameFieldHits(value, descriptionTokens));
    let best = { count: 0, exact: 0, distance: Infinity, indexes: [] };

    function chooseField(fieldIndex, usedIndexes, count, exact, distance) {
        if (fieldIndex === hitsByField.length) {
            if (count > best.count ||
                (count === best.count && exact > best.exact) ||
                (count === best.count && exact === best.exact && distance < best.distance)) {
                best = { count, exact, distance, indexes: Array.from(usedIndexes).sort((a, b) => a - b) };
            }
            return;
        }

        chooseField(fieldIndex + 1, usedIndexes, count, exact, distance);
        for (const hit of hitsByField[fieldIndex]) {
            if (hit.indexes.some(index => usedIndexes.has(index))) continue;
            const nextIndexes = new Set(usedIndexes);
            hit.indexes.forEach(index => nextIndexes.add(index));
            chooseField(fieldIndex + 1, nextIndexes, count + 1, exact + Number(hit.exact), distance + hit.distance);
        }
    }

    chooseField(0, new Set(), 0, 0, 0);
    return best.count >= 2 ? best : null;
}

function tokenizeDescriptionWithOffsets(text) {
    const source = String(text || '');
    const tokens = [];
    const tokenPattern = /[A-Za-z0-9À-ÿ]+/g;
    let match;
    while ((match = tokenPattern.exec(source))) {
        tokens.push({ normalized: normalizeText(match[0]), start: match.index, end: match.index + match[0].length });
    }
    return tokens;
}

function getDescriptionRanges(text, indexes = []) {
    const tokens = tokenizeDescriptionWithOffsets(text);
    const selected = indexes.map(index => tokens[index]).filter(Boolean);
    if (!selected.length) return [];
    const ranges = [];
    selected.forEach(token => {
        const previous = ranges[ranges.length - 1];
        const between = previous ? String(text || '').slice(previous.end, token.start) : '';
        if (previous && /^[\s-]*$/.test(between)) previous.end = token.end;
        else ranges.push({ start: token.start, end: token.end });
    });
    return ranges;
}

function extractPhoneCandidates(text) {
    const candidates = new Set();
    const numericGroups = String(text || '').match(/\d+(?:[\s().-]+\d+)*/g) || [];

    for (const group of numericGroups) {
        const digits = group.replace(/\D/g, '');
        if (digits.length < 9) continue;
        const maxLength = Math.min(12, digits.length);
        for (let length = 9; length <= maxLength; length++) {
            for (let start = 0; start + length <= digits.length; start++) {
                candidates.add(digits.slice(start, start + length));
            }
        }
    }
    return Array.from(candidates);
}

function phoneMatches(statementCandidates, memberPhone) {
    const phone = normalizePhone(memberPhone);
    if (phone.length < 9) return false;

    return statementCandidates.some(candidate => {
        const digits = normalizePhone(candidate);
        if (digits.length < 9) return false;
        const distance = editDistance(phone, digits);
        const allowed = Math.floor(Math.max(phone.length, digits.length) * 0.1);
        return distance <= allowed && Math.max(phone.length, digits.length) - distance >= 9;
    });
}

/**
 * Identifies a cooperative member by name, with optional phone and ID fallbacks.
 */
export function matchMember(text, members = [], { nameOnly = false } = {}) {
    if (!text || !members || members.length === 0) {
        return { member: null, confidence: 'None', candidates: [], reason: 'No text or members' };
    }

    const rawText = String(text);
    const lowerText = rawText.toLowerCase();
    const normHaystack = normalizeText(rawText);
    const compactText = lowerText.replace(/[^a-z0-9]/g, '');
    const descriptionTokens = normHaystack.split(/\s+/).filter(Boolean);
    const activeMembers = members.filter(m => m && m.id !== '0000000000' && !m.is_deleted && String(m.status || '').toLowerCase() !== 'archived');

    const nameMatches = [];
    for (const m of activeMembers) {
        const nameMatch = matchMemberName(m, descriptionTokens);
        if (nameMatch) nameMatches.push({ member: m, ...nameMatch });
    }

    if (nameMatches.length === 1) {
        const matched = nameMatches[0];
        const name = [matched.member.first_name, matched.member.middle_name, matched.member.last_name].filter(Boolean).join(' ');
        return {
            member: matched.member,
            confidence: 'High',
            matchType: 'name',
            matchedDescriptionRanges: getDescriptionRanges(rawText, matched.indexes),
            reason: `Matched at least two name fields for ${name}.`
        };
    }

    // Initial bank-statement mapping uses only exact normalized name fields.
    // Do not auto-assign on mobile or IDs when names are absent or ambiguous.
    if (nameOnly) {
        if (nameMatches.length > 1) {
            return {
                member: null,
                confidence: 'Low',
                candidates: nameMatches.map(n => n.member),
                reason: `Ambiguous name match with multiple active members (${nameMatches.map(n => `${n.member.first_name || ''} ${n.member.last_name || ''}`.trim()).join(', ')}). Sent to Unknown Payment for manual verification.`
            };
        }
        return { member: null, confidence: 'None', candidates: [], reason: 'No exact two-field name match found in the statement description.' };
    }

    const phoneCandidates = extractPhoneCandidates(rawText);
    const phoneMatchesList = activeMembers.filter(m => phoneMatches(phoneCandidates, m.mobile || ''));
    if (phoneMatchesList.length === 1) {
        const member = phoneMatchesList[0];
        return {
            member,
            confidence: 'High',
            matchType: 'phone',
            reason: `Matched at least 90% of the phone number: ${member.mobile}`
        };
    }
    if (phoneMatchesList.length > 1) {
        return {
            member: null,
            confidence: 'Low',
            candidates: phoneMatchesList,
            reason: 'Ambiguous phone match; multiple active members meet the nine-digit threshold.'
        };
    }

    for (const m of activeMembers) {
        const specialRaw = String(m.special_id || '').trim();
        if (specialRaw.length >= 3) {
            const specialPattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(specialRaw)}(?:$|[^a-z0-9])`, 'i');
            const specialNorm = normalizeText(specialRaw);
            const specialCompact = specialRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (specialPattern.test(lowerText) || (specialNorm && normHaystack.includes(specialNorm)) ||
                (specialCompact.length >= 4 && compactText.includes(specialCompact))) {
                return { member: m, confidence: 'High', matchType: 'special_id', reason: `Matched Special ID: ${m.special_id}` };
            }
        }
    }
    for (const m of activeMembers) {
        const regRaw = String(m.registration_no || '').trim();
        if (regRaw.length >= 2) {
            const regPattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(regRaw)}(?:$|[^a-z0-9])`, 'i');
            const regNorm = normalizeText(regRaw);
            const regCompact = regRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (regPattern.test(lowerText) || (regNorm && normHaystack.includes(regNorm)) ||
                (regCompact.length >= 4 && compactText.includes(regCompact))) {
                return { member: m, confidence: 'High', matchType: 'registration_no', reason: `Matched Registration No: ${m.registration_no}` };
            }
        }
    }

    if (nameMatches.length > 1) {
        return {
            member: null,
            confidence: 'Low',
            candidates: nameMatches.map(n => n.member),
            reason: `Ambiguous name match with multiple active members (${nameMatches.map(n => `${n.member.first_name || ''} ${n.member.last_name || ''}`.trim()).join(', ')}). Sent to Unknown Payment for manual verification.`
        };
    }

    return { member: null, confidence: 'None', candidates: [], reason: 'No confident member match found in description.' };
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

    // Small debits are bank expenses even when the narration identifies a member.
    if (amount < 0 && Math.abs(amount) < 100) {
        return {
            classification: 'Expense',
            transactionType: 'Financial & Banking Expenses',
            category: 'Finance Expense',
            memberId: '0000000000',
            member: null,
            confidence: 'High',
            enterpriseId: '',
            notes: 'Debit below 100 categorized as a bank expense regardless of member match.'
        };
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
    const match = matchMember(rawDesc, members, { nameOnly: true });

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
                matchedDescriptionRanges: match.matchedDescriptionRanges || [],
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
                matchedDescriptionRanges: match.matchedDescriptionRanges || [],
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
