import { computeUkDeductions, periodDaysInclusive, DEFAULT_PAY_PENCE_HOUR } from './payrollUk.js';

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} runId
 * @param {string} periodStart YYYY-MM-DD
 * @param {string} periodEnd YYYY-MM-DD
 */
export async function processPayrollRun(pool, runId, periodStart, periodEnd) {
  const periodDays = periodDaysInclusive(periodStart, periodEnd);
  const startDt = `${periodStart} 00:00:00`;
  const endDt = `${periodEnd} 23:59:59`;

  const [hoursRows] = await pool.query(
    `SELECT a.user_id AS userId,
            SUM(TIMESTAMPDIFF(MINUTE, a.check_in_at, a.check_out_at)) / 60.0 AS hours
     FROM attendance_sessions a
     WHERE a.status = 'closed'
       AND a.check_out_at IS NOT NULL
       AND a.check_out_at >= ? AND a.check_out_at <= ?
     GROUP BY a.user_id`,
    [startDt, endDt]
  );

  let grossTotal = 0;
  let payeTotal = 0;
  let niEmpTotal = 0;
  let niErTotal = 0;
  let netTotal = 0;
  const lineIds = [];

  for (const row of hoursRows) {
    const hours = Math.round(Number(row.hours) * 100) / 100;
    if (hours <= 0) continue;

    const [[u]] = await pool.query(
      `SELECT COALESCE(pay_rate_pence_hour, ?) AS rate FROM users WHERE id = ?`,
      [DEFAULT_PAY_PENCE_HOUR, row.userId]
    );
    const rate = Number(u?.rate ?? DEFAULT_PAY_PENCE_HOUR);
    const grossPence = Math.round(hours * rate);

    const d = computeUkDeductions(grossPence, periodDays);

    const [ins] = await pool.query(
      `INSERT INTO payroll_lines
        (payroll_run_id, user_id, hours_worked, gross_pence, paye_pence, ni_employee_pence, ni_employer_pence, net_pence, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        row.userId,
        hours,
        grossPence,
        d.payePence,
        d.niEmployeePence,
        d.niEmployerPence,
        d.netPence,
        JSON.stringify({ periodDays, ratePenceHour: rate }),
      ]
    );
    lineIds.push(ins.insertId);
    grossTotal += grossPence;
    payeTotal += d.payePence;
    niEmpTotal += d.niEmployeePence;
    niErTotal += d.niEmployerPence;
    netTotal += d.netPence;
  }

  const resultJson = {
    version: 1,
    periodDays,
    lineCount: lineIds.length,
    totals: {
      grossPence: grossTotal,
      payePence: payeTotal,
      niEmployeePence: niEmpTotal,
      niEmployerPence: niErTotal,
      netPence: netTotal,
    },
    note: 'Illustrative UK-style deductions — verify for production use.',
  };

  await pool.query(`UPDATE payroll_runs SET result_json = ?, notes = NULL WHERE id = ?`, [
    JSON.stringify(resultJson),
    runId,
  ]);
}
