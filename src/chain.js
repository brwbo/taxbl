// Fetch an Ethereum address's history from Blockscout (public, no API key, CORS-enabled)
// and normalise it into "legs": one row per asset movement in or out of the wallet.
//
// leg = { hash, ts, asset, symbol, decimals, amount, dir: 'in'|'out', counterparty, counterpartyIsContract, feeEth, method, kind: 'native'|'token' }

const BASE = 'https://eth.blockscout.com/api/v2';
const MAX_PAGES = 6; // 50 rows/page; enough for a demo, and keeps us under the public rate limit

function qs(params) {
  return Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429) throw new Error('Blockscout rate limit hit. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Blockscout ${res.status} for ${url}`);
  return res.json();
}

async function paged(path, params, onProgress) {
  const items = [];
  let next = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE}${path}?${qs({ ...params, ...(next || {}) })}`;
    const data = await getJson(url);
    items.push(...(data.items || []));
    onProgress?.(`${path.split('/').pop()}: ${items.length} rows`);
    next = data.next_page_params;
    if (!next) break;
  }
  return { items, truncated: Boolean(next) };
}

export function isAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
}

function toAmount(raw, decimals) {
  // Avoid float blow-up on big integers: split into integer and fraction strings
  const s = String(raw || '0').padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals) || '0';
  const frac = s.slice(s.length - decimals);
  return Number(`${int}.${frac}`);
}

/** Fetch native + ERC-20 movements for an address. Returns { legs, truncated, address }. */
export async function fetchLegs(addressRaw, onProgress) {
  const address = addressRaw.trim();
  if (!isAddress(address)) throw new Error('That is not an Ethereum address (expected 0x + 40 hex characters).');
  const me = address.toLowerCase();

  const [txs, transfers] = await Promise.all([
    paged(`/addresses/${address}/transactions`, {}, onProgress),
    paged(`/addresses/${address}/token-transfers`, { type: 'ERC-20' }, onProgress),
  ]);

  const legs = [];
  const feeByHash = new Map();
  const methodByHash = new Map();

  for (const t of txs.items) {
    if (t.status && t.status !== 'ok') continue; // failed tx: no transfer happened (gas is lost, but not deductible)
    const from = t.from?.hash?.toLowerCase();
    const to = t.to?.hash?.toLowerCase();
    const value = toAmount(t.value, 18);
    const feeEth = from === me ? toAmount(t.fee?.value, 18) : 0;
    if (from === me) feeByHash.set(t.hash, feeEth);
    if (t.method) methodByHash.set(t.hash, t.method);
    if (value > 0) {
      const dir = from === me ? 'out' : 'in';
      const cp = dir === 'out' ? t.to : t.from;
      legs.push({
        hash: t.hash, ts: t.timestamp, asset: 'ETH', symbol: 'ETH', decimals: 18, amount: value, dir,
        counterparty: cp?.hash || '', counterpartyIsContract: Boolean(cp?.is_contract), counterpartyName: cp?.name || '', feeEth,
        method: t.method || null, kind: 'native',
      });
    } else if (from === me) {
      // Contract call with no ETH value (approve, swap, claim...). Keep a fee-only marker so gas can attach to a swap.
      legs.push({ hash: t.hash, ts: t.timestamp, asset: null, amount: 0, dir: 'out', counterparty: to || '', counterpartyIsContract: Boolean(t.to?.is_contract), feeEth, method: t.method || null, kind: 'call' });
    }
  }

  for (const tr of transfers.items) {
    const from = tr.from?.hash?.toLowerCase();
    const to = tr.to?.hash?.toLowerCase();
    const decimals = Number(tr.token?.decimals ?? 18);
    const amount = toAmount(tr.total?.value, decimals);
    if (!(amount > 0)) continue;
    const dir = to === me ? 'in' : 'out';
    if (dir === 'in' && from === me) continue; // self-transfer of a token
    const cp = dir === 'out' ? tr.to : tr.from;
    const hash = tr.transaction_hash || tr.tx_hash;
    legs.push({
      hash, ts: tr.timestamp, asset: tr.token?.address_hash || tr.token?.address || tr.token?.symbol, symbol: tr.token?.symbol || '?', decimals, amount, dir,
      counterparty: cp?.hash || '', counterpartyIsContract: Boolean(cp?.is_contract), counterpartyName: cp?.name || '', feeEth: feeByHash.get(hash) || 0,
      method: methodByHash.get(hash) || null, kind: 'token', tokenName: tr.token?.name || '',
    });
  }

  legs.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { legs, truncated: txs.truncated || transfers.truncated, address };
}
