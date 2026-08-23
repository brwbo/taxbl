// Turn raw legs (chain.js) into classified tax events (engine.js).
// Every heuristic decision is recorded as a flag so the user can see and override it.
// Default classifications lean conservative (what HMRC would assume if you said nothing).

import { gbpPrice } from './prices.js';

export const TYPES = ['acquire', 'dispose', 'income', 'transfer', 'ignore'];
export const TYPE_LABEL = { acquire: 'Acquisition', dispose: 'Disposal (CGT)', income: 'Income', transfer: 'Transfer (own wallet)', ignore: 'Ignore' };

function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?'; }

// Only price ERC-20s by their real contract address: a scam token can call itself "USDC".
const KNOWN_CONTRACTS = {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c581': 'WBTC',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': 'STETH',
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USDE',
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 'PYUSD',
};

function priceSymbol(leg) {
  if (leg.kind === 'native') return 'ETH';
  if (leg.kind === 'token') return KNOWN_CONTRACTS[String(leg.asset || '').toLowerCase()] || null;
  return leg.symbol;
}

async function valueOf(leg, amount, ts) {
  const sym = priceSymbol(leg);
  if (!sym) return null;
  const p = await gbpPrice(sym, ts);
  return p == null ? null : p * amount;
}

function groupByHash(legs) {
  const m = new Map();
  for (const l of legs) { if (!m.has(l.hash)) m.set(l.hash, []); m.get(l.hash).push(l); }
  return m;
}

/**
 * @param {Array} legs from chain.js
 * @param {(msg:string)=>void} onProgress
 * @returns {Promise<Array>} events
 */
export async function classify(legs, onProgress) {
  const events = [];
  const groups = groupByHash(legs);
  let i = 0;
  for (const [hash, group] of groups) {
    i += 1;
    if (i % 10 === 0) onProgress?.(`valuing ${i}/${groups.size} transactions`);
    const ts = group[0].ts;
    const outs = group.filter((l) => l.dir === 'out' && l.asset);
    const ins = group.filter((l) => l.dir === 'in' && l.asset);
    const feeEth = Math.max(0, ...group.map((l) => l.feeEth || 0));
    const feeGbp = feeEth ? (await valueOf({ kind: 'native' }, feeEth, ts)) || 0 : 0;
    const mk = (leg, type, gbp, note, flags, extra = {}) => ({
      id: `${hash}:${events.length}`, hash, ts, type, asset: leg.symbol, assetId: leg.asset, amount: leg.amount,
      gbp: gbp == null ? 0 : gbp, priced: gbp != null, feeGbp: 0, note, flags, counterparty: leg.counterparty,
      contractName: leg.counterpartyName || '', method: leg.method || '', tokenName: leg.tokenName || '', ...extra,
    });

    if (outs.length && ins.length) {
      // SWAP: value both sides; prefer the priceable side as the sterling measure of the trade
      const outVals = await Promise.all(outs.map((l) => valueOf(l, l.amount, ts)));
      const inVals = await Promise.all(ins.map((l) => valueOf(l, l.amount, ts)));
      const outTotal = outVals.every((v) => v != null) ? outVals.reduce((s, v) => s + v, 0) : null;
      const inTotal = inVals.every((v) => v != null) ? inVals.reduce((s, v) => s + v, 0) : null;
      const tradeGbp = inTotal ?? outTotal;
      const basis = inTotal != null ? 'received side' : outTotal != null ? 'sent side' : null;
      const flags = [];
      if (tradeGbp == null) flags.push(`No sterling price for ${outs.map((l) => l.symbol).join('+')} or ${ins.map((l) => l.symbol).join('+')}. Enter the trade value manually.`);
      const desc = `Swap ${outs.map((l) => `${l.amount} ${l.symbol}`).join(' + ')} → ${ins.map((l) => `${l.amount} ${l.symbol}`).join(' + ')}`;
      outs.forEach((l, k) => {
        const share = tradeGbp == null ? null : outTotal ? (tradeGbp * (outVals[k] ?? 0)) / outTotal : tradeGbp / outs.length;
        const e = mk(l, 'dispose', share, desc, [...flags], { feeGbp: k === 0 ? feeGbp : 0 });
        if (basis) e.flags.push(`Valued from the ${basis} of the swap (HMRC: a crypto-to-crypto swap is a disposal at market value).`);
        events.push(e);
      });
      ins.forEach((l, k) => {
        const share = tradeGbp == null ? null : inTotal ? (tradeGbp * (inVals[k] ?? 0)) / inTotal : tradeGbp / ins.length;
        events.push(mk(l, 'acquire', share, desc, []));
      });
      continue;
    }

    for (const l of outs) {
      const gbp = await valueOf(l, l.amount, ts);
      const flags = [];
      if (gbp == null) flags.push(`No sterling price for ${l.symbol}. Enter the value manually.`);
      if (l.counterpartyIsContract) {
        flags.push(`Sent to a contract (${short(l.counterparty)}). Defaulted to transfer (staking deposit / bridge / LP). If this was a payment or sale, change it to Disposal.`);
        events.push(mk(l, 'transfer', gbp, `Sent ${l.amount} ${l.symbol} to contract`, flags));
      } else {
        flags.push(`Sent to a wallet (${short(l.counterparty)}). Defaulted to Disposal at market value. If that wallet is yours, change it to Transfer.`);
        events.push(mk(l, 'dispose', gbp, `Sent ${l.amount} ${l.symbol} to wallet`, flags, { feeGbp }));
      }
    }

    for (const l of ins) {
      const gbp = await valueOf(l, l.amount, ts);
      const flags = [];
      if (gbp == null) flags.push(`No sterling price for ${l.symbol}. Enter the value manually.`);
      if (l.counterpartyIsContract) {
        if (l.kind === 'token') {
          flags.push(`Token received from a contract (${short(l.counterparty)}) with nothing sent. Defaulted to Income (airdrop / reward / claim, taxable at sterling value on receipt). If it is a withdrawal of your own deposit, change it to Transfer.`);
          events.push(mk(l, 'income', gbp, `Received ${l.amount} ${l.symbol} from contract`, flags));
        } else {
          flags.push(`ETH received from a contract (${short(l.counterparty)}). Defaulted to Transfer (unstake / withdrawal). If it is a reward, change it to Income.`);
          events.push(mk(l, 'transfer', gbp, `Received ${l.amount} ETH from contract`, flags));
        }
      } else {
        flags.push(`Received from a wallet (${short(l.counterparty)}). Defaulted to Acquisition at market value. If that wallet is yours, change it to Transfer; if it was a gift or payment for work, Income may apply.`);
        events.push(mk(l, 'acquire', gbp, `Received ${l.amount} ${l.symbol} from wallet`, flags));
      }
    }
  }
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return events;
}

/** Tokens we couldn't price, for the summary panel. */
export function unpricedAssets(events) {
  return [...new Set(events.filter((e) => !e.priced).map((e) => e.asset))];
}
