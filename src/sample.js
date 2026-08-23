// A synthetic but realistic UK retail wallet, pre-classified and pre-priced so the demo always works.
// Covers: exchange buys, a DEX swap, staking income, an airdrop, a same-day trade, a 30-day bed-and-breakfast,
// a transfer to the owner's other wallet, an unpriced token, and activity across two tax years.
// Prices are approximate sterling values for the dates shown; they are illustrative, not a price feed.

const ev = (id, ts, type, asset, amount, gbp, note, flags = [], extra = {}) =>
  ({ id, hash: `sample-${id}`, ts, type, asset, assetId: asset, amount, gbp, priced: true, feeGbp: 0, note, flags, counterparty: '', ...extra });

export const SAMPLE_ADDRESS = 'sample';

export const SAMPLE_EVENTS = [
  // ---- 2023/24: the first buys (cost basis) ----
  ev('s01', '2023-11-14T09:12:00Z', 'acquire', 'ETH', 1.5, 2430, 'Bought 1.5 ETH on an exchange', [], { feeGbp: 4.5 }),
  ev('s02', '2024-01-22T18:40:00Z', 'acquire', 'ETH', 1.0, 1890, 'Bought 1 ETH on an exchange', [], { feeGbp: 3 }),
  ev('s03', '2024-03-05T12:03:00Z', 'acquire', 'WBTC', 0.05, 2650, 'Bought 0.05 WBTC', [], { feeGbp: 5 }),

  // ---- 2024/25 ----
  // Swap ETH -> USDC on a DEX (disposal of ETH at market, acquisition of USDC)
  ev('s04', '2024-05-20T14:22:00Z', 'dispose', 'ETH', 0.5, 1230, 'Swap 0.5 ETH → 1,540 USDC', ['Valued from the received side of the swap (HMRC: a crypto-to-crypto swap is a disposal at market value).'], { feeGbp: 6.2 }),
  ev('s05', '2024-05-20T14:22:00Z', 'acquire', 'USDC', 1540, 1230, 'Swap 0.5 ETH → 1,540 USDC'),
  // Staking rewards (income at receipt, and cost basis)
  ev('s06', '2024-06-30T00:00:00Z', 'income', 'ETH', 0.021, 57, 'Staking reward', ['Token received from a contract with nothing sent. Defaulted to Income.']),
  ev('s07', '2024-09-30T00:00:00Z', 'income', 'ETH', 0.022, 43, 'Staking reward', ['Token received from a contract with nothing sent. Defaulted to Income.']),
  // Airdrop of an unpriced token
  ev('s08', '2024-10-08T11:15:00Z', 'income', 'ZKT', 850, 0, 'Airdrop: 850 ZKT', ['No sterling price for ZKT. Enter the value manually.', 'Token received from a contract with nothing sent. Defaulted to Income (airdrop / reward / claim).'], { priced: false }),
  // Same-day: buy in the morning, sell in the afternoon
  ev('s09', '2024-11-12T08:05:00Z', 'acquire', 'ETH', 0.4, 1010, 'Bought 0.4 ETH on an exchange', [], { feeGbp: 2 }),
  ev('s10', '2024-11-12T16:47:00Z', 'dispose', 'ETH', 0.4, 1048, 'Sold 0.4 ETH for GBP', [], { feeGbp: 2 }),
  // Sell before Christmas, buy back 12 days later: 30-day rule
  ev('s11', '2024-12-18T10:30:00Z', 'dispose', 'ETH', 1.0, 3020, 'Sold 1 ETH for GBP', [], { feeGbp: 3 }),
  ev('s12', '2024-12-30T09:10:00Z', 'acquire', 'ETH', 1.0, 2710, 'Bought 1 ETH on an exchange', [], { feeGbp: 3 }),
  // Transfer to own hardware wallet: not taxable, but it is what a naive tool flags as a sale
  ev('s13', '2025-02-03T20:00:00Z', 'transfer', 'ETH', 1.0, 2180, 'Sent 1 ETH to own hardware wallet', ['Sent to a wallet (0x8f2a…c41e). Defaulted to Disposal; owner confirmed this is their own wallet and changed it to Transfer.']),
  // Sell the WBTC at a gain
  ev('s14', '2025-03-28T13:45:00Z', 'dispose', 'WBTC', 0.05, 5900, 'Sold 0.05 WBTC for GBP', [], { feeGbp: 5 }),

  // ---- 2025/26 ----
  ev('s15', '2025-04-20T10:00:00Z', 'dispose', 'USDC', 1540, 1150, 'Swap 1,540 USDC → 0.68 ETH', ['Valued from the sent side of the swap.'], { feeGbp: 1.8 }),
  ev('s16', '2025-04-20T10:00:00Z', 'acquire', 'ETH', 0.68, 1150, 'Swap 1,540 USDC → 0.68 ETH'),
  ev('s17', '2025-06-30T00:00:00Z', 'income', 'ETH', 0.020, 37, 'Staking reward', ['Token received from a contract with nothing sent. Defaulted to Income.']),
  ev('s18', '2025-08-11T15:20:00Z', 'dispose', 'ETH', 0.5, 2050, 'Sold 0.5 ETH for GBP', [], { feeGbp: 2.5 }),
  ev('s19', '2025-12-02T09:00:00Z', 'dispose', 'ETH', 0.75, 3450, 'Paid 0.75 ETH to a wallet', ['Sent to a wallet (0x1b77…9e02). Defaulted to Disposal at market value. If that wallet is yours, change it to Transfer.'], { feeGbp: 2.1 }),
  ev('s20', '2026-02-14T12:00:00Z', 'dispose', 'ZKT', 850, 210, 'Swap 850 ZKT → 265 USDC', ['Valued from the received side of the swap.']),
  ev('s21', '2026-02-14T12:00:00Z', 'acquire', 'USDC', 265, 210, 'Swap 850 ZKT → 265 USDC'),
];
