/**
 * Calculate the monthly payment advice for an approved loan.
 * Installments are rounded UP to the next 100 currency units so a loan is not
 * under-advised (e.g. 50,000 over 6 months => 8,400 per month).
 */
export function calculateMonthlyLoanAdvice(principalAmount, durationMonths) {
  const principal = Number(principalAmount);
  const duration = Number.parseInt(durationMonths, 10);
  if (!Number.isFinite(principal) || principal <= 0 || !Number.isFinite(duration) || duration <= 0) return 0;

  const monthlyAmount = principal / duration;
  // The tiny epsilon avoids rounding up again where floating point represents
  // an exact hundred as e.g. 100.00000000000001.
  return Math.ceil((monthlyAmount - 1e-9) / 100) * 100;
}
