import { generateId } from '../../utils/formatters.js'
import {
    getDocById_Global, queryRows, saveDoc,
    getTransactionTypes
} from '../sqliteService.js'
import { addRemittance } from './remittances.js'
import { calculateMonthlyLoanAdvice } from './loanAdvice.js'

export async function fetchGuarantorStats(memberId, cooperativeId) {
    const { getGuarantorStatsLocal } = await import('../sqliteService.js')
    return getGuarantorStatsLocal(memberId, cooperativeId)
}

export async function fetchPendingGuarantorRequests(memberId) {
    const { getPendingGuarantorRequestsLocal } = await import('../sqliteService.js')
    return getPendingGuarantorRequestsLocal(memberId)
}

export async function fetchMyGuarantorRequests(memberId) {
    const { getMyGuarantorRequestsLocal } = await import('../sqliteService.js')
    return getMyGuarantorRequestsLocal(memberId)
}

export async function setGuarantorDecision(loanId, guarantorId, approved, decidedBy) {
    const now = new Date().toISOString()
    const value = approved ? 1 : 0
    const existing = await getDocById_Global('loan_guarantors', guarantorId)
    if (!existing) throw new Error('Guarantor record not found.')
    await saveDoc('loan_guarantors', {
        ...existing,
        guarantor_approval: value,
        approved_at: approved ? now : (existing.approved_at || null),
        modified_at: now,
        modified_by: decidedBy || 'system',
        is_synced: 0,
    })
    // Keep the embedded guarantors[] on the parent loan in sync for
    // offline reads (saveDoc on loans rebuilds the child table).
    try {
        const loans = await queryRows(
            'SELECT * FROM loans WHERE remittance_id = ? AND is_deleted = 0',
            [loanId]
        )
        for (const loan of loans || []) {
            const guarantors = await queryRows(
                'SELECT * FROM loan_guarantors WHERE loan_id = ? AND is_deleted = 0',
                [loan.id]
            )
            await saveDoc('loans', { ...loan, guarantors, modified_at: now, modified_by: decidedBy || 'system' })
        }
    } catch (e) {
        console.warn('[dataService] Failed to sync parent loan guarantors:', e.message)
    }
}

export async function approveGuarantorRequest(loanId, guarantorId, approvedOrBy, maybeBy) {
    // Backward compatible:
    //  - approveGuarantorRequest(loanId, guarantorId, approvedBy)
    //  - approveGuarantorRequest(loanId, guarantorId, approved, approvedBy)
    let approved = true
    let decidedBy = approvedOrBy
    if (typeof approvedOrBy === 'boolean' || approvedOrBy === 1 || approvedOrBy === 0) {
        approved = approvedOrBy === true || approvedOrBy === 1
        decidedBy = maybeBy
    }
    return setGuarantorDecision(loanId, guarantorId, approved, decidedBy)
}

export async function rejectGuarantorRequest(loanId, guarantorId, decidedBy) {
    return setGuarantorDecision(loanId, guarantorId, false, decidedBy)
}

export async function approveLoanRequest(remittanceId, approvedBy, options = {}) {
    const now = new Date().toISOString()
    const remittance = await getDocById_Global('remittance', remittanceId)
    if (!remittance) throw new Error('Remittance not found')

    const cooperativeId = remittance.cooperative_id
    const { remittance_date, bank_name, charges: userCharges, details: userDetails } = options

    let parentCategory = remittance.category
    try {
        const types = await getTransactionTypes(String(cooperativeId))
        const tt = types.find(t => t.transaction_type === 'Member Loan')
        if (tt && tt.classification) {
            parentCategory = tt.classification
        }
    } catch (e) {
        console.error('[approveLoanRequest] Error fetching Member Loan classification:', e)
    }

    const remitUpdate = {
        ...remittance,
        status: 'Approved',
        transaction_type: 'Member Loan',
        category: parentCategory || 'Loan Asset',
        modified_at: now,
        modified_by: approvedBy,
        is_synced: 0
    }
    if (remittance_date) remitUpdate.remittance_date = remittance_date
    if (bank_name) remitUpdate.bank_name = bank_name
    if (userDetails) remitUpdate.details = userDetails
    await saveDoc('remittance', remitUpdate)

    let loans = await queryRows(
        'SELECT * FROM loans WHERE (id = ? OR remittance_id = ?) AND cooperative_id = ? AND is_deleted = 0',
        [remittanceId, remittanceId, cooperativeId]
    )

    // If no loan records exist yet (new request flow), create them from details[].loan_info
    if (!loans || loans.length === 0) {
        const details = userDetails || remittance.details || []
        for (const detail of details) {
            if (detail.loan_info) {
                const lInfo = detail.loan_info
                const loanData = lInfo.loanData || {}
                const loanId = lInfo.id || generateId(cooperativeId)
                const issuedDate = remittance_date || loanData.issueDate || loanData.issued_date || remittance.remittance_date || now
                const duration = parseInt(loanData.durationMonths || loanData.duration_months || 0, 10)
                let dueDate = loanData.dueDate || loanData.due_date || ''
                if (!dueDate && duration > 0) {
                    const issueD = new Date(issuedDate)
                    if (!isNaN(issueD.getTime())) {
                        issueD.setMonth(issueD.getMonth() + duration)
                        dueDate = issueD.toISOString()
                    }
                }
                const loanDoc = {
                    id: loanId,
                    cooperative_id: String(cooperativeId),
                    member_id: remittance.member_id || '0000000000',
                    enterprise_id: detail.enterprise_id || detail.item || '',
                    principal_amount: Math.abs(parseFloat(loanData.principalAmount || loanData.principal_amount || 0)),
                    issued_date: issuedDate,
                    due_date: dueDate,
                    status: 'Pending',
                    notes: loanData.notes || '',
                    remittance_id: remittanceId,
                    duration_months: duration,
                    monthly_advice_amount: calculateMonthlyLoanAdvice(loanData.principalAmount || loanData.principal_amount || 0, duration),
                    admin_fee_id: null,
                    created_at: now,
                    created_by: approvedBy || 'system',
                    modified_at: now,
                    modified_by: approvedBy || 'system',
                    is_deleted: 0,
                    is_synced: 0
                }
                await saveDoc('loans', loanDoc)

                // Create guarantor records
                const guarantors = lInfo.guarantors || []
                for (const g of guarantors) {
                    const gId = g.id || generateId(cooperativeId)
                    await saveDoc('loan_guarantors', {
                        id: gId,
                        cooperative_id: String(cooperativeId),
                        loan_id: loanId,
                        member_id: String(g.member_id),
                        guarantee_amount: parseFloat(g.guarantee_amount || g.amount || 0),
                        guarantor_approval: g.guarantor_approval !== undefined ? g.guarantor_approval : null,
                        created_at: now,
                        created_by: approvedBy || 'system',
                        modified_at: now,
                        modified_by: approvedBy || 'system',
                        is_deleted: 0,
                        is_synced: 0
                    })
                }

                loans.push(loanDoc)
            }
        }
    }

    let chargeIndex = 0
    let pickupIndex = 0

    for (const loan of loans) {
        if (loan.status === 'Active') continue

        const duration = parseInt(loan.duration_months) || 0
        let dueDate = loan.due_date
        let issuedDate = loan.issued_date
        if (remittance_date) {
            issuedDate = remittance_date
            const issueD = new Date(remittance_date)
            if (!isNaN(issueD.getTime())) {
                issueD.setMonth(issueD.getMonth() + duration)
                dueDate = issueD.toISOString()
            }
        }

        await saveDoc('loans', {
            ...loan,
            status: 'Active',
            monthly_advice_amount: calculateMonthlyLoanAdvice(loan.principal_amount, loan.duration_months),
            issued_date: issuedDate,
            due_date: dueDate,
            modified_at: now,
            modified_by: approvedBy,
            is_synced: 0
        })

        const guarantors = await queryRows(
            'SELECT * FROM loan_guarantors WHERE loan_id = ? AND is_deleted = 0',
            [loan.id]
        )
        for (const g of guarantors) {
            await saveDoc('loan_guarantors', {
                ...g,
                guarantor_approval: 1,
                modified_at: now,
                modified_by: approvedBy,
                is_synced: 0
            })
        }

        if (userCharges && Array.isArray(userCharges) && userCharges.length > 0) {
            const principalAmount = Math.abs(parseFloat(loan.principal_amount || 0))
            let loanChargeTotal = 0
            for (const charge of userCharges) {
                let val = parseFloat(charge.value) || 0
                if (charge.type === 'percentage') {
                    val = (val / 100) * principalAmount
                }
                if (val > 0) {
                    loanChargeTotal += val
                    chargeIndex++
                    const chargeId = `${remittanceId}-CHARGE-${chargeIndex}`
                    const chargeDate = remittance_date || remittance.remittance_date
                    await addRemittance({
                        id: chargeId,
                        cooperative_id: cooperativeId,
                        member_id: loan.member_id || remittance.member_id,
                        amount: -val,
                        remittance_date: chargeDate,
                        bank_name: 'Internal Transfer',
                        transaction_type: 'Loan Charges',
                        category: 'Loan Asset',
                        description: `Loan Charge: ${charge.name}`,
                        autogen: 1,
                        loan_id: loan.id || remittanceId,
                        parent_remittance_id: remittanceId,
                        status: 'Approved',
                        details: [{
                            id: `${chargeId}_detail`,
                            enterprise_id: loan.enterprise_id,
                            amount: -val,
                            notes: charge.name,
                            auto_description: charge.name
                        }]
                    }, approvedBy)
                }
            }
            // Loan income pickup (one per loan): +ve Internal Transfer to admin
            // 0000000000 totalling this approval run's charges above. Header
            // only (no details on admin remittances).
            if (loanChargeTotal > 0) {
                pickupIndex++
                let pickupMemberName = loan.member_id || remittance.member_id
                try {
                    const mDoc = await getDocById_Global('members', pickupMemberName)
                    if (mDoc) {
                        pickupMemberName = [mDoc.last_name, mDoc.first_name, mDoc.middle_name].filter(Boolean).join(' ')
                            || mDoc.name || pickupMemberName
                    }
                } catch {}
                await addRemittance({
                    id: `${remittanceId}-LOANPICKUP-${pickupIndex}`,
                    cooperative_id: cooperativeId,
                    member_id: '0000000000',
                    amount: loanChargeTotal,
                    remittance_date: remittance_date || remittance.remittance_date,
                    bank_name: 'Internal Transfer',
                    transaction_type: 'Loan Charges',
                    category: 'Loan Income',
                    description: `Auto Loan Charges Income - ${pickupMemberName}`,
                    autogen: 1,
                    loan_id: loan.id || remittanceId,
                    parent_remittance_id: remittanceId,
                    status: 'Approved',
                }, approvedBy)
            }
        }

        if (loan.duration_months > 0 && loan.principal_amount > 0) {
            const { saveDoc: saveAdvice, queryRows: queryAdvice, loadDoc } = await import('../sqliteService.js')
            const monthlyInst = calculateMonthlyLoanAdvice(loan.principal_amount, loan.duration_months)
            const advises = await queryAdvice(
                'SELECT * FROM payment_advise WHERE cooperative_id = ? AND member_id = ? AND enterprise_id = ? AND is_deleted = 0',
                [String(cooperativeId), loan.member_id, loan.enterprise_id]
            )
            const adviceDoc = {
                id: advises[0]?.id || generateId(cooperativeId),
                cooperative_id: cooperativeId,
                member_id: String(loan.member_id),
                enterprise_id: String(loan.enterprise_id),
                amount: monthlyInst,
                created_at: advises[0]?.created_at || now,
                created_by: advises[0]?.created_by || approvedBy || 'system',
                modified_at: now,
                modified_by: approvedBy || 'system',
                is_deleted: 0,
                is_synced: 0
            }
            await saveAdvice('payment_advise', adviceDoc)
        }
    }
}

export async function declineLoanRequest(remittanceId, declinedBy) {
    const now = new Date().toISOString()
    try {
        const target = await getDocById_Global('remittance', remittanceId)
        if (!target) throw new Error('Remittance not found')

        if (target.status !== 'Declined') {
            await saveDoc('remittance', {
                ...target,
                status: 'Declined',
                modified_at: now,
                modified_by: declinedBy,
                is_synced: 0
            })
        }

        const loans = await queryRows(
            'SELECT * FROM loans WHERE (id = ? OR remittance_id = ?) AND cooperative_id = ? AND is_deleted = 0',
            [remittanceId, remittanceId, target.cooperative_id]
        )
        for (const loan of loans) {
            if (loan.status === 'Declined') continue
            await saveDoc('loans', {
                ...loan,
                status: 'Declined',
                modified_at: now,
                modified_by: declinedBy,
                is_synced: 0
            })

            const guarantors = await queryRows(
                'SELECT * FROM loan_guarantors WHERE loan_id = ? AND is_deleted = 0',
                [loan.id]
            )
            for (const g of guarantors) {
                await saveDoc('loan_guarantors', {
                    ...g,
                    guarantor_approval: 0,
                    modified_at: now,
                    modified_by: declinedBy,
                    is_synced: 0
                })
            }
        }
    } catch (e) {
        console.error('[declineLoanRequest] Error:', e)
        throw e
    }
}
