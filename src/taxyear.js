// UK tax year helpers. A UK tax year runs 6 April to 5 April.

/** @param {Date|string} d */
export function taxYearOf(d) {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  const day = date.getUTCDate();
  const startYear = m > 3 || (m === 3 && day >= 6) ? y : y - 1;
  return `${startYear}/${String(startYear + 1).slice(2)}`;
}

/** Annual exempt amount for CGT, by tax-year label. Source: gov.uk CGT rates and allowances. */
export function annualExemptAmount(taxYear) {
  const start = Number(taxYear.slice(0, 4));
  if (start <= 2022) return 12300;
  if (start === 2023) return 6000;
  return 3000; // 2024/25 onwards
}

/** YYYY-MM-DD in UTC, used as the "day" for same-day matching. */
export function dayKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(aKey, bKey) {
  return Math.round((Date.parse(bKey) - Date.parse(aKey)) / 86400000);
}
