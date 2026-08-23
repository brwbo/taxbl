// Exchange CSV import, parsed entirely in the browser. Nothing is uploaded anywhere.
// Supported: Coinbase transaction history, Kraken ledgers.csv, Binance transaction history (best effort),
// and a generic template: date,type,asset,amount,gbp_value,fee_gbp,note (type: acquire|dispose|income|transfer).
// Output: events in the engine's shape. Rows that need a price use gbpPrice (ETH/BTC/stables) or get flagged.

import { gbpPrice } from './prices.js';

let seq = 0;
const id = (tag) => `csv-${tag}-${++seq}`;

/** Minimal CSV parser with quote handling. Returns array of rows (arrays). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function headerIndex(rows, required) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const lower = rows[i].map((c) => c.trim().toLowerCase());
    if (required.every((r) => lower.some((c) => c.includes(r)))) return i;
  }
  return -1;
}

function col(header, ...names) {
  const lower = header.map((c) => c.trim().toLowerCase());
  for (const n of names) { const i = lower.findIndex((c) => c === n); if (i >= 0) return i; }
  for (const n of names) { const i = lower.findIndex((c) => c.startsWith(n)); if (i >= 0) return i; }
  for (const n of names) { const i = lower.findIndex((c) => c.includes(n)); if (i >= 0) return i; }
  return -1;
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[£$€,]/g, '')); return Number.isFinite(n) ? n : 0; };

/** Kraken asset codes -> symbols */
function krakenAsset(a) {
  const m = { XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', XETC: 'ETC', XXRP: 'XRP', XLTC: 'LTC', ZGBP: 'GBP', ZUSD: 'USD', ZEUR: 'EUR', 'ETH2.S': 'ETH', ETH2: 'ETH', 'XBT.M': 'BTC' };
  const clean = String(a || '').trim();
  return m[clean] || clean.replace(/^[XZ](?=[A-Z]{3})/, '').replace(/\.[SMF]$/, '');
}

async function valueGbp(symbol, amount, ts, flags, what) {
  if (symbol === 'GBP') return Math.abs(amount);
  const p = await gbpPrice(symbol, ts);
  if (p == null) { flags.push(`No sterling price for ${symbol}. Enter the ${what} value manually.`); return 0; }
  return p * Math.abs(amount);
}

const mkEvent = (o) => ({ priced: true, feeGbp: 0, flags: [], counterparty: '', hash: o.id, assetId: o.asset, ...o });

/** Detect the format and parse. Returns { events, format, skipped } */
export async function parseExchangeCsv(text, filename = '') {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${filename || 'File'} is empty.`);

  let h = headerIndex(rows, ['transaction type', 'quantity']);
  if (h >= 0) return coinbase(rows, h);
  h = headerIndex(rows, ['refid', 'type', 'asset', 'amount']);
  if (h >= 0) return kraken(rows, h);
  h = headerIndex(rows, ['operation', 'coin', 'change']);
  if (h >= 0) return binance(rows, h);
  h = headerIndex(rows, ['date', 'type', 'asset', 'amount']);
  if (h >= 0) return generic(rows, h);
  throw new Error(`${filename || 'File'}: not a recognised export. Supported: Coinbase transaction history, Kraken ledgers, Binance transaction history, or the generic template (date,type,asset,amount,gbp_value,fee_gbp,note).`);
}

async function coinbase(rows, h) {
  const H = rows[h];
  const iTime = col(H, 'timestamp', 'date & time', 'date');
  const iType = col(H, 'transaction type', 'type');
  const iAsset = col(H, 'asset');
  const iQty = col(H, 'quantity transacted', 'quantity');
  const iCur = col(H, 'spot price currency', 'price currency');
  const iSub = col(H, 'subtotal');
  const iTotal = col(H, 'total (inclusive', 'total');
  const iFee = col(H, 'fees and/or spread', 'fees');
  const iNotes = col(H, 'notes');
  const events = []; let skipped = 0;

  for (const r of rows.slice(h + 1)) {
    const ts = new Date(r[iTime]).toISOString();
    const type = String(r[iType] || '').toLowerCase();
    const asset = String(r[iAsset] || '').trim().toUpperCase();
    const qty = Math.abs(num(r[iQty]));
    const cur = iCur >= 0 ? String(r[iCur] || '').toUpperCase() : 'GBP';
    const sub = Math.abs(num(r[iSub])), total = Math.abs(num(r[iTotal])), fee = Math.abs(num(r[iFee]));
    const note = (iNotes >= 0 && r[iNotes]) || `Coinbase ${type} ${qty} ${asset}`;
    const flags = cur && cur !== 'GBP' ? [`Coinbase values are in ${cur}, not GBP. Convert or correct the £ values.`] : [];
    if (!qty || !asset) { skipped++; continue; }

    if (type.includes('buy')) events.push(mkEvent({ id: id('cb'), ts, type: 'acquire', asset, amount: qty, gbp: total || sub, note, flags }));
    else if (type.includes('sell')) events.push(mkEvent({ id: id('cb'), ts, type: 'dispose', asset, amount: qty, gbp: sub || total, feeGbp: fee, note, flags }));
    else if (type.includes('convert')) {
      // Notes: "Converted 0.5 ETH to 1,540 USDC"
      const m = /converted\s+([\d,.]+)\s+(\S+)\s+to\s+([\d,.]+)\s+(\S+)/i.exec(note);
      events.push(mkEvent({ id: id('cb'), ts, type: 'dispose', asset, amount: qty, gbp: sub || total, feeGbp: fee, note, flags }));
      if (m) events.push(mkEvent({ id: id('cb'), ts, type: 'acquire', asset: m[4].toUpperCase(), amount: num(m[1] === undefined ? 0 : m[3]), gbp: sub || total, note, flags: [...flags] }));
      else events.push(mkEvent({ id: id('cb'), ts, type: 'acquire', asset: 'UNKNOWN', amount: 0, gbp: sub || total, note, flags: [...flags, 'Convert target not found in Notes. Set the asset and amount.'] }));
    } else if (type.includes('reward') || type.includes('staking') || type.includes('income') || type.includes('learn')) {
      events.push(mkEvent({ id: id('cb'), ts, type: 'income', asset, amount: qty, gbp: sub || total, note, flags }));
    } else if (type.includes('send') || type.includes('withdraw')) {
      events.push(mkEvent({ id: id('cb'), ts, type: 'transfer', asset, amount: qty, gbp: sub || total, note, flags: [...flags, 'Sent off Coinbase. If this went to your own wallet it is a transfer (default); if it was a payment or sale, change to Disposal.'] }));
    } else if (type.includes('receive') || type.includes('deposit')) {
      events.push(mkEvent({ id: id('cb'), ts, type: 'transfer', asset, amount: qty, gbp: sub || total, note, flags: [...flags, 'Received on Coinbase. If from your own wallet it is a transfer (default); if bought elsewhere or income, change it.'] }));
    } else skipped++;
  }
  return { events, format: 'Coinbase', skipped };
}

async function kraken(rows, h) {
  const H = rows[h];
  const iRef = col(H, 'refid'); const iTime = col(H, 'time'); const iType = col(H, 'type');
  const iAsset = col(H, 'asset'); const iAmount = col(H, 'amount'); const iFee = col(H, 'fee');
  const groups = new Map(); const events = []; let skipped = 0;

  for (const r of rows.slice(h + 1)) {
    const ref = r[iRef] || `solo-${Math.random()}`;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(r);
  }
  for (const [ref, legs] of groups) {
    const ts = new Date(String(legs[0][iTime]).replace(' ', 'T') + 'Z').toISOString();
    const type = String(legs[0][iType] || '').toLowerCase();
    if (type === 'trade' || type === 'spend' || type === 'receive') {
      const outs = legs.filter((l) => num(l[iAmount]) < 0), ins = legs.filter((l) => num(l[iAmount]) > 0);
      const gbpOut = outs.find((l) => krakenAsset(l[iAsset]) === 'GBP'), gbpIn = ins.find((l) => krakenAsset(l[iAsset]) === 'GBP');
      if (gbpOut && ins.length) { // buy with GBP
        for (const l of ins) events.push(mkEvent({ id: id('kr'), ts, type: 'acquire', asset: krakenAsset(l[iAsset]), amount: num(l[iAmount]), gbp: Math.abs(num(gbpOut[iAmount])) + num(gbpOut[iFee]), note: `Kraken buy (${ref})` }));
      } else if (gbpIn && outs.length) { // sell for GBP
        for (const l of outs) events.push(mkEvent({ id: id('kr'), ts, type: 'dispose', asset: krakenAsset(l[iAsset]), amount: Math.abs(num(l[iAmount])), gbp: Math.abs(num(gbpIn[iAmount])), feeGbp: num(gbpIn[iFee]), note: `Kraken sell (${ref})` }));
      } else if (outs.length && ins.length) { // crypto-to-crypto
        const flags = [];
        let trade = 0;
        for (const l of ins) trade += await valueGbp(krakenAsset(l[iAsset]), num(l[iAmount]), ts, flags, 'trade');
        for (const l of outs) events.push(mkEvent({ id: id('kr'), ts, type: 'dispose', asset: krakenAsset(l[iAsset]), amount: Math.abs(num(l[iAmount])), gbp: trade, note: `Kraken swap (${ref})`, flags: [...flags], priced: !flags.length }));
        for (const l of ins) events.push(mkEvent({ id: id('kr'), ts, type: 'acquire', asset: krakenAsset(l[iAsset]), amount: num(l[iAmount]), gbp: trade, note: `Kraken swap (${ref})`, flags: [...flags], priced: !flags.length }));
      } else skipped++;
    } else if (type === 'staking' || type === 'earn' || type === 'dividend') {
      for (const l of legs) {
        const amt = num(l[iAmount]); if (amt <= 0) continue;
        const flags = []; const sym = krakenAsset(l[iAsset]);
        const gbp = await valueGbp(sym, amt, ts, flags, 'reward');
        events.push(mkEvent({ id: id('kr'), ts, type: 'income', asset: sym, amount: amt, gbp, note: 'Kraken staking reward', flags, priced: !flags.length }));
      }
    } else if (type === 'deposit' || type === 'withdrawal' || type === 'transfer') {
      for (const l of legs) {
        const amt = num(l[iAmount]); const sym = krakenAsset(l[iAsset]);
        if (sym === 'GBP' || !amt) continue;
        const flags = ['Moved on/off Kraken. If between your own wallets it is a transfer (default); change if it was a purchase, payment or sale.'];
        const gbp = await valueGbp(sym, amt, ts, flags, 'transfer');
        events.push(mkEvent({ id: id('kr'), ts, type: 'transfer', asset: sym, amount: Math.abs(amt), gbp, note: `Kraken ${type}`, flags }));
      }
    } else skipped += legs.length;
  }
  return { events, format: 'Kraken', skipped };
}

async function binance(rows, h) {
  const H = rows[h];
  const iTime = col(H, 'date'); const iOp = col(H, 'operation'); const iCoin = col(H, 'coin'); const iChange = col(H, 'change');
  const events = []; let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const ts = new Date(String(r[iTime]).replace(' ', 'T') + 'Z').toISOString();
    const op = String(r[iOp] || '').toLowerCase();
    const asset = String(r[iCoin] || '').trim().toUpperCase();
    const amt = num(r[iChange]);
    if (!asset || !amt) { skipped++; continue; }
    const flags = [];
    const abs = Math.abs(amt);
    if (op.includes('buy') && amt > 0) { const gbp = await valueGbp(asset, abs, ts, flags, 'buy'); events.push(mkEvent({ id: id('bn'), ts, type: 'acquire', asset, amount: abs, gbp, note: `Binance ${op}`, flags: [...flags, 'Binance rows are single-sided; cost estimated at market. Check against what you actually paid.'], priced: !flags.length })); }
    else if ((op.includes('sell') || op.includes('transaction related')) && amt < 0) { const gbp = await valueGbp(asset, abs, ts, flags, 'sale'); events.push(mkEvent({ id: id('bn'), ts, type: 'dispose', asset, amount: abs, gbp, note: `Binance ${op}`, flags: [...flags, 'Binance rows are single-sided; proceeds estimated at market. Check against what you actually received.'], priced: !flags.length })); }
    else if (op.includes('reward') || op.includes('interest') || op.includes('distribution') || op.includes('airdrop')) { const gbp = await valueGbp(asset, abs, ts, flags, 'reward'); events.push(mkEvent({ id: id('bn'), ts, type: 'income', asset, amount: abs, gbp, note: `Binance ${op}`, flags, priced: !flags.length })); }
    else if (op.includes('deposit') || op.includes('withdraw')) { const gbp = await valueGbp(asset, abs, ts, flags, 'transfer'); events.push(mkEvent({ id: id('bn'), ts, type: 'transfer', asset, amount: abs, gbp, note: `Binance ${op}`, flags: [...flags, 'Moved on/off Binance. Change if it was a purchase, payment or sale.'] })); }
    else skipped++;
  }
  return { events, format: 'Binance', skipped };
}

async function generic(rows, h) {
  const H = rows[h];
  const iDate = col(H, 'date'); const iType = col(H, 'type'); const iAsset = col(H, 'asset'); const iAmount = col(H, 'amount');
  const iGbp = col(H, 'gbp_value', 'gbp'); const iFee = col(H, 'fee_gbp', 'fee'); const iNote = col(H, 'note');
  const events = []; let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const type = String(r[iType] || '').toLowerCase().trim();
    if (!['acquire', 'dispose', 'income', 'transfer', 'ignore'].includes(type)) { skipped++; continue; }
    events.push(mkEvent({
      id: id('gn'), ts: new Date(r[iDate]).toISOString(), type, asset: String(r[iAsset] || '').toUpperCase(),
      amount: Math.abs(num(r[iAmount])), gbp: Math.abs(num(r[iGbp])), feeGbp: iFee >= 0 ? Math.abs(num(r[iFee])) : 0,
      note: (iNote >= 0 && r[iNote]) || `Imported ${type}`,
    }));
  }
  return { events, format: 'generic', skipped };
}
