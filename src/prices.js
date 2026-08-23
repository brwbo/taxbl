// Sterling valuation of assets on a given day.
//   ETH, BTC/WBTC : Coinbase public daily candles (no key, CORS enabled), GBP pairs directly
//   USD stablecoins: 1 USD * Frankfurter USD->GBP (ECB reference rates)
//   Anything else  : unknown -> returns null and the event is flagged for manual valuation
// Results are cached in localStorage so re-runs don't refetch.

const DAY = 86400000;
const CANDLE_SPAN = 290; // Coinbase caps at 300 candles per request

const COINBASE_PRODUCT = { ETH: 'ETH-GBP', WETH: 'ETH-GBP', STETH: 'ETH-GBP', WBTC: 'BTC-GBP', BTC: 'BTC-GBP' };
const USD_STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'PYUSD', 'FDUSD', 'TUSD', 'USDP', 'GUSD', 'LUSD', 'USDS']);

const mem = new Map();
function cacheGet(k) {
  if (mem.has(k)) return mem.get(k);
  try { const v = localStorage.getItem(`taxbl:${k}`); if (v != null) { mem.set(k, JSON.parse(v)); return mem.get(k); } } catch {}
  return undefined;
}
function cacheSet(k, v) {
  mem.set(k, v);
  try { localStorage.setItem(`taxbl:${k}`, JSON.stringify(v)); } catch {}
}

function dayOf(ts) { return new Date(ts).toISOString().slice(0, 10); }

/** Fetch a block of daily closes for a Coinbase product and cache by day. */
async function loadCandles(product, dayKey) {
  const end = new Date(Date.parse(dayKey) + DAY);
  const start = new Date(end.getTime() - CANDLE_SPAN * DAY);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${start.toISOString()}&end=${end.toISOString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase ${res.status} for ${product}`);
  const rows = await res.json(); // [time, low, high, open, close, volume]
  for (const [t, , , , close] of rows) cacheSet(`${product}:${dayOf(t * 1000)}`, close);
  cacheSet(`${product}:span:${dayKey}`, true);
}

async function coinbasePrice(product, ts) {
  const key = dayOf(ts);
  let v = cacheGet(`${product}:${key}`);
  if (v == null && !cacheGet(`${product}:span:${key}`)) { await loadCandles(product, key); v = cacheGet(`${product}:${key}`); }
  if (v == null) {
    // Weekend/holiday gaps: walk back up to 5 days
    for (let i = 1; i <= 5 && v == null; i++) v = cacheGet(`${product}:${dayOf(Date.parse(key) - i * DAY)}`);
  }
  return v ?? null;
}

async function usdToGbp(ts) {
  const key = dayOf(ts);
  let v = cacheGet(`fx:${key}`);
  if (v != null) return v;
  const start = new Date(Date.parse(key) - 7 * DAY).toISOString().slice(0, 10);
  const res = await fetch(`https://api.frankfurter.dev/v1/${start}..${key}?base=USD&symbols=GBP`);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const data = await res.json();
  const days = Object.keys(data.rates || {}).sort();
  const last = days[days.length - 1];
  v = last ? data.rates[last].GBP : null;
  if (v != null) cacheSet(`fx:${key}`, v);
  return v;
}

/** GBP price of ONE unit of `symbol` at `ts`, or null if unknown. */
export async function gbpPrice(symbol, ts) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'GBP') return 1;
  if (COINBASE_PRODUCT[s]) return coinbasePrice(COINBASE_PRODUCT[s], ts);
  if (USD_STABLES.has(s)) return usdToGbp(ts);
  return null;
}

export function isPriceable(symbol) {
  const s = String(symbol || '').toUpperCase();
  return s === 'GBP' || Boolean(COINBASE_PRODUCT[s]) || USD_STABLES.has(s);
}
