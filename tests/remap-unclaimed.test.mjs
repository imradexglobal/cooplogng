import test from 'node:test';
import assert from 'node:assert/strict';
import { getUnclaimedRemittances, suggestUnclaimedMember, buildFixedRemapDetails, buildRemapLearningPattern, learnedPatternSimilarity } from '../src/services/remapUnclaimed.js';

const member = { id: 'm1', first_name: 'Wasiu', middle_name: 'Abdul', last_name: 'Adebowale', registration_no: 'REG-101' };

test('Remap Unclaimed matches case-insensitively and tolerates a small spelling difference', () => {
    const result = suggestUnclaimedMember({ description: 'PAYMENT FROM adebowalE wasiu', amount: 100 }, [member]);
    assert.equal(result.member?.id, 'm1');
    assert.ok(result.confidence > 60);

    const typo = suggestUnclaimedMember({ description: 'transfer from Taofekah Adebowale', amount: 100 }, [{ id: 'm2', first_name: 'Taofekat', last_name: 'Adebowale' }]);
    assert.equal(typo.member?.id, 'm2');
    assert.ok(typo.confidence > 60);
});

test('Remap Unclaimed requires two distinct real-name parts and handles initials and abbreviations', () => {
    const fullName = { id: 'm-full', first_name: 'Adebowale', middle_name: 'Abdul-wasiu', last_name: 'Adewale' };
    const comments = [
        'Adebowale AA',
        'Abdulwasiu AA',
        'Adewale AA',
        'Adebowale A Ade',
        'Adebowale Abdulwasiu',
        'Abdulwasiu Adewale',
        'Abdul Adebowale',
        'Adebowal Adew'
    ];
    for (const description of comments) {
        const result = suggestUnclaimedMember({ description, amount: 100 }, [fullName]);
        assert.equal(result.member?.id, 'm-full', description);
        assert.ok(result.matchedParts >= 2, description);
        assert.ok(result.confidence > 60, description);
    }
});

test('a comment with no member-name evidence is never matched from unrelated text', () => {
    const result = suggestUnclaimedMember({ description: 'MONTHLY PAYMENT FOR COOPERATIVE ACCOUNT', amount: 100 }, [member]);
    assert.equal(result.member, null);
    assert.equal(result.matchedParts, undefined);
    assert.ok(result.confidence <= 60);
});

test('weak or ambiguous remap suggestions are not auto-selected', () => {
    const weak = suggestUnclaimedMember({ description: 'monthly payment', amount: 100 }, [member]);
    assert.equal(weak.member, null);
    assert.ok(weak.confidence <= 60);
});

test('only positive Unknown Payments are considered unclaimed', () => {
    const rows = getUnclaimedRemittances([
        { id: 'u1', member_id: '0000000000', amount: 100, transaction_type: 'Unknown Payments' },
        { id: 'known', member_id: 'm1', amount: 100, transaction_type: 'Member Deposit' },
        { id: 'negative', member_id: '0000000000', amount: -100, transaction_type: 'Unknown Payments' },
        { id: 'blank-type', member_id: '0000000000', amount: 100 },
        { id: 'debit', member_id: '0000000000', amount: 100, transaction_type: 'Debit' }
    ]);
    assert.deepEqual(rows.map(row => row.id), ['u1']);
});

test('manual remap learning identifies repeated OLABANJI name patterns', () => {
    const source = { description: 'TNF-OLABANJI B F MRS/MOBILEUNION Transfer from OLA 000018260223110227001770118954 | Ref: 000018260223110227001770118954' };
    const similar = { description: 'OLABANJI B F MRS MOBILEUNION transfer received' };
    const unrelated = { description: 'OLUWASEUN B F MRS MOBILEUNION transfer received' };
    const pattern = buildRemapLearningPattern(source);
    assert.equal(learnedPatternSimilarity(pattern, buildRemapLearningPattern(similar)).matches, true);
    assert.equal(learnedPatternSimilarity(pattern, buildRemapLearningPattern(unrelated)).matches, false);
});

test('fixed remap details credit the selected enterprise with the remittance amount', () => {
    assert.deepEqual(buildFixedRemapDetails({ amount: 125.5 }, 'ent-1'), [{ enterprise_id: 'ent-1', amount: 125.5, notes: 'Remap Unclaimed: approved by user' }]);
});
