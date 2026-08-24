import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTax, indicativeCgt } from '../src/engine.js';
import { taxYearOf, annualExemptAmount } from '../src/taxyear.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
let n = 0;
const ev = (type, ts, asset, amount, gbp, extra = {}) => ({ id: `e${++n}`, type, ts, asset, amount, gbp, feeGbp: 0, flags: [], ...extra });

test('tax year boundaries', () => {
  assert.equal(taxYearOf('2025-04-05T23:59:59Z'), '2024/25');
  assert.equal(taxYearOf('2025-04-06T00:00:00Z'), '2025/26');
  assert.equal(taxYearOf('2024-12-25T00:00:00Z'), '2024/25');
  assert.equal(annualExemptAmount('2023/24'), 6000);
  assert.equal(annualExemptAmount('2024/25'), 3000);
});

test('section 104 pool uses average cost', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 2000),
    ev('acquire', '2024-07-01T10:00:00Z', 'ETH', 1, 3000),
    ev('dispose', '2024-09-01T10:00:00Z', 'ETH', 1, 4000),
  ]);
  const d = r.disposals[0];
  assert.equal(d.matches[0].rule, 'section-104');
  close(d.allowableCost, 2500, 'average cost');
  close(d.gain, 1500, 'gain');
  close(r.pools.ETH.amount, 1, 'pool left');
  close(r.pools.ETH.cost, 2500, 'pool cost left');
});

test('same-day rule beats the pool', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 1000),
    ev('acquire', '2024-09-01T08:00:00Z', 'ETH', 1, 3000),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 1, 3100),
  ]);
  const d = r.disposals[0];
  assert.equal(d.matches[0].rule, 'same-day');
  close(d.gain, 100, 'same-day gain');
  close(r.pools.ETH.cost, 1000, 'old acquisition still pooled');
});

test('30-day bed-and-breakfast rule matches later purchase', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 1000),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 1, 3000),
    ev('acquire', '2024-09-15T08:00:00Z', 'ETH', 1, 2900), // within 30 days
  ]);
  const d = r.disposals[0];
  assert.equal(d.matches[0].rule, '30-day');
  close(d.gain, 100, 'matched against the re-buy, not the cheap pool');
  close(r.pools.ETH.cost, 1000, 'original purchase untouched');
});

test('acquisition 31 days later is NOT matched', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 1000),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 1, 3000),
    ev('acquire', '2024-10-02T08:00:00Z', 'ETH', 1, 2900),
  ]);
  assert.equal(r.disposals[0].matches[0].rule, 'section-104');
  close(r.disposals[0].gain, 2000, 'pool gain');
});

test('partial matching splits across rules', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 2, 2000),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 3, 9000),
    ev('acquire', '2024-09-10T08:00:00Z', 'ETH', 0.5, 1500),
  ]);
  const d = r.disposals[0];
  const rules = d.matches.map((m) => m.rule);
  assert.deepEqual(rules, ['30-day', 'section-104']);
  close(d.unmatched, 0.5, 'half an ETH has no cost basis');
  assert.ok(d.flags.some((f) => f.includes('No acquisition')));
  close(d.allowableCost, 1500 + 2000, 'cost = re-buy + whole pool');
});

test('income is taxed as income AND becomes cost basis', () => {
  const r = computeTax([
    ev('income', '2024-08-01T10:00:00Z', 'ETH', 0.1, 200, { note: 'staking reward' }),
    ev('dispose', '2025-01-01T10:00:00Z', 'ETH', 0.1, 300),
  ]);
  const y = r.years['2024/25'];
  close(y.income, 200, 'income');
  close(r.disposals[0].gain, 100, 'gain uses income value as cost');
});

test('fees: disposal fee is allowable, acquisition fee adds to cost', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 1000, { feeGbp: 10 }),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 1, 2000, { feeGbp: 5 }),
  ]);
  close(r.disposals[0].allowableCost, 1015, 'cost incl. both fees');
  close(r.disposals[0].gain, 985, 'gain');
});

test('per-year totals, losses and allowance', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 2, 4000),
    ev('dispose', '2024-09-01T12:00:00Z', 'ETH', 1, 7000), // +5000
    ev('dispose', '2025-02-01T12:00:00Z', 'ETH', 1, 1000), // -1000
    ev('acquire', '2025-05-01T10:00:00Z', 'BTC', 0.1, 5000),
    ev('dispose', '2025-06-01T12:00:00Z', 'BTC', 0.1, 5500), // +500 in 2025/26
  ]);
  const y = r.years['2024/25'];
  close(y.gains, 5000, 'gains'); close(y.losses, 1000, 'losses');
  close(y.netGain, 4000, 'net'); close(y.taxableGain, 1000, 'above £3,000 allowance');
  close(r.years['2025/26'].taxableGain, 0, 'within allowance');
});

test('transfers and ignored events have no effect', () => {
  const r = computeTax([
    ev('acquire', '2024-06-01T10:00:00Z', 'ETH', 1, 1000),
    ev('transfer', '2024-07-01T10:00:00Z', 'ETH', 1, 1500),
    ev('ignore', '2024-07-02T10:00:00Z', 'ETH', 1, 1500),
  ]);
  assert.equal(r.disposals.length, 0);
  close(r.pools.ETH.amount, 1, 'pool intact');
});

test('2024/25 mid-year rate change: pre-30-Oct gains blend at 10/20 (verified vs hmrc/capital-gains-calculator)', () => {
  const r = computeTax([
    ev('acquire', '2024-05-01T10:00:00Z', 'ETH', 2, 2000),
    ev('dispose', '2024-06-01T10:00:00Z', 'ETH', 1, 6000), // +5000 pre change
    ev('dispose', '2024-12-01T10:00:00Z', 'ETH', 1, 6000), // +5000 post change
  ]);
  const y = r.years['2024/25'];
  close(y.preOct30Share, 0.5, 'half the gains pre 30 Oct');
  const cgt = indicativeCgt('2024/25', y.taxableGain, y.preOct30Share);
  close(cgt.basic, y.taxableGain * 0.5 * 0.10 + y.taxableGain * 0.5 * 0.18, 'blended basic');
  assert.ok(cgt.mixed);
});

test('taxable gain floors the net gain (HMRC rounding: gains down, allowance up)', () => {
  const r = computeTax([
    ev('acquire', '2024-05-01T10:00:00Z', 'ETH', 1, 1000),
    ev('dispose', '2024-12-01T10:00:00Z', 'ETH', 1, 4500.75),
  ]);
  close(r.years['2024/25'].taxableGain, 500, 'floor(3500.75) - 3000');
});
