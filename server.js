const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const { createGroqClient } = require('./lib/groq-client');
const { createModelResolver } = require('./lib/model-resolver');

const ALERT_PERCENT = 0.80;
const COUNTER_FILE = path.join('/tmp', 'kalenderai_counter.json');

function parseModelList(value) {
  return [...new Set(String(value || '').split(',').map(model => model.trim()).filter(Boolean))];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function createPreferences() {
  return {
    text: parseModelList(process.env.GROQ_TEXT_MODELS || process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b'),
    photo: parseModelList(process.env.GROQ_PHOTO_MODELS || process.env.GROQ_PHOTO_MODEL || 'qwen/qwen3.8-27b'),
    transcribe: [process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3']
  };
}

function createFileCounterStore({ counterFile = COUNTER_FILE, currentDate = today } = {}) {
  let counter = loadCounter();

  function loadCounter() {
    try {
      if (fs.existsSync(counterFile)) {
        const data = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
        if (data.date === currentDate()) return data;
      }
    } catch (error) {
      // Counter persistence is best effort, matching the existing behavior.
    }
    return freshCounter(currentDate());
  }

  function save(nextCounter) {
    counter = nextCounter;
    try {
      fs.writeFileSync(counterFile, JSON.stringify(counter));
    } catch (error) {
      // Requests must remain available if the counter file cannot be written.
    }
  }

  function get() {
    const date = currentDate();
    if (counter.date !== date) save(freshCounter(date));
    return counter;
  }

  return { get, save };
}

function freshCounter(date) {
  return { date, count: 0, alerted: false };
}

function createNotifier() {
  const telegramToken = process.env.TELEGRAM_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  const emailTo = process.env.EMAIL_TO;

  return {
    async notify({ subject, message, telegramMessage = message }) {
      await Promise.all([
        sendTelegram(telegramMessage).catch(error => console.error('Telegram error:', error.message)),
        sendEmail(subject, message).catch(error => console.error('Email error:', error.message))
      ]);
    }
  };

  async function sendTelegram(message) {
    if (!telegramToken || !telegramChatId) return;
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message, parse_mode: 'HTML' })
    });
  }

  async function sendEmail(subject, message) {
    if (!emailUser || !emailPass || !emailTo) return;
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass }
    });
    await transporter.sendMail({ from: emailUser, to: emailTo, subject, text: message });
  }
}

async function notifySafely(notifier, alert) {
  try {
    await notifier.notify(alert);
  } catch (error) {
    console.error('Notification error:', error.message);
  }
}

async function sendAlertOnce({ counterStore, notifier, key, subject, message }) {
  const counter = counterStore.get();
  counter.modelAlerts = counter.modelAlerts || {};
  if (counter.modelAlerts[key] === counter.date) return;

  counter.modelAlerts[key] = counter.date;
  counterStore.save(counter);
  await notifySafely(notifier, { subject, message });
}

function createModelTransitionHandler({ counterStore, notifier }) {
  return async ({ capability, from, to, reason }) => {
    const key = `model-transition:${capability}:${from}:${to}`;
    const message = [
      'KalenderAI model transition',
      '',
      `Capability: ${capability}`,
      `Previous model: ${from}`,
      `Selected model: ${to}`,
      `Reason: ${reason}`,
      'Service continued automatically after the model switch.'
    ].join('\n');

    await sendAlertOnce({
      counterStore,
      notifier,
      key,
      subject: 'KalenderAI model transition',
      message
    });
  };
}

async function sendCriticalHealthAlerts({ counterStore, notifier, capabilities }) {
  const failedCapabilities = Object.entries(capabilities)
    .filter(([, health]) => health.healthy === false);

  await Promise.all(failedCapabilities.map(async ([capability, health]) => {
    const message = [
      'KalenderAI critical model health failure',
      '',
      `No accessible Groq Free model satisfies the ${capability} capability.`,
      `Error: ${health.error || 'Capability unavailable'}`
    ].join('\n');

    await sendAlertOnce({
      counterStore,
      notifier,
      key: `model-critical:${capability}`,
      subject: 'KalenderAI critical model health failure',
      message
    });
  }));
}

async function checkAndAlert({ counter, counterStore, notifier, dailyLimit }) {
  if (counter.alerted) return;
  const percentage = counter.count / dailyLimit;
  if (percentage < ALERT_PERCENT) return;

  counter.alerted = true;
  counterStore.save(counter);
  const roundedPercentage = Math.round(percentage * 100);
  const telegramMessage = `⚠️ <b>KalenderAI Alert</b>\n\n${roundedPercentage}% des Tageslimits erreicht!\n📊 ${counter.count} / ${dailyLimit} Anfragen\n📅 ${counter.date}`;
  await notifySafely(notifier, {
    subject: `⚠️ KalenderAI — ${roundedPercentage}% Limit`,
    message: telegramMessage.replace(/<[^>]+>/g, ''),
    telegramMessage
  });
  console.log(`🚨 Alert sent at ${roundedPercentage}%`);
}

function canCheckModels(req) {
  const token = process.env.MODEL_CHECK_TOKEN;
  if (!token) return true;
  const auth = req.get('authorization') || '';
  return auth === `Bearer ${token}` || req.query.token === token;
}

function createApp(options = {}) {
  const dailyLimit = Number.parseInt(process.env.DAILY_LIMIT || '14400', 10);
  const counterStore = options.counterStore || createFileCounterStore();
  const notifier = options.notifier || createNotifier();
  const groqClient = options.groqClient || createGroqClient({ apiKey: process.env.GROQ_API_KEY });
  const resolver = options.resolver || createModelResolver({
    client: groqClient,
    preferences: createPreferences(),
    cacheTtlMs: Number.parseInt(process.env.MODEL_CACHE_TTL_MS || '86400000', 10),
    maxCandidates: Number.parseInt(process.env.MODEL_MAX_CANDIDATES || '8', 10),
    onTransition: createModelTransitionHandler({ counterStore, notifier })
  });
  const upload = multer({ storage: multer.memoryStorage() });
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/', (req, res) => {
    const counter = counterStore.get();
    res.json({
      status: 'ok',
      today: counter.date,
      requests: counter.count,
      limit: dailyLimit,
      percent: Math.round((counter.count / dailyLimit) * 100) + '%'
    });
  });

  app.get('/stats', (req, res) => {
    const counter = counterStore.get();
    res.json({
      date: counter.date,
      count: counter.count,
      limit: dailyLimit,
      remaining: dailyLimit - counter.count,
      percent: Math.round((counter.count / dailyLimit) * 100),
      alerted: counter.alerted
    });
  });

  app.get('/model-check', async (req, res) => {
    if (!canCheckModels(req)) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const health = await resolver.checkHealth();
      const checks = health.capabilities;
      const unavailable = Object.values(checks).some(capability => capability.healthy === false);
      if (unavailable) {
        await sendCriticalHealthAlerts({ counterStore, notifier, capabilities: checks });
      }

      res.status(unavailable ? 503 : 200).json({
        status: unavailable ? 'model_unavailable' : 'ok',
        checkedAt: new Date().toISOString(),
        checks
      });
    } catch (error) {
      console.error('Model check error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/test-alert', async (req, res) => {
    if (!canCheckModels(req)) return res.status(401).json({ error: 'Unauthorized' });

    const message = [
      'KalenderAI test alert',
      '',
      'Telegram/email alerts are configured correctly.',
      `Date: ${today()}`
    ].join('\n');
    await notifySafely(notifier, { subject: 'KalenderAI test alert', message });

    res.json({
      status: 'sent',
      telegramConfigured: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
      emailConfigured: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.EMAIL_TO)
    });
  });

  app.post('/api/analyze', async (req, res) => {
    const counter = counterStore.get();
    if (counter.count >= dailyLimit) {
      return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen versuchen.' });
    }

    try {
      const { messages, mode } = req.body;
      const capability = mode === 'photo' ? 'photo' : 'text';
      const data = await resolver.execute(
        capability,
        model => groqClient.chat(model, messages, capability)
      );
      counter.count++;
      counterStore.save(counter);
      await checkAndAlert({ counter, counterStore, notifier, dailyLimit });
      res.json(data);
    } catch (error) {
      console.error('Analyze error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/transcribe', upload.single('file'), async (req, res) => {
    const counter = counterStore.get();
    if (counter.count >= dailyLimit) {
      return res.status(429).json({ error: 'Tageslimit erreicht. Bitte morgen versuchen.' });
    }

    try {
      const selected = await resolver.resolve('transcribe');
      const transcript = await groqClient.transcribe(selected.model, req.file);
      counter.count++;
      counterStore.save(counter);
      await checkAndAlert({ counter, counterStore, notifier, dailyLimit });
      res.send(transcript);
    } catch (error) {
      console.error('Transcribe error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`✅ KalenderAI backend running on port ${port}`));
}

module.exports = { createApp };
