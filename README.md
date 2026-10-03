# KalenderAI Backend

Backend proxy for the KalenderAI TWA/web app.

## Architecture

- Frontend/TWA: `https://romanigor.github.io/KalenderAI/`
- Backend API: `https://kalenderai-backend.onrender.com`
- Backend repository: `https://github.com/RomanIgor/kalenderai-backend`
- AI provider: Groq

The frontend sends text, photo, or audio requests to this backend. The backend keeps the Groq API key private, forwards requests to Groq, counts daily API requests, and sends optional Telegram/email alerts.

## Groq Model Selection

The configured model variables are ordered preferences, not hard pins. The resolver checks the models available to the configured Groq account. For text and photo, it tries preferred models in order, skips stale or incompatible preferences automatically, and then considers other accessible Groq chat models that satisfy the capability. For transcription, it verifies the configured preference against the Groq catalog.

Default preferences in code:

```env
GROQ_TEXT_MODELS=openai/gpt-oss-120b
GROQ_PHOTO_MODELS=qwen/qwen3.8-27b
GROQ_TRANSCRIBE_MODEL=whisper-large-v3
```

`GROQ_TEXT_MODELS` and `GROQ_PHOTO_MODELS` accept comma-separated preferences in priority order. The singular `GROQ_TEXT_MODEL` and `GROQ_PHOTO_MODEL` variables remain supported when their plural equivalent is not set. Existing `GROQ_*_MODEL` and `GROQ_*_MODELS` values do not need to be removed during deployment; unavailable entries are reported in `rejectedPreferences` and skipped when a verified replacement exists.

Resolver tuning defaults:

```env
MODEL_CACHE_TTL_MS=86400000
MODEL_MAX_CANDIDATES=8
```

`MODEL_CACHE_TTL_MS` caches a verified selection for 24 hours. `MODEL_MAX_CANDIDATES` limits each discovery pass to examining eight candidate model ids. Request execution separately stops after attempting eight distinct operation models, but repeated discovery passes during one request can produce more than eight probes overall; this setting is not a global probe or network-call cap. Discovery is limited to the Groq catalog, and the backend does not fall back to another provider. The catalog does not expose a stable free/paid flag, so the deployed Groq account and API key determine which models are accessible; keep billing disabled on that account if the deployment must remain free. The resolver intentionally has no static free-model allowlist. If the configured Groq account has no accessible free vision model, photo analysis and the photo capability health check fail until Groq provides access to a suitable model.

## Render Environment Variables

Required:

```env
GROQ_API_KEY=...
```

Recommended:

```env
GROQ_TEXT_MODELS=openai/gpt-oss-120b
GROQ_PHOTO_MODELS=qwen/qwen3.8-27b
GROQ_TRANSCRIBE_MODEL=whisper-large-v3
MODEL_CACHE_TTL_MS=86400000
MODEL_MAX_CANDIDATES=8
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
- a model transition after a request proves the previous model unusable and succeeds with a verified replacement; deduplicated once per capability/from/to transition per day
- a critical capability failure when `/model-check` or a live request finds no usable Groq model for a required capability; deduplicated once per failed capability per day

Configured email notifications receive the same model transition and critical health alerts. A stale preference by itself is not critical when the resolver verifies a replacement.

Confirmed setup:

- `/test-alert` was tested successfully and Telegram received the message.
- The cron-job.org daily check was created to call `/model-check`.
- `MODEL_CHECK_TOKEN` is a separate secret for `/model-check` and `/test-alert`; it is not the Telegram bot token and not the Telegram chat id.

Setup:

1. Create a bot with Telegram `@BotFather`.
2. Copy the bot token into Render as `TELEGRAM_TOKEN`.
3. Send any message to the bot from your Telegram account.
4. Get your chat id and add it to Render as `TELEGRAM_CHAT_ID`.
5. Redeploy the Render service.

Test alert:

```text
https://kalenderai-backend.onrender.com/test-alert?token=YOUR_TOKEN
```

Use the value from Render `MODEL_CHECK_TOKEN` in place of `YOUR_TOKEN`.

Expected response:

```json
{
  "status": "sent",
  "telegramConfigured": true,
  "emailConfigured": false
}
```

Expected Telegram message:

```text
KalenderAI test alert

Telegram/email alerts are configured correctly.
Date: YYYY-MM-DD
```

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
  "checkedAt": "2026-09-27T08:00:00.000Z",
  "checks": {
    "text": {
      "healthy": true,
      "selectedModel": "openai/gpt-oss-120b",
      "rejectedPreferences": [],
      "checkedAt": "2026-09-27T08:00:00.000Z"
    },
    "photo": {
      "healthy": true,
      "selectedModel": "qwen/qwen3.8-27b",
      "rejectedPreferences": ["qwen/qwen3.6-27b"],
      "checkedAt": "2026-09-27T08:00:00.000Z"
    },
    "transcribe": {
      "healthy": true,
      "selectedModel": "whisper-large-v3",
      "rejectedPreferences": [],
      "checkedAt": "2026-09-27T08:00:00.000Z"
    }
  }
}
```

Each entry in `checks` is a capability object. `/model-check` returns HTTP `200` when every capability has a verified `selectedModel`, even if `rejectedPreferences` contains stale configured values. It returns HTTP `503` only when at least one capability is unhealthy, for example:

```json
{
  "status": "model_unavailable",
  "checkedAt": "2026-09-27T08:00:00.000Z",
  "checks": {
    "photo": {
      "healthy": false,
      "selectedModel": null,
      "rejectedPreferences": ["qwen/qwen3.8-27b"],
      "checkedAt": "2026-09-27T08:00:00.000Z",
      "error": "No usable Groq model is available for photo"
    }
  }
}
```

The actual response always contains `text`, `photo`, and `transcribe` capability objects; the shortened failure example shows only the failing capability.

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

Use the same `MODEL_CHECK_TOKEN` value here. HTTP `200` means every required capability has a verified model. HTTP `503` means at least one capability has no usable Groq model and the backend sends a critical Telegram/email alert.

This check does not send user text, photos, or audio to Groq. It asks Groq for the model list, then verifies text and photo candidates with minimal synthetic chat requests using JSON mode and the production reasoning settings. The photo probe includes an embedded one-pixel test image. Transcription health only checks the configured model against the catalog because the health check does not upload audio.

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
