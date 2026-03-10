const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Config from environment variables ──────────────────────────────────────
const GROQ_API_KEY      = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const EMAIL_USER        = process.env.EMAIL_USER;       // Gmail address
const EMAIL_PASS        = process.env.EMAIL_PASS;       // Gmail app password
const EMAIL_TO          = process.env.EMAIL_TO;
const DAILY_LIMIT       = parseInt(process.env.DAILY_LIMIT || '14400');
const ALERT_PERCENT     = 0.80; // 80%

// ── Simple in-memory counter (resets at midnight UTC) ───────────────────────
let counter = { date: today(), count: 0, alerted: false };

function today() {
  return new Date().toISOString().split('T')[0];
}

function getCounter() {
  const d = today();
  if (counter.date !== d) {
    counter = { date: d, count: 0, alerted: false };
  }
  return counter;
}

// ── Notifications ────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

async function sendEmail(subject, text) {
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) return;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });
    await transporter.sendMail({ from: EMAIL_USER, to: EMAIL_TO, subject, text });
  } catch(e) { console.error('Email error:', e.message); }
}

async function checkAndAlert(c) {
  if (c.alerted) return;
  const pct = c.count / DAILY_LIMIT;
  if (pct >= ALERT_PERCENT) {
    c.alerted = true;
    const used = c.count;
    const pctStr = Math.round(pct * 100);
    const msg = `⚠️ <b>KalenderAI Alert</b>\n\nDu hast ${pctStr}% des täglichen Limits erreicht!\n📊 Verwendet: ${used} / ${DAILY_LIMIT} Anfragen\n📅 Datum: ${c.date}\n\nBitte überprüfe die Nutzung.`;
    await Promise.all([
      sendTelegram(msg),
      sendEmail(
        `⚠️ KalenderAI — ${pctStr}% Limit erreicht`,
        `Du hast ${pctStr}% des täglichen Groq-Limits erreicht.\n\nVerwendet: ${used} / ${DAILY_LIMIT} Anfragen\nDatum: ${c.date}`
      )
    ]);
    console.log(`🚨 Alert sent at ${pctStr}% (${used} requests)`);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  const c = getCounter();
  res.json({
    status: 'ok',
    today: c.date,
    requests: c.count,
    limit: DAILY_LIMIT,
    percent: Math.round((c.count / DAILY_LIMIT) * 100) + '%'
  });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const c = getCounter();
  res.json({
    date: c.date,
    count: c.count,
    limit: DAILY_LIMIT,
    remaining: DAILY_LIMIT - c.count,
    percent: Math.round((c.count / DAILY_LIMIT) * 100),
    alerted: c.alerted
  });
});

// Text / Photo → Chat completions proxy
app.post('/api/analyze', async (req, res) => {
  const c = getCounter();

  if (c.count >= DAILY_LIMIT) {
    return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen erneut versuchen.' });
  }

  try {
    const { messages, mode } = req.body;
    const model = mode === 'photo'
      ? 'meta-llama/llama-4-scout-17b-16e-instruct'
      : 'llama-3.3-70b-versatile';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1500,
        response_format: mode !== 'photo' ? { type: 'json_object' } : undefined
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    c.count++;
    await checkAndAlert(c);

    res.json(data);
  } catch(err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Voice → Whisper transcription proxy
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  const c = getCounter();

  if (c.count >= DAILY_LIMIT) {
    return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen erneut versuchen.' });
  }

  try {
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname || 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'de');
    formData.append('response_format', 'text');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) throw new Error(await response.text());
    const transcript = await response.text();

    c.count++;
    await checkAndAlert(c);

    res.send(transcript);
  } catch(err) {
    console.error('Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ KalenderAI backend running on port ${PORT}`));
