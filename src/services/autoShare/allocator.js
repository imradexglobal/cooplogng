/**
 * Auto Share allocation engine.
 * Distributes a remittance across eligible enterprises by payment-advice priority,
 * then routes any remainder to Savings enterprises configured with auto_rem.
 * Integer minor-unit arithmetic keeps every allocation exactly reconcilable.
 */

const DEFAULT_CURRENCY_SCALE = 2;

function toUnits(value, scale) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * scale) : 0;
}

function fromUnits(value, scale) {
  return value / scale;
}

function formatAmount(value, currencyScale) {
  return Number(value || 0).toFixed(currencyScale).replace(/\.?0+$/, '');
}

function isSavings(ent) {
  return String(ent?.account_type || ent?.type || '').trim().toLowerCase() === 'savings';
}

function isLoan(ent) {
  return String(ent?.account_type || ent?.type || '').trim().toLowerCase() === 'loan';
}

function getBalance(balanceByEnterprise, id) {
  if (Array.isArray(balanceByEnterprise)) {
    const row = balanceByEnterprise.find(item => String(item?.id) === String(id));
    return Number(row?.sum_of_amount) || 0;
  }
  return Number(balanceByEnterprise?.[String(id)]) || 0;
}

function isExcluded(ent) {
  return Number(ent?.revenue) === 1 || Number(ent?.is_penalty) === 1 || Number(ent?.compulsory_due) === 1;
}

function allocateRemainderUnits(totalUnits, recipients, weights) {
  if (totalUnits <= 0 || recipients.length === 0) return new Map();
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const divisor = totalWeight > 0 ? totalWeight : recipients.length;
  const effectiveWeights = totalWeight > 0 ? weights : recipients.map(() => 1);
  const unitsPerTen = 10 * 100;
  let remaining = totalUnits;
  const result = new Map();
  recipients.forEach((recipient, index) => {
    const key = String(recipient.id);
    if (index === recipients.length - 1) {
      // Concentrate all rounding residue (including cents) in one predictable
      // place: the final configured remainder recipient.
      result.set(key, remaining);
      return;
    }
    const proportionalUnits = totalUnits * effectiveWeights[index] / divisor;
    const roundedUnits = Math.floor(proportionalUnits / unitsPerTen) * unitsPerTen;
    result.set(key, roundedUnits);
    remaining -= roundedUnits;
  });
  return result;
}

/**
 * @param {Object} options
 * @param {number} options.remittanceAmount Total remittance in major units
 * @param {Array} options.enterprises Enterprise records (including auto_rem)
 * @param {Object} options.adviceByEnterprise Enterprise ID -> advised amount
 * @param {Object|Array} [options.balanceByEnterprise] Signed account balances;
 *   loan receivables are negative and are capped at their outstanding magnitude
 * @param {Object} [options.member]
 * @param {number} [options.currencyScale=2]
 */
function allocateAutoShare({
  remittanceAmount,
  enterprises = [],
  adviceByEnterprise = {},
  balanceByEnterprise = {},
  member,
  currencyScale = DEFAULT_CURRENCY_SCALE
}) {
  const scale = 10 ** currencyScale;
  const totalUnits = Math.max(0, toUnits(remittanceAmount, scale));
  const sourceEnterprises = Array.isArray(enterprises) ? enterprises : [];
  const eligible = sourceEnterprises.filter(ent => !isExcluded(ent)).slice().sort((a, b) => {
    const priorityDiff = (Number(a.distribution_priority) || 0) - (Number(b.distribution_priority) || 0);
    return priorityDiff || String(a.id).localeCompare(String(b.id));
  });
  const rows = eligible.map(ent => {
    const advised = Number(adviceByEnterprise?.[String(ent.id)]) || 0;
    const loanCapacity = isLoan(ent) ? Math.max(0, -getBalance(balanceByEnterprise, ent.id)) : null;
    const requiredUnits = Math.max(0, toUnits(advised, scale));
    return {
      enterpriseId: String(ent.id),
      enterpriseName: ent.account_name || 'Unknown',
      priority: Number(ent.distribution_priority) || 0,
      requiredUnits: loanCapacity === null ? requiredUnits : Math.min(requiredUnits, toUnits(loanCapacity, scale)),
      loanCapacityUnits: loanCapacity === null ? null : toUnits(loanCapacity, scale),
      allocatedUnits: 0,
      status: 'Skipped',
      reason: 'No required allocation (no payment advice)'
    };
  });

  let remainingUnits = totalUnits;
  for (const row of rows) {
    if (row.requiredUnits <= 0) continue;
    const allocated = Math.min(row.requiredUnits, remainingUnits);
    row.allocatedUnits = allocated;
    remainingUnits -= allocated;
    row.status = allocated < row.requiredUnits ? 'Partially Allocated' : 'Allocated';
    row.reason = row.status;
    if (remainingUnits === 0) break;
  }

  const configuredTargets = eligible.filter(ent => isSavings(ent) && Number(ent.auto_rem) > 0);
  const savingsTargets = eligible.filter(isSavings);
  // Remainder funds must never be routed to a Loan account. Loans may receive
  // only their outstanding balance through the advice allocation above.
  const fallbackTargets = savingsTargets;
  const remainderTargets = configuredTargets.length ? configuredTargets : fallbackTargets;
  let remainderPolicy = configuredTargets.length ? 'auto_rem' : (remainderTargets.length ? 'equal_fallback' : 'unallocated');
  const hadRemainder = remainingUnits > 0;

  if (remainingUnits > 0 && remainderTargets.length > 0) {
    let weights;
    if (configuredTargets.length === 1) {
      // A single configured Savings enterprise receives the complete remainder,
      // regardless of its percentage value.
      weights = [1];
    } else if (configuredTargets.length > 1) {
      const configuredTotal = configuredTargets.reduce((sum, ent) => sum + Number(ent.auto_rem || 0), 0);
      // Percent weights are honored only when their sum is exactly 100 (within
      // normal decimal-input precision). Otherwise split the remainder equally.
      weights = Math.abs(configuredTotal - 100) < 1e-8
        ? configuredTargets.map(ent => Number(ent.auto_rem))
        : configuredTargets.map(() => 1);
      if (Math.abs(configuredTotal - 100) >= 1e-8) remainderPolicy = 'equal_when_percent_total_not_100';
    } else {
      weights = remainderTargets.map(() => 1);
    }

    const split = allocateRemainderUnits(remainingUnits, remainderTargets, weights);
    for (const row of rows) {
      const added = split.get(row.enterpriseId) || 0;
      if (added > 0) {
        row.allocatedUnits += added;
        row.status = 'Remainder Allocated';
        row.reason = 'Remainder routed to Savings allocation';
      }
    }
    remainingUnits = 0;
  }

  const allocations = rows.map(row => ({
    enterpriseId: row.enterpriseId,
    enterpriseName: row.enterpriseName,
    priority: row.priority,
    requiredAmount: fromUnits(row.requiredUnits, scale),
    allocatedAmount: fromUnits(row.allocatedUnits, scale),
    status: row.status,
    reason: row.reason
  }));
  const allocatedUnits = allocations.reduce((sum, row) => sum + toUnits(row.allocatedAmount, scale), 0);
  const warnings = [];
  const excludedCount = sourceEnterprises.filter(isExcluded).length;
  if (excludedCount) {
    warnings.push({
      type: 'excluded_enterprises',
      message: `${excludedCount} enterprise${excludedCount > 1 ? 's' : ''} excluded from Auto Share (Revenue/Penalty/Compulsory Due)`,
      excludedCount
    });
  }
  if (remainingUnits > 0) {
    warnings.push({
      type: 'remainder',
      message: `${fromUnits(remainingUnits, scale).toFixed(currencyScale)} could not be allocated because no eligible enterprise is available`,
      remainder: fromUnits(remainingUnits, scale)
    });
  }
  if (eligible.length === 0 && sourceEnterprises.length > 0) {
    warnings.push({ type: 'no_eligible', message: 'No eligible enterprises found for Auto Share after exclusions', enterpriseCount: sourceEnterprises.length });
  }
  if (remainderPolicy === 'equal_when_percent_total_not_100' && configuredTargets.length > 1) {
    warnings.push({
      type: 'auto_rem_total_not_100',
      message: 'Configured savings percentages do not total 100%; the remaining balance was split equally among those savings enterprises.'
    });
  }
  if (!configuredTargets.length && savingsTargets.length && hadRemainder) {
    warnings.push({ type: 'auto_rem_fallback', message: 'No Savings % is configured; the remaining balance was split equally across eligible savings enterprises.' });
  }

  return {
    allocations,
    allocatedTotal: fromUnits(allocatedUnits, scale),
    remainder: fromUnits(remainingUnits, scale),
    warnings,
    remainderPolicy,
    member
  };
}

function validateAllocation(result, remittanceAmount) {
  const scale = 10 ** DEFAULT_CURRENCY_SCALE;
  const expected = Math.max(0, toUnits(remittanceAmount, scale));
  const allocated = toUnits(result?.allocatedTotal || 0, scale);
  const remainder = toUnits(result?.remainder || 0, scale);
  const warnings = [];
  if (allocated > expected) warnings.push(`Allocated total exceeds remittance amount.`);
  if (remainder < 0) warnings.push('Allocation resulted in negative remainder - data inconsistency detected.');
  if (allocated !== expected) warnings.push('Allocation details must equal the total remittance amount.');
  if (!result?.allocations?.length && expected > 0) warnings.push('No allocations generated - check enterprise configuration and member advice.');
  return warnings;
}

function formatPreview(result, currencyScale = DEFAULT_CURRENCY_SCALE) {
  const rows = (result?.allocations || []).map(alloc => ({
    enterpriseId: alloc.enterpriseId,
    enterpriseName: alloc.enterpriseName,
    priority: alloc.priority,
    requiredAmount: formatAmount(alloc.requiredAmount, currencyScale),
    allocatedAmount: formatAmount(alloc.allocatedAmount, currencyScale),
    remainingAfter: '',
    status: alloc.status
  }));
  return {
    rows,
    totalRemittance: Number(result?.allocatedTotal || 0) + Number(result?.remainder || 0),
    allocatedTotal: Number(result?.allocatedTotal || 0),
    remainder: Number(result?.remainder || 0),
    warnings: result?.warnings || [],
    remainderPolicy: result?.remainderPolicy || 'unallocated'
  };
}

export { allocateAutoShare, validateAllocation, formatPreview };
