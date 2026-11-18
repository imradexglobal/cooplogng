const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2/options');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const db = admin.firestore();
const auth = admin.auth();

function text(value) {
  return String(value ?? '').trim();
}

function key(value) {
  return text(value).toLowerCase();
}

function phoneKey(value) {
  return text(value).replace(/\D/g, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isActiveMember(data, cooperativeId) {
  if (!data || data.is_deleted === true || Number(data.is_deleted) === 1) return false;
  if (text(data.cooperative_id) !== cooperativeId) return false;
  if (['archived', 'disabled', 'suspended', 'inactive'].includes(key(data.status))) return false;
  return true;
}

function safeSession(member, cooperativeId, cooperativeName) {
  return {
    memberId: member.id,
    cooperativeId,
    cooperativeName,
    displayName: [member.last_name, member.first_name, member.middle_name]
      .filter(Boolean).join(' ') || member.name || member.mobile || 'Member',
    registrationNumber: member.registration_no || member.special_id || null,
  };
}

async function findMember(identifier, cooperativeId) {
  const raw = text(identifier);
  const normalized = key(raw);
  const phone = phoneKey(raw);
  const candidates = new Map();
  const lookups = [
    ['special_id_lower', normalized],
    ['email_lower', normalized],
    ['registration_no_str', normalized],
  ];
  if (phone) lookups.push(['mobile', phone]);
  for (const [field, value] of lookups) {
    if (!value) continue;
    const snap = await db.collection('members')
      .where('cooperative_id', '==', cooperativeId)
      .where(field, '==', value)
      .limit(5).get();
    for (const doc of snap.docs) candidates.set(doc.id, { id: doc.id, ...doc.data() });
  }
  // Compatibility fallback for legacy records without normalized lookup fields.
  if (candidates.size === 0) {
    const snap = await db.collection('members').where('cooperative_id', '==', cooperativeId).limit(1000).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      const fields = [data.mobile, data.email, data.registration_no, data.special_id]
        .map(key);
      if (fields.includes(normalized) || (phone && phoneKey(data.mobile) === phone)) {
        candidates.set(doc.id, { id: doc.id, ...data });
      }
    }
  }
  const matches = [...candidates.values()].filter((m) => isActiveMember(m, cooperativeId));
  if (matches.length !== 1) return null;
  return matches[0];
}

async function cooperativeName(cooperativeId) {
  const snap = await db.collection('cooperatives').doc(cooperativeId).get();
  if (!snap.exists) return cooperativeId;
  const data = snap.data();
  return data.full_name || data.short_name || cooperativeId;
}

async function memberUid(cooperativeId, memberId) {
  return `cooplogng-member-${cooperativeId}-${memberId}`.replace(/[^A-Za-z0-9_.:@-]/g, '_');
}

async function issueMemberToken(member, cooperativeId) {
  const uid = await memberUid(cooperativeId, member.id);
  try {
    await auth.getUser(uid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    await auth.createUser({ uid, disabled: false });
  }
  await auth.setCustomUserClaims(uid, { role: 'member', memberId: member.id, cooperativeId });
  return auth.createCustomToken(uid, { role: 'member', memberId: member.id, cooperativeId });
}

exports.memberLogin = onCall({ enforceAppCheck: false }, async (request) => {
  const identifier = text(request.data?.identifier);
  const pin = text(request.data?.pin);
  const cooperativeId = text(request.data?.cooperativeId);
  if (!identifier || !pin || !cooperativeId) {
    throw new HttpsError('invalid-argument', 'Identifier, PIN and cooperative are required.');
  }
  const member = await findMember(identifier, cooperativeId);
  // Keep failures deliberately generic to avoid account enumeration.
  if (!member) throw new HttpsError('unauthenticated', 'Invalid member credentials.');
  const stored = text(member.password_hash);
  const suppliedHash = sha256(pin);
  const matches = stored === suppliedHash || stored === pin;
  if (!matches) throw new HttpsError('unauthenticated', 'Invalid member credentials.');
  if (member.force_password_change === true) {
    throw new HttpsError('failed-precondition', 'Password change is required before using member services.');
  }
  const token = await issueMemberToken(member, cooperativeId);
  await db.collection('members').doc(member.id).set({
    last_login: new Date().toISOString(),
    login_count: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
  return { token, session: safeSession(member, cooperativeId, await cooperativeName(cooperativeId)) };
});

function requireMember(request) {
  const token = request.auth?.token || {};
  const memberId = text(token.memberId);
  const cooperativeId = text(token.cooperativeId);
  if (!request.auth || token.role !== 'member' || !memberId || !cooperativeId) {
    throw new HttpsError('unauthenticated', 'A valid member session is required.');
  }
  return { memberId, cooperativeId };
}

function dateValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function includedDetail(detail, enterprise) {
  if (!enterprise) return true;
  const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
  return !(truthy(enterprise.revenue) && !truthy(enterprise.compulsory_due) && !truthy(enterprise.is_penalty));
}

exports.getMemberSnapshot = onCall(async (request) => {
  const { memberId, cooperativeId } = requireMember(request);
  const [memberSnap, enterpriseSnap, remittanceSnap, guarantorSnap] = await Promise.all([
    db.collection('members').doc(memberId).get(),
    db.collection('enterprise').where('cooperative_id', '==', cooperativeId).where('is_deleted', '==', 0).get(),
    db.collection('remittance').where('cooperative_id', '==', cooperativeId).where('member_id', '==', memberId).where('status', '==', 'Approved').where('is_deleted', '==', 0).limit(5000).get(),
    db.collection('loan_guarantors').where('cooperative_id', '==', cooperativeId).where('member_id', '==', memberId).where('is_deleted', '==', 0).limit(200).get(),
  ]);
  if (!memberSnap.exists || !isActiveMember({ id: memberId, ...memberSnap.data() }, cooperativeId)) {
    throw new HttpsError('permission-denied', 'Member account is unavailable.');
  }
  const enterprises = new Map(enterpriseSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const accounts = new Map();
  const transactions = [];
  const remittances = remittanceSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => dateValue(a.remittance_date || a.created_at) - dateValue(b.remittance_date || b.created_at) || text(a.created_at).localeCompare(text(b.created_at)) || a.id.localeCompare(b.id));
  let runningBalance = 0;
  for (const remittance of remittances) {
    for (const detail of Array.isArray(remittance.details) ? remittance.details : []) {
      const accountId = text(detail.enterprise_id || detail.item);
      const enterprise = enterprises.get(accountId);
      if (!includedDetail(detail, enterprise)) continue;
      const amount = Number(detail.amount) || 0;
      const account = accounts.get(accountId) || { id: accountId, name: enterprise?.account_name || 'Unknown account', balance: 0 };
      account.balance += amount;
      accounts.set(accountId, account);
      runningBalance += amount;
      transactions.push({
        id: text(detail.id || `${remittance.id}-${accountId}`),
        date: text(remittance.remittance_date || remittance.created_at),
        description: text(remittance.description),
        accountName: account.name,
        reference: remittance.id,
        debit: amount < 0 ? Math.abs(amount) : 0,
        credit: amount > 0 ? amount : 0,
        runningBalance,
        status: 'Approved',
      });
    }
  }
  const requests = [];
  for (const doc of guarantorSnap.docs) {
    const row = { id: doc.id, ...doc.data() };
    const loanSnap = row.loan_id ? await db.collection('loans').doc(row.loan_id).get() : null;
    const loan = loanSnap?.exists ? loanSnap.data() : {};
    const borrowerSnap = loan.member_id ? await db.collection('members').doc(String(loan.member_id)).get() : null;
    const borrower = borrowerSnap?.exists ? borrowerSnap.data() : {};
    requests.push({
      id: row.id,
      borrowerName: [borrower.last_name, borrower.first_name].filter(Boolean).join(' ') || 'Member',
      loanReference: text(row.loan_id),
      loanCategory: enterprises.get(String(loan.enterprise_id))?.account_name || 'Loan',
      principalAmount: Number(loan.principal_amount) || 0,
      guaranteeAmount: Number(row.guarantee_amount) || 0,
      status: row.guarantor_approval === null || row.guarantor_approval === undefined ? 'pending' : (row.guarantor_approval ? 'approved' : 'rejected'),
      requestedAt: text(row.created_at),
    });
  }
  return {
    session: safeSession({ id: memberId, ...memberSnap.data() }, cooperativeId, await cooperativeName(cooperativeId)),
    accounts: [...accounts.values()],
    recentTransactions: transactions.slice(-30).reverse(),
    guarantorRequests: requests,
    paymentAdvice: (Array.isArray(memberSnap.data().payment_advise) ? memberSnap.data().payment_advise : []).map((row) => ({
      id: text(row.id || `${memberId}-${row.enterprise_id}`),
      enterpriseId: text(row.enterprise_id),
      name: enterprises.get(String(row.enterprise_id))?.account_name || text(row.enterprise_id),
      amount: Number(row.amount) || 0,
      automatic: key(enterprises.get(String(row.enterprise_id))?.account_type) === 'loan',
    })),
    refreshedAt: new Date().toISOString(),
  };
});

exports.changeMemberPassword = onCall(async (request) => {
  const { memberId, cooperativeId } = requireMember(request);
  const currentPin = text(request.data?.currentPin);
  const newPin = text(request.data?.newPin);
  if (!/^\d{6}$/.test(newPin)) throw new HttpsError('invalid-argument', 'The new PIN must contain exactly six digits.');
  const ref = db.collection('members').doc(memberId);
  const snap = await ref.get();
  if (!snap.exists || !isActiveMember({ id: memberId, ...snap.data() }, cooperativeId)) throw new HttpsError('permission-denied', 'Member account is unavailable.');
  const member = snap.data();
  const currentHash = sha256(currentPin);
  if (text(member.password_hash) !== currentHash && text(member.password_hash) !== currentPin) throw new HttpsError('unauthenticated', 'Current PIN is incorrect.');
  await ref.set({ password_hash: sha256(newPin), force_password_change: false, modified_at: new Date().toISOString(), modified_by: memberId }, { merge: true });
  return { updated: true };
});

exports.updateMemberPaymentAdvice = onCall(async (request) => {
  const { memberId, cooperativeId } = requireMember(request);
  const submitted = request.data?.advice;
  if (!Array.isArray(submitted)) throw new HttpsError('invalid-argument', 'Payment advice must be a list.');
  const memberRef = db.collection('members').doc(memberId);
  const [memberSnap, enterpriseSnap, loansSnap] = await Promise.all([
    memberRef.get(),
    db.collection('enterprise').where('cooperative_id', '==', cooperativeId).where('is_deleted', '==', 0).get(),
    db.collection('loans').where('cooperative_id', '==', cooperativeId).where('member_id', '==', memberId).where('is_deleted', '==', 0).get(),
  ]);
  if (!memberSnap.exists || !isActiveMember({ id: memberId, ...memberSnap.data() }, cooperativeId)) throw new HttpsError('permission-denied', 'Member account is unavailable.');
  const enterprises = new Map(enterpriseSnap.docs.map((d) => [String(d.id), { id: d.id, ...d.data() }]));
  const loanEnterpriseIds = new Set(loansSnap.docs.filter((d) => !['declined', 'rejected', 'cancelled'].includes(key(d.data().status))).map((d) => String(d.data().enterprise_id || '')));
  const previous = Array.isArray(memberSnap.data().payment_advise) ? memberSnap.data().payment_advise : [];
  const previousByEnterprise = new Map(previous.map((row) => [String(row.enterprise_id), row]));
  const seen = new Set();
  const next = [];
  for (const row of submitted) {
    const enterpriseId = text(row?.enterprise_id);
    if (!enterpriseId || seen.has(enterpriseId)) continue;
    const enterprise = enterprises.get(enterpriseId);
    if (!enterprise) throw new HttpsError('invalid-argument', 'Payment advice contains an unknown enterprise.');
    const amount = Number(row?.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) throw new HttpsError('invalid-argument', 'Payment advice amount is invalid.');
    const isLoan = loanEnterpriseIds.has(enterpriseId) || key(enterprise.account_type) === 'loan';
    const prior = previousByEnterprise.get(enterpriseId);
    if (isLoan && prior && Number(prior.amount || 0) !== amount) throw new HttpsError('permission-denied', 'Loan payment advice is automatic and cannot be edited.');
    if (!isLoan && amount > 0) {
      next.push({ id: text(row.id) || `${cooperativeId}-${memberId}-${enterpriseId}`, enterprise_id: enterpriseId, amount: Math.ceil(amount / 100) * 100, created_at: text(row.created_at) || new Date().toISOString() });
    } else if (isLoan && prior) {
      next.push(prior);
    }
    seen.add(enterpriseId);
  }
  // Preserve automatic loan advice even when the client sends only editable rows.
  for (const [enterpriseId, prior] of previousByEnterprise) {
    if (loanEnterpriseIds.has(enterpriseId) && !seen.has(enterpriseId)) next.push(prior);
  }
  await memberRef.set({ payment_advise: next, modified_at: new Date().toISOString(), modified_by: memberId }, { merge: true });
  return { updated: true, advice: next };
});

exports.decideGuarantor = onCall(async (request) => {
  const { memberId, cooperativeId } = requireMember(request);
  const requestId = text(request.data?.requestId);
  const accept = request.data?.accept === true;
  if (!requestId) throw new HttpsError('invalid-argument', 'Guarantor request is required.');
  const ref = db.collection('loan_guarantors').doc(requestId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Guarantor request was not found.');
    const row = snap.data();
    if (text(row.cooperative_id) !== cooperativeId || text(row.member_id) !== memberId) throw new HttpsError('permission-denied', 'This request is not assigned to the current member.');
    if (row.guarantor_approval !== null && row.guarantor_approval !== undefined) throw new HttpsError('failed-precondition', 'This guarantor request has already been decided.');
    tx.update(ref, { guarantor_approval: accept ? 1 : 0, approved_at: new Date().toISOString(), modified_at: new Date().toISOString(), modified_by: memberId });
    return true;
  });
  return { updated: result };
});
