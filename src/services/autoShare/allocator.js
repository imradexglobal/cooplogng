/**
 * Auto Share allocation engine.
 * 
 * Distributes a remittance amount across eligible enterprise accounts
 * using a priority-based waterfall algorithm.
 * 
 * This module is deliberately pure - it accepts normalized data and
 * returns a normalized result with no DOM, database, or session dependencies.
 */

import { generateId, formatCurrency } from '../../utils/formatters.js';

const DEFAULT_CURRENCY_SCALE = 2;

/**
 * Core allocation result structure.
 */
function AllocationResult() {
  this.allocations = [];
  this.allocatedTotal = 0;
  this.remainder = 0;
  this.warnings = [];
}

/**
 * Per-enterprise allocation entry.
 * @typedef {Object} AllocationEntry
 * @property {string} enterpriseId - Enterprise account ID
 * @property {string} enterpriseName - Enterprise account name
 * @property {number} priority - Configured priority (lower = first)
 * @property {number} requiredAmount - Amount eligible for allocation (D)
 * @property {number} allocatedAmount - Amount actually allocated (A)
 * @property {string} status - 'Allocated', 'Skipped', 'Excluded'
 */

/**
 * Main allocation function.
 * 
 * @param {Object} options - Allocation options
 * @param {number} options.remittanceAmount - Total amount to distribute (major units)
 * @param {Array} options.enterprises - Enterprise account objects from settings
 *   Each enterprise must have: id, account_name, distribution_priority,
 *   compulsory_due (0|1), compulsory_amount (optional), revenue (0|1),
 *   is_penalty (0|1), account_type (optional)
 * @param {Object} options.adviceByEnterprise - Map of enterprise_id (string) ->
 *   advised amount (major units, from payment_advise table), or undefined if no advice
 * @param {Object} options.member - Member object (may be minimal; only used for
 *   balance-derived D if no advice available)
 * @param {number} [options.currencyScale=2] - Decimal places for minor units
 * @returns {Object} - { allocations: AllocationEntry[], allocatedTotal, remainder, warnings }
 */
function allocateAutoShare({
  remittanceAmount,
  enterprises,
  adviceByEnterprise,
  member,
  currencyScale = DEFAULT_CURRENCY_SCALE
}) {
  const SCALE = 10 ** currencyScale;

  // 1. Filter out excluded enterprises
  // Compulsory Due, Penalty, and Revenue are ALWAYS excluded, regardless of priority.
  const excludedCategories = {
    compulsory_due: 1,
    is_penalty: 1,
    revenue: 1
  };

  const eligible = enterprises.filter(ent => {
    // Exclude Revenue
    if (ent.revenue === 1) return false;
    // Exclude Penalty
    if (ent.is_penalty === 1) return false;
    // Exclude Compulsory Due
    if (ent.compulsory_due === 1) return false;
    return true;
  });

  // 2. Sort by priority (ascending), deterministic tie-breaker
  // Lower distribution_priority number = settled first.
  // Tie-break by enterprise ID (string comparison) for stability.
  eligible.sort((a, b) => {
    const pa = Number(a.distribution_priority) || 0;
    const pb = Number(b.distribution_priority) || 0;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });

  // 3. Waterfall allocation
  let remaining = Math.round(remittanceAmount * SCALE) / SCALE;
  const allocations = [];
  let totalAllocated = 0;

  for (const ent of eligible) {
    // Determine required amount D for this enterprise
    let required = 0;

    // Use payment advice as the primary source for D
    const adviceAmount = adviceByEnterprise && adviceByEnterprise[String(ent.id)];
    if (adviceAmount != null && adviceAmount > 0) {
      required = Math.round(adviceAmount * SCALE) / SCALE;
    } else {
      // No payment advice available; required amount is 0 → enterprise will be skipped
      // but we still include it in the preview with status 'Skipped'
      required = 0;
    }

    // If required is zero or negative, skip this enterprise
    if (required <= 0) {
      allocations.push({
        enterpriseId: String(ent.id),
        enterpriseName: ent.account_name || 'Unknown',
        priority: Number(ent.distribution_priority) || 0,
        requiredAmount: 0,
        allocatedAmount: 0,
        status: 'Skipped',
        reason: 'No required allocation (no payment advice)'
      });
      continue;
    }

    // Allocate: A = MIN(D, R)
    const allocated = Math.min(required, remaining);

    // Reduce remaining amount
    remaining = Math.max(remaining - allocated, 0);
    // Round to avoid floating-point drift
    remaining = Math.round(remaining * SCALE) / SCALE;

    totalAllocated += allocated;

    const status = allocated < required ? 'Partially Allocated' : 'Allocated';

    allocations.push({
      enterpriseId: String(ent.id),
      enterpriseName: ent.account_name || 'Unknown',
      priority: Number(ent.distribution_priority) || 0,
      requiredAmount: required,
      allocatedAmount: allocated,
      status,
      reason: status
    });
  }

  // 4. Build result
  const result = new AllocationResult();
  result.allocations = allocations;
  result.allocatedTotal = Math.round(totalAllocated * SCALE) / SCALE;
  result.remainder = Math.round(remaining * SCALE) / SCALE;

  // 5. Warnings

  // Warn about excluded enterprises
  const excluded = enterprises.filter(ent => {
    return ent.revenue === 1 || ent.is_penalty === 1 || ent.compulsory_due === 1;
  });
  if (excluded.length > 0) {
    result.warnings.push({
      type: 'excluded_enterprises',
      message: `${excluded.length} enterprise${
        excluded.length > 1 ? 's' : ''
      } excluded from Auto Share (Revenue/Penalty/Compulsory Due)`,
      excludedCount: excluded.length
    });
  }

  // Warn about remainder
  if (result.remainder > 0) {
    result.warnings.push({
      type: 'remainder',
      message: `${result.remainder.toFixed(
        currencyScale
      )} unallocated balance after priority-based distribution`,
      remainder: result.remainder
    });
  }

  // Warn if no eligible enterprises found
  if (eligible.length === 0 && enterprises.length > 0) {
    result.warnings.push({
      type: 'no_eligible',
      message: 'No eligible enterprises found for Auto Share after exclusions',
      enterpriseCount: enterprises.length
    });
  }

  return result;
}

/**
 * Validate the allocation result for compliance with business rules.
 * 
 * @param {Object} result - Result from allocateAutoShare()
 * @param {number} remittanceAmount - Original remittance amount
 * @returns {Array} - Array of warning strings (empty if valid)
 */
function validateAllocation(result, remittanceAmount) {
  const warnings = [];

  // FR-05: Total of all detail allocations shall never exceed the parent remittance amount
  if (result.allocatedTotal > remittanceAmount) {
    warnings.push(
      `Allocated total (₦${result.allocatedTotal.toFixed(
        2
      )}) exceeds remittance amount (₦${remittanceAmount.toFixed(
        2
      )}).`
    );
  }

  // FR-06: Remainder must be explicit
  if (result.remainder < 0) {
    warnings.push('Allocation resulted in negative remainder - data inconsistency detected.');
  }

  // FR-11: Every automatically generated allocation shall identify the policy
  if (result.allocations.length === 0 && warnings.length === 0) {
    warnings.push('No allocations generated - check enterprise configuration and member advice.');
  }

  return warnings;
}

/**
 * Format allocation result for display in the Auto Share preview.
 * 
 * @param {Object} result - Result from allocateAutoShare()
 * @param {number} currencyScale - Decimal places
 * @returns {Object} - { rows, totalRemittance, allocatedTotal, remainder, warnings }
 */
function formatPreview(result, currencyScale = 2) {
  const rows = [];

  for (const alloc of result.allocations) {
    rows.push({
      enterpriseId: alloc.enterpriseId,
      enterpriseName: alloc.enterpriseName,
      priority: alloc.priority,
      requiredAmount: alloc.requiredAmount.toFixed(currencyScale),
      allocatedAmount: alloc.allocatedAmount.toFixed(currencyScale),
      remainingAfter: '',
      status: alloc.status
    });
  }

  return {
    rows,
    totalRemittance: result.allocatedTotal + result.remainder,
    allocatedTotal: result.allocatedTotal,
    remainder: result.remainder,
    warnings: result.warnings
  };
}

export { allocateAutoShare, validateAllocation, formatPreview };
