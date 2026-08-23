// HMRC crypto share-pooling engine.
//
// HMRC treats each cryptoasset as a separate "pool" and matches disposals in this order
// (CRYPTO22200 onwards, same rules as shares):
//   1. Same-day rule      : acquisitions of the same asset on the same day as the disposal
//   2. 30-day rule        : acquisitions in the 30 days AFTER the disposal (bed-and-breakfast), earliest first
//   3. Section 104 pool   : everything else, at pooled average cost
//
// Input: an array of classified events (see classify.js / sample.js):
//   { id, ts, type: 'acquire'|'dispose'|'income'|'transfer'|'ignore', asset, amount, gbp, feeGbp, note, flags }
//   - acquire: gbp = total cost of the amount acquired (feeGbp added to cost)
//   - dispose: gbp = total proceeds for the amount disposed (feeGbp is an allowable cost)
//   - income : gbp = sterling value on receipt; ALSO creates an acquisition at that cost
//   - transfer / ignore: no tax effect
//
// Output: { disposals: [...with gain breakdown], years: { '2024/25': {...} }, pools: {asset: {amount, cost}} }

import { taxYearOf, annualExemptAmount, dayKey, daysBetween } from './taxyear.js';

const EPS = 1e-12;

function sortByTime(a, b) {
  return Date.parse(a.ts) - Date.parse(b.ts) || String(a.id).localeCompare(String(b.id));
}

/** Build the acquisition list (acquire + income) and the disposal list, per asset. */
function splitByAsset(events) {
  const assets = new Map();
  for (const e of events) {
    if (!['acquire', 'dispose', 'income'].includes(e.type)) continue;
    if (!(Number(e.amount) > 0)) continue;
    if (!assets.has(e.asset)) assets.set(e.asset, { acqs: [], disps: [] });
    const a = assets.get(e.asset);
    if (e.type === 'dispose') {
      a.disps.push({ ...e, day: dayKey(e.ts) });
    } else {
      const cost = Number(e.gbp || 0) + (e.type === 'acquire' ? Number(e.feeGbp || 0) : 0);
      a.acqs.push({ ...e, day: dayKey(e.ts), cost, remaining: Number(e.amount), remainingCost: cost });
    }
  }
  for (const a of assets.values()) {
    a.acqs.sort(sortByTime);
    a.disps.sort(sortByTime);
  }
  return assets;
}

/** Consume `qty` from an acquisition, returning the cost attributable to it. */
function takeFrom(acq, qty) {
  const take = Math.min(qty, acq.remaining);
  const cost = acq.remaining > EPS ? (acq.remainingCost * take) / acq.remaining : 0;
  acq.remaining -= take;
  acq.remainingCost -= cost;
  return { take, cost };
}

function matchDisposal(d, acqs, pool, pooledSoFar) {
  let left = Number(d.amount);
  const matches = [];

  // 1. Same-day
  for (const a of acqs) {
    if (left <= EPS) break;
    if (a.day !== d.day || a.remaining <= EPS) continue;
    const { take, cost } = takeFrom(a, left);
    if (take > EPS) { matches.push({ rule: 'same-day', amount: take, cost, acqId: a.id }); left -= take; }
  }

  // 2. 30-day (acquisitions strictly after the disposal day, within 30 days, earliest first)
  for (const a of acqs) {
    if (left <= EPS) break;
    const gap = daysBetween(d.day, a.day);
    if (gap < 1 || gap > 30 || a.remaining <= EPS) continue;
    const { take, cost } = takeFrom(a, left);
    if (take > EPS) { matches.push({ rule: '30-day', amount: take, cost, acqId: a.id }); left -= take; }
  }

  // 3. Section 104 pool: acquisitions before the disposal day not already consumed
  for (const a of acqs) {
    if (daysBetween(a.day, d.day) < 1 || a.remaining <= EPS || pooledSoFar.has(a.id)) continue;
    pool.amount += a.remaining;
    pool.cost += a.remainingCost;
    pooledSoFar.add(a.id);
    a.remaining = 0;
    a.remainingCost = 0;
  }
  if (left > EPS) {
    const take = Math.min(left, pool.amount);
    const cost = pool.amount > EPS ? (pool.cost * take) / pool.amount : 0;
    if (take > EPS) {
      pool.amount -= take;
      pool.cost -= cost;
      matches.push({ rule: 'section-104', amount: take, cost });
      left -= take;
    }
  }

  const unmatched = left > EPS ? left : 0;
  return { matches, unmatched };
}

/** Run the engine. Returns disposals with gains, per-tax-year totals, and closing pools. */
export function computeTax(events) {
  const assets = splitByAsset(events);
  const disposals = [];
  const pools = {};

  for (const [asset, { acqs, disps }] of assets) {
    const pool = { amount: 0, cost: 0 };
    const pooledSoFar = new Set();
    for (const d of disps) {
      const { matches, unmatched } = matchDisposal(d, acqs, pool, pooledSoFar);
      const matchedCost = matches.reduce((s, m) => s + m.cost, 0);
      const allowableCost = matchedCost + Number(d.feeGbp || 0);
      const proceeds = Number(d.gbp || 0);
      const gain = proceeds - allowableCost;
      const flags = [...(d.flags || [])];
      if (unmatched > EPS) flags.push(`No acquisition found for ${unmatched} ${asset}: cost basis treated as £0 (HMRC would tax the full proceeds). Add the missing purchase or wallet.`);
      disposals.push({
        id: d.id, ts: d.ts, asset, amount: Number(d.amount), proceeds, allowableCost, gain,
        taxYear: taxYearOf(d.ts), matches, unmatched, note: d.note, flags,
      });
    }
    // Anything still unpooled at the end goes into the closing pool
    for (const a of acqs) {
      if (a.remaining > EPS && !pooledSoFar.has(a.id)) { pool.amount += a.remaining; pool.cost += a.remainingCost; pooledSoFar.add(a.id); }
    }
    if (pool.amount > EPS) pools[asset] = { amount: pool.amount, cost: pool.cost };
  }

  const years = {};
  const yr = (label) => (years[label] ||= {
    taxYear: label, disposals: 0, proceeds: 0, allowableCost: 0, gains: 0, losses: 0, netGain: 0,
    allowance: annualExemptAmount(label), taxableGain: 0, income: 0, incomeEvents: 0, flagged: 0,
  });
  for (const d of disposals) {
    const y = yr(d.taxYear);
    y.disposals += 1; y.proceeds += d.proceeds; y.allowableCost += d.allowableCost;
    if (d.gain >= 0) y.gains += d.gain; else y.losses += -d.gain;
    if (d.flags.length) y.flagged += 1;
  }
  for (const e of events) {
    if (e.type === 'income') { const y = yr(taxYearOf(e.ts)); y.income += Number(e.gbp || 0); y.incomeEvents += 1; }
    else if (e.flags?.length && e.type !== 'dispose') { yr(taxYearOf(e.ts)).flagged += 1; }
  }
  for (const y of Object.values(years)) {
    y.netGain = y.gains - y.losses;
    y.taxableGain = Math.max(0, y.netGain - y.allowance);
  }

  disposals.sort(sortByTime);
  return { disposals, years, pools };
}

/** Indicative CGT at the post-30-Oct-2024 rates (18% basic, 24% higher). Earlier years: 10%/20%. */
export function indicativeCgt(taxYear, taxableGain) {
  const start = Number(taxYear.slice(0, 4));
  const [lo, hi] = start >= 2025 ? [0.18, 0.24] : start === 2024 ? [0.18, 0.24] : [0.10, 0.20];
  return { basic: taxableGain * lo, higher: taxableGain * hi, rates: [lo, hi] };
}
