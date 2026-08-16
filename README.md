# KalenderAI Backend

Backend proxy for the KalenderAI TWA/web app.

## Architecture

- Frontend/TWA: `https://romanigor.github.io/KalenderAI/`
- Backend API: `https://kalenderai-backend.onrender.com`
- Backend repository: `https://github.com/RomanIgor/kalenderai-backend`
- AI provider: Groq

The frontend sends text, photo, or audio requests to this backend. The backend keeps the Groq API key private, forwards requests to Groq, counts daily API requests, and sends optional Telegram/email alerts.

## Current Groq Models

Default models in code:

```env
GROQ_TEXT_MODELS=openai/gpt-oss-120b
GROQ_PHOTO_MODELS=qwen/qwen3.6-27b
GROQ_TRANSCRIBE_MODEL=whisper-large-v3
```

`GROQ_TEXT_MODELS` and `GROQ_PHOTO_MODELS` can contain comma-separated fallback models:

```env
GROQ_TEXT_MODELS=openai/gpt-oss-120b,qwen/qwen3.6-27b
GROQ_PHOTO_MODELS=qwen/qwen3.6-27b
```

If Groq returns a model-unavailable error, the backend tries the next model in the list. If fallback is used, it sends a Telegram/email alert once per day for that failed model.

## Render Environment Variables

Required:

```env
GROQ_API_KEY=...
```

Recommended:

```env
GROQ_TEXT_MODELS=openai/gpt-oss-120b,qwen/qwen3.6-27b
GROQ_PHOTO_MODELS=qwen/qwen3.6-27b
GROQ_TRANSCRIBE_MODEL=whisper-large-v3
MODEL_CHECK_TOKEN=make-a-long-random-secret
```

Optional alerts:

```env
TELEGRAM_TOKEN=...
TELEGRAM_CHAT_ID=...
EMAIL_USER=...
EMAIL_PASS=...
EMAIL_TO=...
DAILY_LIMIT=14400
```

## Telegram Alerts

The backend sends Telegram alerts for:

- daily request usage when 80 percent of `DAILY_LIMIT` is reached
- automatic Groq model fallback
- failed `/model-check` when a configured model is no longer available

Setup:

1. Create a bot with Telegram `@BotFather`.
2. Copy the bot token into Render as `TELEGRAM_TOKEN`.
3. Send any message to the bot from your Telegram account.
4. Get your chat id and add it to Render as `TELEGRAM_CHAT_ID`.
5. Redeploy the Render service.

## Model Health Check

Endpoint:

```text
https://kalenderai-backend.onrender.com/model-check
```

If `MODEL_CHECK_TOKEN` is set, use:

```text
https://kalenderai-backend.onrender.com/model-check?token=YOUR_TOKEN
```

Healthy response:

```json
{
  "status": "ok",
  "checks": {
    "text": [{ "model": "openai/gpt-oss-120b", "available": true }],
    "photo": [{ "model": "qwen/qwen3.6-27b", "available": true }],
    "transcribe": [{ "model": "whisper-large-v3", "available": true }]
  }
}
```

If a model becomes unavailable, the endpoint returns HTTP `503` and sends a Telegram/email alert once per day.

## Daily Automation

Use an external scheduler to call `/model-check` once per day.

Simple options:

- cron-job.org
- Render Cron Job
- UptimeRobot monitor

Recommended cron-job.org configuration:

- URL: `https://kalenderai-backend.onrender.com/model-check?token=YOUR_TOKEN`
- Method: `GET`
- Schedule: daily, for example 08:00 Europe/Berlin
- Expected status: `200`

This check does not send user text, photos, or audio to Groq. It only asks Groq for the model list and compares model ids.

## Manual Verification

Check backend status:

```powershell
Invoke-RestMethod https://kalenderai-backend.onrender.com/
```

Check configured models:

```powershell
Invoke-RestMethod "https://kalenderai-backend.onrender.com/model-check?token=YOUR_TOKEN"
```

Validate server syntax locally:

```powershell
node --check server.js
```

## Deployment

Render is connected to the backend GitHub repository. After pushing to `main`, Render usually redeploys automatically.

If it does not:

1. Open the Render service.
2. Click `Manual Deploy`.
3. Click `Deploy latest commit`.

