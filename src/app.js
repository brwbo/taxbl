import { fetchLegs, isAddress } from './chain.js';
import { classify, TYPES, TYPE_LABEL, unpricedAssets } from './classify.js';
import { computeTax, indicativeCgt } from './engine.js';
import { SAMPLE_EVENTS } from './sample.js';
import { buildReport } from './report.js';
import { parseExchangeCsv } from './csv.js';

const $ = (id) => document.getElementById(id);
const gbp = (n) => (n == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n));
const gbp2 = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
const amt = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : n.toLocaleString('en-GB', { maximumFractionDigits: 6 }));
const date = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let events = [];
let source = { label: '', truncated: false };

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function render() {
  const result = computeTax(events);
  const { disposals, years } = result;
  const byId = new Map(disposals.map((d) => [d.id, d]));
  const yearList = Object.values(years).sort((a, b) => a.taxYear.localeCompare(b.taxYear));
  const flaggedCount = events.filter((e) => e.flags?.length || !e.priced).length;
  const totalProceeds = disposals.reduce((s, d) => s + d.proceeds, 0);
  const totalTaxable = yearList.reduce((s, y) => s + y.taxableGain, 0);
  const totalIncome = yearList.reduce((s, y) => s + y.income, 0);
  const unpriced = unpricedAssets(events);

  $('summary').innerHTML = `
    <div class="card"><h3>Disposals found</h3><div class="big">${disposals.length}</div><div class="sub">${gbp(totalProceeds)} total proceeds across ${yearList.length} tax year${yearList.length === 1 ? '' : 's'}</div></div>
    <div class="card"><h3>Taxable gains (above allowance)</h3><div class="big ${totalTaxable > 0 ? 'bad' : 'good'}">${gbp(totalTaxable)}</div><div class="sub">after the annual exempt amount, summed across years</div></div>
    <div class="card"><h3>Income from crypto</h3><div class="big ${totalIncome > 0 ? 'warn' : ''}">${gbp(totalIncome)}</div><div class="sub">staking, airdrops, rewards: taxed as income at receipt</div></div>
    <div class="card"><h3>Needs your review</h3><div class="big ${flaggedCount ? 'warn' : 'good'}">${flaggedCount}</div><div class="sub">${unpriced.length ? `no sterling price for ${unpriced.map(esc).join(', ')}; ` : ''}guesses you should confirm or correct</div></div>
    <div class="card hmrc"><h3>What you'll need to explain when HMRC's data arrives</h3>
      <div>Since 1 January 2026, UK exchanges and custodial wallets have been recording your <strong>sales, swaps and transfers to private wallets</strong> under CARF. They file it to HMRC between January and May 2027, and HMRC matches it against your Self Assessment. That file only shows what the exchange saw. This tape shows what the public ledger says happened, including wallet-to-wallet and DeFi activity no exchange reports, so it is the version you will have to reconcile.</div>
      <ul>
        ${yearList.map((y) => `<li><strong>${y.taxYear}</strong>: ${y.disposals} disposal${y.disposals === 1 ? '' : 's'} worth ${gbp(y.proceeds)}${y.taxableGain > 0 ? `, <span class="bad">${gbp(y.taxableGain)} taxable gain</span> (indicative CGT ${gbp(indicativeCgt(y.taxYear, y.taxableGain).basic)}–${gbp(indicativeCgt(y.taxYear, y.taxableGain).higher)})` : ', <span class="good">within the allowance</span>'}${y.income > 0 ? `, <span class="warn">${gbp(y.income)} income</span>` : ''}${y.proceeds > 50000 && y.taxableGain === 0 ? ' <span class="warn">— proceeds exceed £50,000, so you must still report on Self Assessment even with no tax due</span>' : ''}</li>`).join('')}
        ${source.truncated ? '<li class="warn">History truncated for the demo: only the most recent ~300 transactions and token transfers were read.</li>' : ''}
      </ul>
    </div>
    <div class="card cta"><div><h3>Full report</h3><p>The Self Assessment computation for every tax year: SA108 figures, a per-disposal audit trail showing which purchases were matched under which rule, income schedule, and closing pools. Printable to PDF.</p></div>
      <div><button id="openReport" type="button">See the full report</button><span class="price">£29 per tax year when it launches</span></div></div>`;

  $('years').innerHTML = yearList.map((y) => {
    const cgt = indicativeCgt(y.taxYear, y.taxableGain);
    return `<div class="card year"><h3>Tax year ${y.taxYear}</h3><table>
      <tr><td>Disposals</td><td>${y.disposals}</td></tr>
      <tr><td>Proceeds</td><td>${gbp2(y.proceeds)}</td></tr>
      <tr><td>Allowable costs</td><td>${gbp2(y.allowableCost)}</td></tr>
      <tr><td>Gains</td><td class="good">${gbp2(y.gains)}</td></tr>
      <tr><td>Losses</td><td class="bad">${gbp2(y.losses)}</td></tr>
      <tr><td>Net gain</td><td>${gbp2(y.netGain)}</td></tr>
      <tr><td>Annual exempt amount</td><td>${gbp2(y.allowance)}</td></tr>
      <tr class="total"><td>Taxable gain</td><td class="${y.taxableGain > 0 ? 'bad' : 'good'}">${gbp2(y.taxableGain)}</td></tr>
      <tr><td>Indicative CGT (${Math.round(cgt.rates[0] * 100)}% / ${Math.round(cgt.rates[1] * 100)}%)</td><td>${gbp(cgt.basic)} – ${gbp(cgt.higher)}</td></tr>
      <tr class="total"><td>Income (${y.incomeEvents})</td><td class="warn">${gbp2(y.income)}</td></tr>
      ${y.flagged ? `<tr><td>Items to review</td><td class="warn">${y.flagged}</td></tr>` : ''}
    </table></div>`;
  }).join('');

  const onlyFlagged = $('onlyFlagged').checked;
  const rows = events.filter((e) => !onlyFlagged || e.flags?.length || !e.priced);
  $('count').textContent = `${rows.length} of ${events.length} events`;
  $('rows').innerHTML = rows.map((e) => {
    const d = byId.get(e.id);
    const flagged = e.flags?.length || !e.priced;
    return `<tr class="${flagged ? 'flagged' : ''}" data-id="${esc(e.id)}">
      <td>${date(e.ts)}</td>
      <td><div>${esc(e.note)}</div>${(e.flags || []).map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}${d?.flags?.filter((f) => !e.flags?.includes(f)).map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('') || ''}</td>
      <td><select data-field="type">${TYPES.map((t) => `<option value="${t}" ${t === e.type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select><div style="margin-top:4px"><span class="pill ${e.type}">${e.type}</span></div></td>
      <td>${esc(e.asset)}</td>
      <td class="num">${amt(e.amount)}</td>
      <td class="num"><input data-field="gbp" type="number" step="0.01" value="${(e.gbp ?? 0).toFixed(2)}" ${e.priced ? '' : 'style="border-color:var(--warn)"'}></td>
      <td class="num">${e.feeGbp ? gbp2(e.feeGbp) : '—'}</td>
      <td class="num">${d ? `<span class="gain ${d.gain >= 0 ? 'pos' : 'neg'}">${gbp2(d.gain)}</span>` : ''}</td>
      <td>${d ? `<div class="matches">${d.matches.map((m) => `${m.rule} ${amt(m.amount)} @ ${gbp2(m.cost)}`).join('<br>')}${d.unmatched ? `<br><span class="warn">unmatched ${amt(d.unmatched)}</span>` : ''}</div>` : ''}</td>
    </tr>`;
  }).join('');

  $('results').classList.remove('hidden');
}
function revealResults() { render(); $('results').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function onEdit(ev) {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;
  const e = events.find((x) => x.id === tr.dataset.id);
  if (!e) return;
  const field = ev.target.dataset.field;
  if (field === 'type') e.type = ev.target.value;
  if (field === 'gbp') { e.gbp = Number(ev.target.value) || 0; e.priced = true; e.flags = (e.flags || []).filter((f) => !f.startsWith('No sterling price')); }
  render();
}

async function runAddress(address) {
  $('run').disabled = true;
  try {
    setStatus('Reading the chain…');
    const { legs, truncated } = await fetchLegs(address, setStatus);
    if (!legs.length) { setStatus('No ETH or ERC-20 activity found for that address.'); return; }
    setStatus(`Found ${legs.length} movements. Valuing in sterling…`);
    events = await classify(legs, setStatus);
    source = { label: address, truncated };
    setStatus(`${events.length} events classified. Correct anything marked ⚠ and the totals update.`);
    revealResults();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  } finally {
    $('run').disabled = false;
  }
}

function exportCsv() {
  const { disposals } = computeTax(events);
  const byId = new Map(disposals.map((d) => [d.id, d]));
  const head = ['date', 'type', 'asset', 'amount', 'gbp_value', 'fee_gbp', 'gain_gbp', 'matched_by', 'note', 'flags'];
  const lines = [head.join(',')].concat(events.map((e) => {
    const d = byId.get(e.id);
    const cells = [e.ts, e.type, e.asset, e.amount, (e.gbp ?? 0).toFixed(2), (e.feeGbp || 0).toFixed(2), d ? d.gain.toFixed(2) : '', d ? d.matches.map((m) => m.rule).join('|') : '', e.note, (e.flags || []).join(' | ')];
    return cells.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `taxbl-${source.label || 'wallet'}.csv`;
  a.click();
}

$('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const a = $('address').value.trim();
  if (!isAddress(a)) { setStatus('Paste a full Ethereum address: 0x followed by 40 hex characters.', true); return; }
  runAddress(a);
});
$('sample').addEventListener('click', () => {
  events = SAMPLE_EVENTS.map((e) => ({ ...e, flags: [...e.flags] }));
  source = { label: 'sample-wallet', truncated: false };
  $('address').value = '';
  setStatus('Sample wallet loaded: 21 events across three tax years, including a same-day trade, a 30-day bed-and-breakfast, staking income, an airdrop and an unpriced token.');
  revealResults();
});
$('rows').addEventListener('change', onEdit);
$('onlyFlagged').addEventListener('change', render);
$('export').addEventListener('click', exportCsv);
$('csvFile').addEventListener('change', importCsvFiles);
$('tplLink').addEventListener('click', (ev) => {
  ev.preventDefault();
  const blob = new Blob(['date,type,asset,amount,gbp_value,fee_gbp,note\n2024-06-01,acquire,ETH,1,2000,5,bought on exchange\n2024-09-01,dispose,ETH,1,2500,5,sold for GBP\n'], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'taxbl-template.csv'; a.click();
});

async function importCsvFiles(ev) {
  const files = [...ev.target.files];
  if (!files.length) return;
  const results = [];
  for (const f of files) {
    try {
      setStatus(`Reading ${f.name}…`);
      const { events: imported, format, skipped } = await parseExchangeCsv(await f.text(), f.name);
      events = events.concat(imported);
      results.push(`${f.name}: ${imported.length} events (${format}${skipped ? `, ${skipped} rows skipped` : ''})`);
    } catch (err) {
      results.push(err.message || `${f.name}: failed`);
    }
  }
  ev.target.value = '';
  if (events.length) {
    events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (!source.label) source = { label: 'csv-import', truncated: false };
    else if (source.label !== 'csv-import') source = { label: `${source.label}+csv`, truncated: source.truncated };
    revealResults();
  }
  setStatus(results.join(' · '));
}
$('summary').addEventListener('click', (ev) => { if (ev.target.id === 'openReport') openReport(); });
$('closeReport').addEventListener('click', () => $('reportDlg').close());
$('printReport').addEventListener('click', () => window.print());
$('unlockForm').addEventListener('submit', submitInterest);

function openReport() {
  $('reportBody').innerHTML = buildReport(events, source.label);
  $('reportDlg').showModal();
  $('unlockMsg').textContent = ''; $('unlockMsg').className = 'msg';
}

async function submitInterest(ev) {
  ev.preventDefault();
  const { years } = computeTax(events);
  const ys = Object.values(years);
  const payload = {
    email: $('unlockEmail').value.trim(),
    consent: $('unlockConsent').checked === true,
    taxYears: ys.map((y) => y.taxYear).join(','),
    disposals: ys.reduce((s, y) => s + y.disposals, 0),
    taxable: ys.reduce((s, y) => s + y.taxableGain, 0),
    source: source.label === 'sample-wallet' ? 'sample' : 'wallet',
  };
  const msg = $('unlockMsg'); const btn = $('unlockBtn');
  if (!payload.consent) { msg.className = 'msg err'; msg.textContent = 'Tick the box to agree to be emailed.'; return; }
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Saving…';
  try {
    const res = await fetch('/api/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
    msg.className = 'msg ok'; msg.textContent = 'Got it. You will get the first release free.';
    $('unlockEmail').value = ''; $('unlockConsent').checked = false;
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message || 'Could not save that. Try again.';
  } finally { btn.disabled = false; }
}

// Deep link: ?a=0x…
const qp = new URLSearchParams(location.search).get('a');
if (qp && isAddress(qp)) { $('address').value = qp; document.getElementById('runit').scrollIntoView(); runAddress(qp); }

// Hero video: raw clip, colour comes from CSS invert/hue-rotate. Keep it playing.
const heroVideo = $('heroVideo');
if (heroVideo) {
  const tryPlay = () => { if (heroVideo.paused) heroVideo.play().catch(() => {}); };
  heroVideo.addEventListener('canplay', tryPlay);
  document.addEventListener('pointerdown', tryPlay, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tryPlay(); });
  [300, 1000, 3000].forEach((ms) => setTimeout(tryPlay, ms));
}
