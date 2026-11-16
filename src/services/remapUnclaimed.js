import { normalizeText } from './bankStatement/intelligence.js';

const HOUSE_MEMBER_ID = '0000000000';
const STOP_WORDS = new Set([
    'bank', 'coop', 'cooperative', 'transfer', 'trf', 'nip', 'pos', 'web', 'atm',
    'pay', 'payment', 'ref', 'from', 'to', 'for', 'ltd', 'plc', 'savings', 'account',
    'credit', 'debit', 'deposit', 'withdrawal', 'charge', 'charges', 'fee', 'fees',
    'monthly', 'contrib', 'contribution', 'loan', 'repay', 'repayment', 'unknown',
    'payments'
]);

function editDistance(left, right) {
    const a = String(left || ''), b = String(right || '');
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
}

function similarity(left, right) {
    const a = String(left || ''), b = String(right || '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (shorter >= 4 && (a.startsWith(b) || b.startsWith(a)) && shorter / longer >= 0.5) {
        return 0.65 + (shorter / longer) * 0.35;
    }
    const editSimilarity = 1 - editDistance(a, b) / longer;
    return shorter >= 4 && editSimilarity >= 0.72 ? editSimilarity : 0;
}

function commentTokens(value) {
    return normalizeText(value)
        .split(/\s+/)
        .filter(token => token && !STOP_WORDS.has(token) && (/^[a-z]+$/.test(token)));
}

export function buildRemapLearningPattern(remittance) {
    const tokens = [...new Set(commentTokens([remittance?.description, remittance?.cheque_number].filter(Boolean).join(' ')))].filter(token => token.length >= 3 || token.length === 1);
    const firstName = tokens.findIndex(token => token.length >= 5);
    return firstName >= 0 ? tokens.slice(firstName) : tokens;
}

export function learnedPatternSimilarity(leftPattern = [], rightPattern = []) {
    const left = new Set(leftPattern);
    const right = new Set(rightPattern);
    const shared = [...left].filter(token => right.has(token)).length;
    const required = Math.max(2, Math.ceil(Math.min(left.size, right.size) * 0.6));
    const anchorMatches = leftPattern[0] && rightPattern[0] && similarity(leftPattern[0], rightPattern[0]) >= 0.72;
    return { shared, matches: Boolean(anchorMatches) && shared >= required };
}

function memberNameParts(member) {
    return [member?.first_name, member?.middle_name, member?.last_name]
        .map(value => normalizeText(value).replace(/\s+/g, ''))
        .filter(value => value.length >= 2);
}

function memberLabel(member) {
    return [member?.first_name, member?.middle_name, member?.last_name].filter(Boolean).join(' ').trim() || member?.name || member?.id || 'Unknown member';
}

function isActiveMember(member) {
    return member && String(member.id) !== HOUSE_MEMBER_ID && !member.is_deleted && String(member.status || '').toLowerCase() !== 'archived';
}

function initialGroups(parts) {
    const groups = [];
    for (let start = 0; start < parts.length; start++) {
        for (let end = start + 2; end <= parts.length; end++) {
            groups.push({ indexes: Array.from({ length: end - start }, (_, offset) => start + offset), initials: parts.slice(start, end).map(part => part[0]).join('') });
        }
    }
    return groups;
}

function scoreMemberName(member, descriptionTokens) {
    const parts = memberNameParts(member);
    if (parts.length < 2 || !descriptionTokens.length) return { matchedParts: 0, fieldScores: [], evidence: [] };

    // Match complete, abbreviated, or slightly misspelled name tokens. A token
    // may only be used once here, so one word cannot count as two name parts.
    const edges = parts.map(part => descriptionTokens.map((token, tokenIndex) => {
        const score = similarity(part, token);
        return score ? { tokenIndex, score, token } : null;
    }).filter(Boolean));
    let best = { total: 0, scores: Array(parts.length).fill(0), evidence: [] };
    const visit = (partIndex, usedTokens, total, scores, evidence) => {
        if (partIndex >= parts.length) {
            if (total > best.total) best = { total, scores: [...scores], evidence: [...evidence] };
            return;
        }
        visit(partIndex + 1, usedTokens, total, scores, evidence);
        for (const edge of edges[partIndex]) {
            if (usedTokens.has(edge.tokenIndex)) continue;
            usedTokens.add(edge.tokenIndex);
            scores[partIndex] = edge.score;
            evidence.push({ partIndex, token: edge.token, score: edge.score, kind: edge.score === 1 ? 'exact' : 'similar' });
            visit(partIndex + 1, usedTokens, total + edge.score, scores, evidence);
            evidence.pop();
            scores[partIndex] = 0;
            usedTokens.delete(edge.tokenIndex);
        }
    };
    visit(0, new Set(), 0, Array(parts.length).fill(0), []);

    // A compact initial token such as "AA" can represent two or more distinct
    // member-name parts. This is what makes "Adebowale AA" evidence for
    // Adebowale + Abdul-wasiu + Adewale rather than a one-word match.
    for (const group of initialGroups(parts)) {
        const tokenIndex = descriptionTokens.findIndex(token => token === group.initials);
        if (tokenIndex < 0) continue;
        const initialScore = 0.72;
        const nextScores = [...best.scores];
        const nextEvidence = [...best.evidence];
        group.indexes.forEach(partIndex => {
            if (nextScores[partIndex] < initialScore) {
                nextScores[partIndex] = initialScore;
                nextEvidence.push({ partIndex, token: group.initials, score: initialScore, kind: 'initials' });
            }
        });
        const total = nextScores.reduce((sum, score) => sum + score, 0);
        if (total > best.total) best = { total, scores: nextScores, evidence: nextEvidence };
    }

    // A single initial can identify one component, but can never satisfy the
    // two-name-part requirement by itself.
    descriptionTokens.forEach(token => {
        if (token.length !== 1) return;
        parts.forEach((part, partIndex) => {
            if (part[0] !== token || best.scores[partIndex] >= 0.7) return;
            best.scores[partIndex] = 0.7;
            best.evidence.push({ partIndex, token, score: 0.7, kind: 'initial' });
        });
    });

    return {
        matchedParts: best.scores.filter(score => score > 0).length,
        fieldScores: best.scores,
        evidence: best.evidence
    };
}

export function isUnclaimedRemittance(remittance) {
    if (!remittance || remittance.is_deleted === true || Number(remittance.is_deleted) === 1) return false;
    if (String(remittance.member_id || HOUSE_MEMBER_ID) !== HOUSE_MEMBER_ID) return false;
    if (Number(remittance.amount || 0) <= 0) return false;
    const type = String(remittance.transaction_type || '').toLowerCase();
    return type === 'unknown payments' || type === 'unknown payment';
}

export function getUnclaimedRemittances(remittances = []) {
    return (remittances || []).filter(isUnclaimedRemittance).sort((a, b) => String(b.remittance_date || b.created_at || '').localeCompare(String(a.remittance_date || a.created_at || '')));
}

export function suggestUnclaimedMember(remittance, members = []) {
    const comment = [remittance?.description, remittance?.cheque_number].filter(Boolean).join(' ');
    const descriptionTokens = commentTokens(comment);
    if (!descriptionTokens.length) return { member: null, confidence: 0, candidates: [], reason: 'No comment or reference text is available.' };

    const scored = (members || []).filter(isActiveMember).map(member => {
        const match = scoreMemberName(member, descriptionTokens);
        const matchedScores = match.fieldScores.filter(score => score > 0).sort((a, b) => b - a);
        const confidence = matchedScores.length >= 2
            ? Math.round(Math.min(100, (matchedScores[0] + matchedScores[1]) * 50))
            : Math.round((matchedScores[0] || 0) * 50);
        return { member, confidence, matchedParts: match.matchedParts, evidence: match.evidence };
    }).sort((a, b) => b.confidence - a.confidence || b.matchedParts - a.matchedParts);

    const best = scored[0];
    const candidates = scored.slice(0, 5).filter(item => item.matchedParts >= 1 && item.confidence >= 35).map(item => item.member);
    if (!best || best.matchedParts < 2 || best.confidence <= 60) {
        return { member: null, confidence: best?.confidence || 0, candidates, reason: 'At least two distinct member-name parts did not match above the 60% approval threshold.' };
    }
    const next = scored[1];
    if (next && next.matchedParts >= 2 && next.confidence > 60 && best.confidence - next.confidence < 8) {
        return { member: null, confidence: best.confidence, candidates: [best.member, next.member], reason: 'The best matches are too close to safely auto-select.' };
    }
    return {
        member: best.member,
        confidence: best.confidence,
        matchedParts: best.matchedParts,
        candidates,
        reason: `${memberLabel(best.member)} matched ${best.matchedParts} name parts from the comment with ${best.confidence}% confidence.`
    };
}

export function buildFixedRemapDetails(remittance, enterpriseId) {
    const amount = Math.abs(Number(remittance?.amount || 0));
    if (!(amount > 0) || !enterpriseId) return [];
    return [{ enterprise_id: String(enterpriseId), amount, notes: 'Remap Unclaimed: approved by user' }];
}

export { HOUSE_MEMBER_ID, memberLabel };
