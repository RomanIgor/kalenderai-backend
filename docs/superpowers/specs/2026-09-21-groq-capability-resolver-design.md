# Groq capability resolver design

## Goal

Keep KalenderAI photo, text, and transcription requests working on the Groq Free tier when Groq retires or replaces model IDs, without requiring an immediate code or Render configuration change.

The resolver remains Groq-only. It cannot provide photo analysis when the account has no accessible Groq model with vision capability; that condition must produce a clear service-health failure and one deduplicated alert.

## Current problem

The backend accepts comma-separated fallback lists, but the lists contain static model IDs. The photo list currently has one preview model. The `/model-check` endpoint also treats every unavailable configured fallback as a total failure, even when another candidate can serve the capability. Environment variables on Render can preserve an obsolete ID after application defaults change.

## Architecture

Introduce a resolver responsible for selecting an accessible Groq model for a capability rather than letting request handlers select a hard-coded model ID.

The resolver has three capability classes:

- `text`: chat completion with JSON output;
- `photo`: chat completion with image input and JSON output;
- `transcribe`: audio transcription.

Existing environment model lists become ordered preferences, not the complete set of usable models. A stale preference is skipped when it is absent or fails the relevant capability check. The current known working models remain initial preferences so normal requests do not incur discovery work.

The resolver depends on a small Groq client boundary for listing models and testing or invoking a model. This keeps selection logic deterministic and testable without network access.

## Discovery and selection

The resolver fetches the models visible to the configured Groq API key. This naturally limits discovery to the account in use; no secondary provider or paid API is introduced.

Candidate ordering is:

1. configured preferences that are still present;
2. the last successfully selected model for that capability;
3. other models returned by Groq, in stable order.

Non-chat model families such as Whisper and safety/guard models are excluded from chat discovery. Transcription continues to use its configured preference unless Groq exposes enough metadata to identify alternative transcription models safely. The photo resolver verifies actual image acceptance rather than inferring capability solely from a model name.

The first valid candidate is cached per capability. A successful real request also confirms and refreshes the cached choice.

## Free-tier constraint

The system uses only the existing Groq API key and models accessible to that key. It does not enable billing, purchase capacity, or call another provider. Discovery and probes are minimized to protect free-tier request and token limits:

- no probe occurs on every user request;
- a cached healthy model is used directly;
- discovery occurs on cold start/first use, scheduled health checks, or a definitive model/capability failure;
- probe prompts and the test image are minimal;
- successful results have a bounded cache lifetime.

The API does not provide a general guarantee that every returned model is free forever. Operationally, the deployed key and account remain the authority: candidates that the key cannot invoke are rejected.

## Request flow

For a photo or text request:

1. Resolve the cached model for the capability.
2. Send the user request once with that model.
3. On success, return normally and retain the selection.
4. On a definitive unavailable, retired, access-denied, or unsupported-capability error, invalidate that model.
5. Refresh the catalog, select the next verified candidate, and retry the same user request once per candidate within a strict attempt limit.
6. Do not rotate models for rate limits, timeouts, malformed user input, authentication errors affecting the whole account, or generic server errors.
7. If no candidate works, return a controlled capability-unavailable response.

This bounded retry prevents loops and avoids multiplying requests during general Groq outages.

## Health checks and alerts

`/model-check` reports health by capability, including the selected model and any rejected preferences. A capability is healthy when at least one accessible model has been verified for it. An obsolete preferred ID alone no longer makes the endpoint return `503`.

Alerts are separated into two severities:

- informational: the selected model changed automatically; sent at most once per capability/model transition per day;
- critical: no usable Groq model exists for a required capability; deduplicated daily.

The alert must explain that service continued after an automatic switch, or explicitly identify the capability that cannot be served.

## Cache and restart behavior

Selections are kept in process memory with timestamps. Persistence is not required for correctness: after a Render restart the resolver can discover again. The cache has a bounded lifetime so scheduled checks eventually detect catalog changes. Concurrent requests share one in-flight discovery promise per capability to prevent a probe storm.

## Compatibility and rollout

Existing variables remain supported:

- `GROQ_TEXT_MODELS` / `GROQ_TEXT_MODEL`;
- `GROQ_PHOTO_MODELS` / `GROQ_PHOTO_MODEL`;
- `GROQ_TRANSCRIBE_MODEL`.

They express preferences rather than hard requirements. No immediate Render environment edit is necessary. The frontend API contract remains unchanged.

The legacy direct-Groq HTML page will be updated to the current photo model, but it cannot gain secure dynamic discovery because it stores a user API key client-side. It is not part of the production backend resilience guarantee.

## Testing

Automated tests cover observable resolver behavior with a fake Groq boundary:

- a stale configured photo model is skipped and a verified vision model is selected;
- a cached selection avoids repeated discovery/probes;
- a definitive retirement error invalidates the cached model and retries with a working candidate;
- rate limits and transient failures do not rotate models;
- discovery is bounded and concurrent calls share the same work;
- health is successful when a capability has a working replacement despite a stale preference;
- health fails and a critical alert is generated when no vision candidate works;
- model-change alerts are deduplicated.

Existing syntax and frontend tests continue to run. The backend resolver tests require no Groq credentials and make no external network calls.

## Operational limits

Groq can remove all free vision models, change API semantics, or experience an account-wide outage. A Groq-only architecture cannot mask those events. The resolver guarantees automatic adaptation when at least one compatible model remains accessible through the same key; it guarantees explicit diagnostics otherwise.
