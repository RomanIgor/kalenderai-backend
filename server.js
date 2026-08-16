const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EMAIL_USER       = process.env.EMAIL_USER;
const EMAIL_PASS       = process.env.EMAIL_PASS;
const EMAIL_TO         = process.env.EMAIL_TO;
const DAILY_LIMIT      = parseInt(process.env.DAILY_LIMIT || '14400');
const ALERT_PERCENT    = 0.80;
const COUNTER_FILE     = path.join('/tmp', 'kalenderai_counter.json');
const TEXT_MODEL       = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
const PHOTO_MODEL      = process.env.GROQ_PHOTO_MODEL || 'qwen/qwen3.6-27b';
const TRANSCRIBE_MODEL = process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';

function today() {
  return new Date().toISOString().split('T')[0];
}

// ── Persistent counter (survives restarts within same day) ──────────────────
function loadCounter() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
      if (data.date === today()) return data;
    }
  } catch(e) {}
  return { date: today(), count: 0, alerted: false };
}

function saveCounter(c) {
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(c)); } catch(e) {}
}

let counter = loadCounter();

function getCounter() {
  if (counter.date !== today()) {
    counter = { date: today(), count: 0, alerted: false };
    saveCounter(counter);
  }
  return counter;
}

// ── Notifications ─────────────────────────────────────────────────────────
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
    saveCounter(c);
    const pctStr = Math.round(pct * 100);
    const msg = `⚠️ <b>KalenderAI Alert</b>\n\n${pctStr}% des Tageslimits erreicht!\n📊 ${c.count} / ${DAILY_LIMIT} Anfragen\n📅 ${c.date}`;
    await Promise.all([sendTelegram(msg), sendEmail(`⚠️ KalenderAI — ${pctStr}% Limit`, msg.replace(/<[^>]+>/g,''))]);
    console.log(`🚨 Alert sent at ${pctStr}%`);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
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

app.post('/api/analyze', async (req, res) => {
  const c = getCounter();
  if (c.count >= DAILY_LIMIT) return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen versuchen.' });
  try {
    const { messages, mode } = req.body;
    const model = mode === 'photo' ? PHOTO_MODEL : TEXT_MODEL;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 1500,
        response_format: mode !== 'photo' ? { type: 'json_object' } : undefined })
    });
    const data = await response.json();
    if (data.error) throw new Error(`Groq ${model}: ${data.error.message}`);
    c.count++;
    saveCounter(c);
    await checkAndAlert(c);
    res.json(data);
  } catch(err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  const c = getCounter();
  if (c.count >= DAILY_LIMIT) return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen versuchen.' });
  try {
    const formData = new FormData();
    formData.append('file', req.file.buffer, { filename: 'audio.webm', contentType: req.file.mimetype || 'audio/webm' });
    formData.append('model', TRANSCRIBE_MODEL);
    formData.append('language', 'de');
    formData.append('response_format', 'text');
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...formData.getHeaders() },
      body: formData
    });
    if (!response.ok) throw new Error(await response.text());
    const transcript = await response.text();
    c.count++;
    saveCounter(c);
    await checkAndAlert(c);
    res.send(transcript);
  } catch(err) {
    console.error('Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ KalenderAI backend running on port ${PORT}`));
