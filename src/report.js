// Full report: a Self Assessment style Capital Gains computation per tax year, with an audit trail
// per disposal showing exactly which acquisitions were matched under which HMRC rule.
// Rendered into a <dialog>; "Print / save as PDF" uses the browser's print stylesheet.

import { computeTax, indicativeCgt } from './engine.js';

const gbp2 = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const amt = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : n.toLocaleString('en-GB', { maximumFractionDigits: 8 }));
const date = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RULE = { 'same-day': 'Same-day rule (TCGA92 s105(1))', '30-day': '30-day rule (TCGA92 s106A(5))', 'section-104': 'Section 104 holding (pooled average cost)' };

export function buildReport(events, sourceLabel) {
  const { disposals, years, pools } = computeTax(events);
  const yearList = Object.values(years).sort((a, b) => a.taxYear.localeCompare(b.taxYear));
  const generated = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
  const reviewCount = events.filter((e) => e.flags?.length || !e.priced).length;

  const yearSections = yearList.map((y) => {
    const ds = disposals.filter((d) => d.taxYear === y.taxYear);
    const incomes = events.filter((e) => e.type === 'income' && yearOf(e.ts) === y.taxYear);
    const cgt = indicativeCgt(y.taxYear, y.taxableGain);
    return `
    <section class="rp-year">
      <h2>Tax year ${y.taxYear} <span>6 April ${y.taxYear.slice(0, 4)} to 5 April ${Number(y.taxYear.slice(0, 4)) + 1}</span></h2>
      <div class="rp-cols">
        <table class="rp-summary">
          <caption>Capital gains summary (SA108 boxes, "other property, assets and gains")</caption>
          <tr><td>Number of disposals</td><td>${y.disposals}</td></tr>
          <tr><td>Disposal proceeds</td><td>${gbp2(y.proceeds)}</td></tr>
          <tr><td>Allowable costs (including fees)</td><td>${gbp2(y.allowableCost)}</td></tr>
          <tr><td>Gains in the year, before losses</td><td>${gbp2(y.gains)}</td></tr>
          <tr><td>Losses in the year</td><td>${gbp2(y.losses)}</td></tr>
          <tr><td>Net gain</td><td>${gbp2(y.netGain)}</td></tr>
          <tr><td>Annual exempt amount</td><td>${gbp2(y.allowance)}</td></tr>
          <tr class="rp-total"><td>Taxable gain</td><td>${gbp2(y.taxableGain)}</td></tr>
          <tr><td>Indicative CGT at ${Math.round(cgt.rates[0] * 100)}% / ${Math.round(cgt.rates[1] * 100)}%</td><td>${gbp2(cgt.basic)} / ${gbp2(cgt.higher)}</td></tr>
        </table>
        <table class="rp-summary">
          <caption>Miscellaneous income from cryptoassets</caption>
          <tr><td>Income events (staking, airdrops, rewards)</td><td>${y.incomeEvents}</td></tr>
          <tr class="rp-total"><td>Total income at sterling value on receipt</td><td>${gbp2(y.income)}</td></tr>
          ${incomes.map((e) => `<tr><td class="rp-sub">${date(e.ts)} · ${esc(e.note)}</td><td>${gbp2(e.gbp)}</td></tr>`).join('')}
          <tr><td colspan="2" class="rp-note">Report on SA100 box 17 (other taxable income) unless HMRC treats the activity as a trade. The £1,000 trading/miscellaneous income allowance may apply.</td></tr>
        </table>
      </div>

      <h3>Disposal computations</h3>
      <table class="rp-disposals">
        <thead><tr><th>Date</th><th>Asset</th><th class="r">Quantity</th><th class="r">Proceeds</th><th class="r">Allowable cost</th><th class="r">Gain / (loss)</th><th>Matching</th></tr></thead>
        <tbody>
        ${ds.map((d) => `<tr${d.flags.length ? ' class="rp-flag"' : ''}>
          <td>${date(d.ts)}</td><td>${esc(d.asset)}<div class="rp-sub">${esc(d.note)}</div></td>
          <td class="r">${amt(d.amount)}</td><td class="r">${gbp2(d.proceeds)}</td><td class="r">${gbp2(d.allowableCost)}</td>
          <td class="r ${d.gain < 0 ? 'neg' : ''}">${d.gain < 0 ? `(${gbp2(-d.gain)})` : gbp2(d.gain)}</td>
          <td class="rp-match">${d.matches.map((m) => `${RULE[m.rule] || m.rule}: ${amt(m.amount)} at cost ${gbp2(m.cost)}`).join('<br>')}${d.unmatched ? `<br><strong>Unmatched ${amt(d.unmatched)}: nil cost basis</strong>` : ''}${d.flags.map((f) => `<div class="rp-sub">⚠ ${esc(f)}</div>`).join('')}</td>
        </tr>`).join('') || '<tr><td colspan="7">No disposals in this tax year.</td></tr>'}
        </tbody>
      </table>
    </section>`;
  }).join('');

  const poolRows = Object.entries(pools).map(([a, p]) => `<tr><td>${esc(a)}</td><td class="r">${amt(p.amount)}</td><td class="r">${gbp2(p.cost)}</td><td class="r">${p.amount ? gbp2(p.cost / p.amount) : '—'}</td></tr>`).join('');

  return `
  <div class="rp">
    <header class="rp-head">
      <div><div class="rp-brand">tax<span>bl</span></div><div class="rp-sub">Cryptoasset capital gains and income computation</div></div>
      <div class="rp-meta">Source: ${esc(sourceLabel || 'wallet')}<br>Generated ${esc(generated)}<br>${events.length} events · ${disposals.length} disposals · ${reviewCount} items marked for review</div>
    </header>
    <p class="rp-basis"><strong>Basis of preparation.</strong> Disposals matched under HMRC's cryptoasset rules (CRYPTO22200 onwards): same-day acquisitions first, then acquisitions within the following 30 days, then the Section 104 pooled average cost. Crypto-to-crypto swaps are disposals at sterling market value. Transaction fees on disposal are allowable costs; fees on acquisition are added to cost. Income is valued in sterling on the day of receipt and forms the cost basis of the asset received. Sterling values use daily closing prices (Coinbase ETH-GBP / BTC-GBP; ECB USD-GBP for USD stablecoins), applied consistently. Items marked ⚠ are classifications the preparer should confirm.</p>
    ${yearSections}
    <section class="rp-year">
      <h3>Closing Section 104 pools (carried forward)</h3>
      <table class="rp-disposals"><thead><tr><th>Asset</th><th class="r">Quantity held</th><th class="r">Pooled cost</th><th class="r">Average cost per unit</th></tr></thead><tbody>${poolRows || '<tr><td colspan="4">Nothing carried forward.</td></tr>'}</tbody></table>
    </section>
    <footer class="rp-foot">This computation is generated mechanically from public ledger data and user classifications. It is not tax advice and does not include activity on exchanges or wallets not provided. Check with an accountant before filing. taxbl, rowbo.ai.</footer>
  </div>`;
}

function yearOf(ts) {
  const d = new Date(ts); const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const day = d.getUTCDate();
  const s = m > 3 || (m === 3 && day >= 6) ? y : y - 1; return `${s}/${String(s + 1).slice(2)}`;
}
