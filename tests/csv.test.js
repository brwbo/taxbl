import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseExchangeCsv } from '../src/csv.js';

// gbpPrice fetches; keep tests offline by only using rows with GBP legs / explicit values.
global.localStorage = { getItem: () => null, setItem: () => {} };

test('parseCsv handles quotes and commas', () => {
  const rows = parseCsv('a,"b,c",d\n"say ""hi""",2,3\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd']);
  assert.deepEqual(rows[1], ['say "hi"', '2', '3']);
});

test('coinbase buys, sells, rewards, sends', async () => {
  const csv = [
    'Timestamp,Transaction Type,Asset,Quantity Transacted,Spot Price Currency,Spot Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes',
    '2024-06-01T10:00:00Z,Buy,ETH,1.0,GBP,2000,2000,2010,10,Bought 1 ETH',
    '2024-09-01T10:00:00Z,Sell,ETH,0.5,GBP,2400,1200,1190,10,Sold 0.5 ETH',
    '2024-10-01T10:00:00Z,Staking Income,ETH,0.01,GBP,2500,25,25,0,Reward',
    '2024-11-01T10:00:00Z,Send,ETH,0.2,GBP,2600,520,520,0,Sent to wallet',
  ].join('\n');
  const { events, format, skipped } = await parseExchangeCsv(csv, 'coinbase.csv');
  assert.equal(format, 'Coinbase');
  assert.equal(skipped, 0);
  assert.deepEqual(events.map((e) => e.type), ['acquire', 'dispose', 'income', 'transfer']);
  assert.equal(events[0].gbp, 2010);           // buy cost includes fees (Total)
  assert.equal(events[1].gbp, 1200);           // sell proceeds gross (Subtotal)
  assert.equal(events[1].feeGbp, 10);
  assert.equal(events[2].gbp, 25);
  assert.ok(events[3].flags.length, 'send is flagged for review');
});

test('kraken paired GBP trade and staking', async () => {
  const csv = [
    'txid,refid,time,type,subtype,aclass,asset,amount,fee,balance',
    'T1,R1,2024-06-01 10:00:00,trade,,currency,ZGBP,-2000,0,0',
    'T2,R1,2024-06-01 10:00:00,trade,,currency,XETH,1.0,0,1',
    'T3,R2,2024-09-01 10:00:00,trade,,currency,XETH,-0.5,0,0.5',
    'T4,R2,2024-09-01 10:00:00,trade,,currency,ZGBP,1200,5,1200',
  ].join('\n');
  const { events, format } = await parseExchangeCsv(csv, 'ledgers.csv');
  assert.equal(format, 'Kraken');
  const buy = events.find((e) => e.type === 'acquire');
  const sell = events.find((e) => e.type === 'dispose');
  assert.equal(buy.asset, 'ETH'); assert.equal(buy.amount, 1); assert.equal(buy.gbp, 2000);
  assert.equal(sell.asset, 'ETH'); assert.equal(sell.gbp, 1200); assert.equal(sell.feeGbp, 5);
});

test('generic template', async () => {
  const csv = [
    'date,type,asset,amount,gbp_value,fee_gbp,note',
    '2024-06-01,acquire,ETH,1,2000,5,bought',
    '2024-09-01,dispose,ETH,1,2500,5,sold',
    '2024-09-02,badtype,ETH,1,1,0,x',
  ].join('\n');
  const { events, format, skipped } = await parseExchangeCsv(csv);
  assert.equal(format, 'generic');
  assert.equal(events.length, 2);
  assert.equal(skipped, 1);
  assert.equal(events[1].feeGbp, 5);
});

test('unrecognised file throws with guidance', async () => {
  await assert.rejects(() => parseExchangeCsv('foo,bar\n1,2', 'x.csv'), /not a recognised export/);
});
