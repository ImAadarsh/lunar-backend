/**
 * Illustrative UK PAYE (basic rate) + Class 1 NI-style deductions prorated by period length.
 * Not HMRC-certified — replace with verified rules / payroll provider for production.
 */
/** Default £12.00/hr gross when users.pay_rate_pence_hour IS NULL */
export const DEFAULT_PAY_PENCE_HOUR = 1200;

const DAYS_YEAR = 365;
/** £12,570 personal allowance (annual), pence */
const PERSONAL_ALLOWANCE_ANNUAL_PENCE = 12_570_00;
/** Employee NI ~8% above primary threshold (simplified flat slice) */
const NI_EMPLOYEE_RATE = 0.08;
/** Employer NI ~13.8% (simplified) */
const NI_EMPLOYER_RATE = 0.138;
/** Primary threshold ~£12,570 aligned with PA for this model (pence annual) */
const PT_ANNUAL_PENCE = 12_570_00;

/**
 * @param {number} grossPence - period gross pay in pence
 * @param {number} periodDays - inclusive period length for proration
 */
export function computeUkDeductions(grossPence, periodDays) {
  const paPeriod = Math.round((PERSONAL_ALLOWANCE_ANNUAL_PENCE * periodDays) / DAYS_YEAR);
  const taxable = Math.max(0, grossPence - paPeriod);
  const payePence = Math.round(taxable * 0.2);

  const ptPeriod = Math.round((PT_ANNUAL_PENCE * periodDays) / DAYS_YEAR);
  const niBase = Math.max(0, grossPence - ptPeriod);
  const niEmployeePence = Math.round(niBase * NI_EMPLOYEE_RATE);
  const niEmployerPence = Math.round(niBase * NI_EMPLOYER_RATE);

  const netPence = grossPence - payePence - niEmployeePence;
  return {
    payePence,
    niEmployeePence,
    niEmployerPence,
    netPence,
  };
}

export function computePayrollBreakdown({
  regularHours,
  overtimeHours = 0,
  nightHours = 0,
  weekendHours = 0,
  ratePenceHour,
  adjustmentPence = 0,
  periodDays,
}) {
  const baseGrossPence = Math.round(regularHours * ratePenceHour);
  const overtimePence = Math.round(overtimeHours * ratePenceHour * 1.5);
  const nightDifferentialPence = Math.round(nightHours * ratePenceHour * 0.15);
  const weekendDifferentialPence = Math.round(weekendHours * ratePenceHour * 0.1);
  const grossBeforePensionPence = Math.max(
    0,
    baseGrossPence + overtimePence + nightDifferentialPence + weekendDifferentialPence + adjustmentPence
  );
  const pensionEmployeePence = Math.round(grossBeforePensionPence * 0.05);
  const pensionEmployerPence = Math.round(grossBeforePensionPence * 0.03);
  const taxableGrossPence = Math.max(0, grossBeforePensionPence - pensionEmployeePence);
  const d = computeUkDeductions(taxableGrossPence, periodDays);
  return {
    regularHours,
    overtimeHours,
    nightHours,
    weekendHours,
    baseGrossPence,
    overtimePence,
    nightDifferentialPence,
    weekendDifferentialPence,
    adjustmentPence,
    grossPence: grossBeforePensionPence,
    pensionEmployeePence,
    pensionEmployerPence,
    payePence: d.payePence,
    niEmployeePence: d.niEmployeePence,
    niEmployerPence: d.niEmployerPence,
    netPence: Math.max(0, d.netPence - pensionEmployeePence),
    note: 'Configurable payroll model. Verify tax, pension, overtime, and differential rules before production payroll submission.',
  };
}

export function periodDaysInclusive(startStr, endStr) {
  const a = new Date(`${startStr}T12:00:00Z`);
  const b = new Date(`${endStr}T12:00:00Z`);
  const ms = b - a;
  return Math.max(1, Math.round(ms / 86400000) + 1);
}
