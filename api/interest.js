// Records "I'd pay for the full report" interest, UK GDPR / PECR style:
//   - explicit consent flag required (PECR reg 22: marketing email to individuals needs consent)
//   - data minimised: email, consent timestamp, tax years, counts. NO wallet address, NO IP, NO user agent.
//   - no database: forwarded to a private chat channel via INTEREST_WEBHOOK_URL, and logged.
//   - erasure: email ben@rowbo.ai (see the privacy notice on the page); the channel message is deleted by hand.
// Body: { email, consent: true, taxYears, disposals, taxable, source }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const email = String(body.email || '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  if (body.consent !== true) return res.status(400).json({ ok: false, error: 'Tick the box to agree to be emailed.' });
  if (typeof body.address === 'string' || typeof body.wallet === 'string') return res.status(400).json({ ok: false, error: 'Addresses are never accepted here.' });

  const record = {
    ts: new Date().toISOString(),
    email,
    consent: true,
    consentText: 'Email me about the TaxTape full report launch. Unsubscribe any time.',
    taxYears: String(body.taxYears || '').slice(0, 100),
    disposals: Math.max(0, Math.min(100000, Number(body.disposals) || 0)),
    taxable: Math.max(0, Math.min(1e9, Number(body.taxable) || 0)),
    source: body.source === 'sample' ? 'sample' : 'wallet',
  };
  console.log('INTEREST', JSON.stringify(record));

  const url = process.env.INTEREST_WEBHOOK_URL;
  if (url) {
    const text = `TaxTape interest · ${record.email} · consent ${record.ts} · years ${record.taxYears || '?'} · ${record.disposals} disposals · taxable £${record.taxable.toFixed(0)} · ${record.source}`;
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }) });
    } catch (err) {
      console.error('webhook failed', err);
    }
  }
  return res.status(200).json({ ok: true });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
