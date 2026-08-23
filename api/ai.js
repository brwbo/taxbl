// AI explainer endpoint. Takes the computed tax position (year summaries + event list,
// stripped of anything identifying) and returns a plain-English explanation.
// Privacy: the frontend never sends addresses or transaction hashes here - see buildAiPayload()
// in src/app.js - and this endpoint rejects anything that looks like one, mirroring /api/interest.
// Provider: OpenAI chat completions (OPENAI_API_KEY; model via OPENAI_MODEL, default gpt-5.1).


const MAX_EVENTS = 60;
const hits = new Map(); // best-effort per-instance rate limit

const SYSTEM = `You are the explainer inside taxbl, a UK crypto tax checker. You are given a person's
computed tax position: per-tax-year capital gains summaries produced under HMRC's cryptoasset rules
(same-day, 30-day, Section 104 pooling), plus a list of their classified events, some flagged ⚠ as
guesses needing review.

Write the explanation a worried, non-expert UK person needs. Rules:
- Lead with the answer: roughly what they owe (or that they owe nothing) and which tax years matter.
- Point at the two or three specific events that drive the number, by date and description.
- List the flagged items that could change the answer most, and what to check on each.
- State the relevant deadline: Self Assessment for a tax year is due 31 January following the end of
  that tax year, and HMRC receives exchange data under CARF from mid-2027.
- Plain English. No jargon without a one-clause explanation. Sterling figures rounded to the pound.
- Be honest about uncertainty: these figures are indicative and assume the classifications are right.
- Never invent figures not present in the data. Never give planning advice beyond "check with an
  accountant"; you explain the position, you do not advise schemes.
- Length: 150-300 words. No headings, no bullets unless listing flagged items.`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ ok: false, error: 'AI is not configured yet.' });

  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0];
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 5) return res.status(429).json({ ok: false, error: 'Slow down: a few explanations a minute is plenty.' });
  hits.set(ip, [...recent, now]);

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const raw = JSON.stringify(body);
  if (raw.length > 60000) return res.status(400).json({ ok: false, error: 'Too much data.' });
  if (/0x[0-9a-fA-F]{40}/.test(raw)) return res.status(400).json({ ok: false, error: 'Addresses are never accepted here.' });

  const years = Array.isArray(body.years) ? body.years.slice(0, 10) : [];
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (!years.length) return res.status(400).json({ ok: false, error: 'Run the tape first.' });

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.1',
        max_completion_tokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Per-tax-year summaries:\n${JSON.stringify(years)}\n\nEvents (flagged ones carry "flags"):\n${JSON.stringify(events)}\n\nExplain this person's position.` },
        ],
      }),
    });
    if (resp.status === 429) return res.status(503).json({ ok: false, error: 'The AI is busy. Try again in a minute.' });
    if (!resp.ok) { console.error('openai', resp.status, (await resp.text()).slice(0, 300)); return res.status(502).json({ ok: false, error: 'Explanation failed. The numbers on the page still stand.' }); }
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) return res.status(502).json({ ok: false, error: 'Empty response. Try again.' });
    return res.status(200).json({ ok: true, text });
  } catch (err) {
    console.error('ai error', err?.status, err?.message);
    if (err?.status === 429) return res.status(503).json({ ok: false, error: 'The AI is busy. Try again in a minute.' });
    return res.status(502).json({ ok: false, error: 'Explanation failed. The numbers on the page still stand.' });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
