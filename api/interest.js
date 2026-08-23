// Records "I'd pay for the full report" interest. No database: forwards to a chat webhook
// (Discord or Slack incoming-webhook URL in INTEREST_WEBHOOK_URL) and logs the line.
// Body: { email, taxYears, disposals, taxable, source }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const email = String(body.email || '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });

  const record = {
    ts: new Date().toISOString(),
    email,
    taxYears: String(body.taxYears || '').slice(0, 100),
    disposals: Number(body.disposals) || 0,
    taxable: Number(body.taxable) || 0,
    source: String(body.source || '').slice(0, 80),
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
  };
  console.log('INTEREST', JSON.stringify(record));

  const url = process.env.INTEREST_WEBHOOK_URL;
  if (url) {
    const text = `💷 TaxTape interest: ${record.email} · years ${record.taxYears || '?'} · ${record.disposals} disposals · taxable £${record.taxable.toFixed(0)} · ${record.source}`;
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }) });
    } catch (err) {
      console.error('webhook failed', err);
    }
  }
  return res.status(200).json({ ok: true });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
