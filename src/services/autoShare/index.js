import { allocateAutoShare, validateAllocation, formatPreview } from './allocator.js';
import { fetchMemberPaymentAdvise } from '../data/members.js';
import { fetchEnterprises } from '../data/enterprises.js';
import { addRemittance, updateRemittance } from '../../services/data/remittances.js';
import { generateId } from '../../utils/formatters.js';
import { getDocById_Global } from '../sqliteService.js';
import { resolveAutoShareStatus } from './status.js';

/**
 * Build the advice-by-enterprise map for a given member.
 * 
 * @param {string} memberId - Member ID
 * @param {string} cooperativeId - Cooperative ID
 * @returns {Object} Map of enterprise_id (string) -> advised amount (major units)
 */
async function buildAdviceByEnterprise(memberId, cooperativeId) {
  const adviceByEnterprise = {};

  try {
    const adviceTable = await fetchMemberPaymentAdvise(memberId);
    if (adviceTable && Array.isArray(adviceTable)) {
      for (const adv of adviceTable) {
        if (!adv.is_deleted && adv.enterprise_id && adv.amount > 0) {
          adviceByEnterprise[String(adv.enterprise_id)] =
            parseFloat(adv.amount) || 0;
        }
      }
    }
  } catch (e) {
    console.error('[autoShare] Error fetching member payment advice:', e.message);
  }

  return adviceByEnterprise;
}

/**
 * Load eligible enterprises for a cooperative, excluding deleted/inactive ones.
 * 
 * @param {string} cooperativeId - Cooperative ID
 * @returns {Promise<Array>} Array of enterprise account objects
 */
async function loadEligibleEnterprises(cooperativeId) {
  try {
    const enterprises = await fetchEnterprises(cooperativeId, true); // include all, we filter ourselves
    // Filter out deleted enterprises
    return enterprises.filter(ent => !(ent.is_deleted === 1 || ent.deleted === 1));
  } catch (e) {
    console.error('[autoShare] Error loading enterprises:', e.message);
    return [];
  }
}

/**
 * Preview Auto Share allocation for a remittance.
 * 
 * This function prepares the data needed for the Auto Share preview UI,
 * but does NOT save anything. It uses the existing remittance lifecycle.
 * 
 * @param {Object} options
 * @param {string} options.cooperativeId - Cooperative ID
 * @param {string} [options.memberId] - Member ID (required for advice lookup)
 * @param {number} options.remittanceAmount - Total amount being remitted
 * @param {Object} [options.member] - Member object (optional, fetched if memberId provided)
 * @returns {Promise<Object>} Preview result with allocations, warnings, etc.
 */
export async function previewAutoShare({
  cooperativeId,
  memberId,
  remittanceAmount,
  member
}) {
  // Load enterprises for this cooperative
  const enterprises = await loadEligibleEnterprises(cooperativeId);

  // Load payment advice if memberId provided
  let adviceByEnterprise = {};
  if (memberId) {
    adviceByEnterprise = await buildAdviceByEnterprise(memberId, cooperativeId);
  }

  // Run the allocation engine
  const allocationResult = allocateAutoShare({
    remittanceAmount,
    enterprises,
    adviceByEnterprise,
    member
  });

  // Validate the allocation
  const validationWarnings = validateAllocation(allocationResult, remittanceAmount);

  // Format for preview display
  const preview = formatPreview(allocationResult, 2);

  return {
    // Core allocation data
    allocations: preview.rows,
    totalRemittance: remittanceAmount,
    allocatedTotal: preview.allocatedTotal,
    remainder: preview.remainder,

    // Enterprise and member context
    enterprises,
    memberId,

    // Warnings and policy info
    warnings: [...allocationResult.warnings, ...validationWarnings],
    policy: 'priority-based-with-advice',

    // Metadata for audit
    calculationDate: new Date().toISOString(),
    currencyScale: 2,

    // Summary info for UI
    eligibleEnterpriseCount: allocationResult.allocations.length,
    totalEnterprises: enterprises.length,
    excludedEnterpriseCount:
      (enterprises.filter(
        ent => ent.revenue === 1 || ent.is_penalty === 1 || ent.compulsory_due === 1
      ).length || 0)
  };
}

/**
 * Confirm and save Auto Share allocation.
 * 
 * This function creates or updates a remittance record with the Auto Share
 * allocation details. It reuses the existing addRemittance/updateRemittance
 * lifecycle.
 * 
 * @param {Object} options
 * @param {string} options.cooperativeId - Cooperative ID
 * @param {string} [options.memberId] - Member ID (defaults to current user)
 * @param {number} options.remittanceAmount - Total amount being remitted
 * @param {Array} options.allocations - Array of {enterprise_id, amount} objects
 *   as returned by the preview
 * @param {string} options.remittanceDate - Remittance date
 * @param {string} options.bankName - Bank name
 * @param {string} options.description - Description
 * @param {string} [options.createdBy] - User who creates the remittance
 * @param {boolean} [options.canApprove=false] - Whether the current user may approve remittances
 * @returns {Promise<Object>} - { remittanceId, detailsSaved }
 */
export async function confirmAutoShare({
  cooperativeId,
  memberId,
  remittanceAmount,
  allocations,
  remittanceDate,
  bankName,
  description,
  createdBy,
  canApprove = false
}) {
  const remittanceStatus = resolveAutoShareStatus(canApprove);
  // Build detail rows for the remittance
  const detailRows = (allocations || []).map(detail => ({
    enterprise_id: String(detail.enterprise_id),
    amount: parseFloat(detail.allocated_amount) || 0,
    auto_description: `Auto Share allocation (priority and Savings remainder, version v2)`,
    notes: `Auto Share v2: allocated at priority ${detail.priority || 0}`,
    loan_info: null
  })).filter(detail => detail.amount > 0);

  const remittanceCents = Math.round((Number(remittanceAmount) || 0) * 100);
  const totalDetailCents = detailRows.reduce((sum, detail) => sum + Math.round(detail.amount * 100), 0);
  if (detailRows.some(detail => detail.amount < 0) || totalDetailCents !== remittanceCents) {
    throw new Error('Auto Share details must equal the remittance amount exactly before saving.');
  }
  const adjustedDetails = detailRows.map(detail => ({
    ...detail,
    amount: Math.round(detail.amount * 100) / 100
  }));

  // Create or update the remittance record
  const remittanceData = {
    cooperative_id: String(cooperativeId),
    member_id: memberId || '0000000000',
    amount: remittanceAmount,
    remittance_date: remittanceDate || new Date().toISOString(),
    bank_name: bankName || '',
    description: description || 'Auto Share Remittance',
    transaction_type: 'Member Deposit',
    status: remittanceStatus,
    details: adjustedDetails,
    autogen: 1, // Mark as Auto Generated
    parent_remittance_id: null,
    isLoanRequest: false,
    isWithdrawalRequest: false
  };

  // Use the existing addRemittance pathway
  const { id } = await addRemittance(remittanceData, createdBy || 'system');

  return {
    remittanceId: id,
    detailsSaved: adjustedDetails.length,
    totalAllocated: totalDetailCents / 100,
    remainder: 0,
    status: remittanceStatus
  };
}

/**
 * Get the amount a member is advised to pay to a specific enterprise.
 * 
 * @param {string} memberId - Member ID
 * @param {string} enterpriseId - Enterprise ID
 * @param {string} cooperativeId - Cooperative ID
 * @returns {Promise<number>} Advised amount (0 if no advice)
 */
export async function getAdviceForEnterprise(memberId, enterpriseId, cooperativeId) {
  try {
    const adviceTable = await fetchMemberPaymentAdvise(memberId);
    if (adviceTable && Array.isArray(adviceTable)) {
      for (const adv of adviceTable) {
        if (
          !adv.is_deleted &&
          String(adv.enterprise_id) === String(enterpriseId) &&
          adv.amount > 0
        ) {
          return parseFloat(adv.amount) || 0;
        }
      }
    }
  } catch (e) {
    console.error(
      '[autoShare] Error getting advice for enterprise:',
      e.message
    );
  }
  return 0;
}

/**
 * Update existing remittance details with Auto Share allocation.
 * 
 * Replaces existing Auto Share details without affecting manually entered
 * details (identified by auto_description).
 * 
 * @param {string} remittanceId - Existing remittance ID
 * @param {Array} newAllocations - New allocation details
 * @param {string} modifiedBy - User modifying the remittance
 * @returns {Promise<Object>} Updated remittance summary
 */
export async function updateAutoShareDetails(remittanceId, newAllocations, modifiedBy) {
  const existing = await getDocById_Global('remittance', remittanceId);
  if (!existing) throw new Error('Remittance not found');

  // Separate existing details into Auto Share and manual
  const existingDetails = existing.details || [];

  const autoShareDetailIds = new Set();
  const manualDetails = [];

  for (const detail of existingDetails) {
    const ad = detail.auto_description || '';
    if (ad.includes('Auto Share') || ad.includes('auto share')) {
      autoShareDetailIds.add(String(detail.id));
    } else {
      manualDetails.push(detail);
    }
  }

  // Build new details: replace Auto Share with new allocations, keep manual
  const newDetailRows = newAllocations.map(detail => ({
    id: detail.id || generateId(String(existing.cooperative_id)),
    remittance_id: remittanceId,
    cooperative_id: String(existing.cooperative_id),
    enterprise_id: String(detail.enterprise_id),
    amount: parseFloat(detail.allocated_amount) || 0,
    auto_description: `Auto Share allocation (priority-based, version v1, updated)`,
    notes: `Auto Share: allocated at priority ${detail.priority || 0}`,
    loan_info: null,
    is_deleted: 0,
    is_synced: 0,
    created_at: detail.created_at || new Date().toISOString(),
    created_by: detail.created_by || modifiedBy || 'system',
    modified_at: new Date().toISOString(),
    modified_by: modifiedBy || 'system',
    is_synced: 0
  }));

  // Combine: manual details + new Auto Share details
  const allDetails = [...manualDetails, ...newDetailRows];

  // Update the remittance
  await updateRemittance(remittanceId, {
    details: allDetails,
    modifiedBy
  }, modifiedBy);

  return {
    remittanceId,
    manualDetailsKept: manualDetails.length,
    autoShareDetailsUpdated: newAllocations.length,
    totalAllocated: newDetailRows.reduce(
      (sum, d) => sum + (d.amount || 0),
      0
    )
  };
}

/**
 * Cancel an Auto Share operation - revert to previous state.
 * 
 * @param {string} remittanceId - Remittance to revert
 * @param {string} modifiedBy - User reverting the change
 * @returns {Promise<boolean>} True if successfully reverted
 */
export async function cancelAutoShare(remittanceId, modifiedBy) {
  const existing = await getDocById_Global('remittance', remittanceId);
  if (!existing) return false;

  // If the remittance has no Auto Share details, nothing to revert
  const hasAutoShare = (existing.details || []).some(
    d => (d.auto_description || '').includes('Auto Share')
  );

  if (!hasAutoShare) return false;

  // Remove Auto Share details and restore previous state
  const nonAutoShareDetails = (existing.details || []).filter(
    d => !(d.auto_description || '').includes('Auto Share')
  );

  await updateRemittance(remittanceId, {
    details: nonAutoShareDetails,
    modifiedBy
  }, modifiedBy);

  return true;
}

export { allocateAutoShare, validateAllocation, formatPreview };
