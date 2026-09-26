# Groq Capability Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep KalenderAI working on Groq Free when model IDs change by discovering, verifying, caching, and failing over to models that satisfy each required capability.

**Architecture:** Extract Groq HTTP behavior into `lib/groq-client.js` and place model discovery, capability verification, cache, and bounded failover in `lib/model-resolver.js`. `server.js` composes those units, keeps the public API unchanged, and reports health per capability instead of per obsolete configured ID.

**Tech Stack:** Node.js 20 CommonJS, Express 4, node-fetch 2, built-in `node:test` and `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-21-groq-capability-resolver-design.md`

## Global Constraints

- Use only the existing Groq API key and models accessible to that key; do not introduce billing or another provider.
- Existing model environment variables remain supported as ordered preferences, not hard requirements.
- The frontend endpoints and request/response formats remain unchanged.
- Never rotate models for rate limits, timeouts, malformed input, account-wide authentication errors, or generic server errors.
- Discovery and retries must be bounded, cached, and shared across concurrent callers.
- Tests make no network calls and require no Groq credentials.

## File map

- Create `lib/groq-client.js`: Groq HTTP requests, normalized errors, model listing, chat probes, chat completion, and transcription.
- Create `lib/model-resolver.js`: preference ordering, candidate filtering, capability verification, cache, in-flight discovery sharing, invalidation, bounded execution, and health reporting.
- Create `test/groq-client.test.js`: client payload and error-classification contract.
- Create `test/model-resolver.test.js`: resolver behavior with an in-memory fake client.
- Modify `server.js`: compose the client/resolver, update model-check semantics, and emit transition/critical alerts.
- Modify `package.json`: add `test` and `check` scripts.
- Modify `README.md`: document preference semantics, automatic selection, health response, and operational limit.
- Modify parent repository files `calendar-ai-groq.html`, `README.md`, and `tests/groq-models.test.js`: remove the retired direct-client model reference and guard against recurrence.

---

### Task 1: Groq client boundary and definitive model errors

**Files:**
- Create: `lib/groq-client.js`
- Create: `test/groq-client.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createGroqClient({ apiKey, fetchImpl })` with `listModels()`, `probeChatModel(model, capability)`, `chat(model, messages, capability)`, and `transcribe(model, file)` methods.
- Produces: `GroqRequestError` with `status`, `code`, `category`, `model`, and `definitiveModelFailure` properties.
- Produces: `classifyGroqError({ status, data })` returning one of `model_unavailable`, `capability_unsupported`, `rate_limit`, `authentication`, `invalid_request`, or `transient`.

- [ ] **Step 1: Add the Node test command**

Update `package.json` scripts to:

```json
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js",
  "test": "node --test",
  "check": "node --check server.js && node --check lib/groq-client.js && node --check lib/model-resolver.js"
}
```

- [ ] **Step 2: Write failing error-classification tests**

Create table-driven tests that assert these literal results:

```js
const cases = [
  [{ status: 404, data: { error: { message: 'The model was decommissioned' } } }, 'model_unavailable', true],
  [{ status: 400, data: { error: { code: 'invalid_value', message: 'image_url is not supported by this model' } } }, 'capability_unsupported', true],
  [{ status: 429, data: { error: { message: 'Rate limit reached' } } }, 'rate_limit', false],
  [{ status: 401, data: { error: { message: 'Invalid API key' } } }, 'authentication', false],
  [{ status: 500, data: { error: { message: 'Internal error' } } }, 'transient', false]
];
```

Also test that `listModels()` maps `{ data: [{ id: 'z' }, { id: 'a' }] }` to `['z', 'a']`, and that `chat()` sends the supplied model and uses `reasoning_effort: 'none'` for photo versus `'low'` for text.

- [ ] **Step 3: Run the tests and verify RED**

Run: `npm test -- test/groq-client.test.js`

Expected: FAIL because `../lib/groq-client` does not exist.

- [ ] **Step 4: Implement the minimal Groq client**

Use one private `requestJson(path, options, model)` helper. For non-2xx responses or payloads containing `error`, throw `GroqRequestError`. Build the photo probe with a constant 1x1 transparent PNG data URL and this content shape:

```js
const PHOTO_PROBE_MESSAGES = [{
  role: 'user',
  content: [
    { type: 'text', text: 'Reply with {"ok":true}.' },
    { type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }
  ]
}];
```

Use `max_tokens: 16`, `temperature: 0`, and JSON object mode for probes. Text probes use the same instruction without image content. Preserve the current production chat parameters for real requests.

- [ ] **Step 5: Run focused and syntax tests**

Run: `npm test -- test/groq-client.test.js`

Expected: PASS with no network access.

Run: `node --check lib/groq-client.js`

Expected: exit code 0.

- [ ] **Step 6: Commit the client boundary**

```bash
git add package.json lib/groq-client.js test/groq-client.test.js
git commit -m "feat: add testable Groq client boundary"
```

---

### Task 2: Capability discovery, verification, and shared cache

**Files:**
- Create: `lib/model-resolver.js`
- Create: `test/model-resolver.test.js`

**Interfaces:**
- Consumes: a client with `listModels(): Promise<string[]>` and `probeChatModel(model, capability): Promise<void>`.
- Produces: `createModelResolver({ client, preferences, cacheTtlMs, maxCandidates, now, onTransition })`.
- Produces resolver methods `resolve(capability, options?)`, `invalidate(capability, model)`, `execute(capability, operation)`, and `checkHealth()`.
- `resolve()` returns `{ model, source, checkedAt }`; `checkHealth()` returns `{ ok, capabilities }`.

- [ ] **Step 1: Write the failing stale-preference and cache tests**

Use a fake client that records calls. Cover these observable cases:

```js
const preferences = {
  text: ['openai/gpt-oss-120b'],
  photo: ['qwen/qwen3.6-27b'],
  transcribe: ['whisper-large-v3']
};
```

- Catalog `['qwen/qwen3.8-27b', 'whisper-large-v3']`, with the Qwen probe succeeding, resolves photo to `qwen/qwen3.8-27b` even though the configured preference is absent.
- Calling `resolve('photo')` twice before TTL expiry calls `listModels` and the successful probe exactly once.
- Two simultaneous `resolve('photo')` calls receive the same model and share one discovery promise.
- Candidate order places present configured preferences first, then remaining catalog IDs in lexicographic order.
- IDs containing `whisper`, `guard`, `tts`, or `speech` are never photo/text probe candidates.
- No more than `maxCandidates` are probed.

- [ ] **Step 2: Run resolver tests and verify RED**

Run: `npm test -- test/model-resolver.test.js`

Expected: FAIL because `../lib/model-resolver` does not exist.

- [ ] **Step 3: Implement discovery and cache**

Store per-capability entries shaped as:

```js
{
  model: 'qwen/qwen3.8-27b',
  source: 'discovered',
  checkedAt: 1790000000000,
  expiresAt: 1790086400000
}
```

Use a `Map` for cache and a second `Map` for in-flight discovery promises. `resolve(capability, { forceRefresh = false, exclude = [] } = {})` must:

1. return a non-expired, non-excluded cached entry;
2. reuse an in-flight promise for the same capability;
3. fetch the catalog once;
4. for transcription, accept the first configured model present in the catalog without an audio probe;
5. for text/photo, probe candidates sequentially until one succeeds;
6. skip only errors whose `definitiveModelFailure` is true, and rethrow all other errors;
7. throw `CapabilityUnavailableError(capability, rejectedModels)` after exhausting the bounded list.

- [ ] **Step 4: Run resolver tests and verify GREEN**

Run: `npm test -- test/model-resolver.test.js`

Expected: all discovery, cache, concurrency, ordering, and bound tests PASS.

- [ ] **Step 5: Commit discovery and cache**

```bash
git add lib/model-resolver.js test/model-resolver.test.js
git commit -m "feat: resolve Groq models by capability"
```

---

### Task 3: Bounded request failover and health semantics

**Files:**
- Modify: `lib/model-resolver.js`
- Modify: `test/model-resolver.test.js`

**Interfaces:**
- Consumes: `operation(model): Promise<T>` passed to `execute`.
- Produces: `execute(capability, operation): Promise<T>` with bounded model rotation.
- Produces: `checkHealth(): Promise<{ ok: boolean, capabilities: Record<string, object> }>`.

- [ ] **Step 1: Write failing failover tests**

Add tests proving:

- `execute('photo', operation)` retries with a second verified model when the first operation throws `definitiveModelFailure: true`.
- A 429/rate-limit error is returned immediately; the resolver does not invalidate, rediscover, or call a second model.
- A transient 500 error is returned immediately with the same behavior.
- Each model is attempted at most once and total attempts never exceed `maxCandidates`.
- `onTransition({ capability: 'photo', from: oldId, to: newId, reason })` fires only after the replacement succeeds.
- `checkHealth()` returns `ok: true` when a stale preference is rejected but a replacement is verified.
- `checkHealth()` returns `ok: false` and `selectedModel: null` when no photo candidate accepts images.

- [ ] **Step 2: Run failover tests and verify RED**

Run: `npm test -- test/model-resolver.test.js`

Expected: the new execution and health assertions FAIL because those behaviors are absent.

- [ ] **Step 3: Implement bounded execute and health**

`execute` tracks attempted IDs in a `Set`, passes it to `resolve` as exclusions after invalidation, and only continues for `error.definitiveModelFailure === true`. Transition notification is awaited after successful replacement, so alert errors can be caught inside the callback without failing the user request.

`checkHealth` force-refreshes `text` and `photo`, checks that the configured transcription model is present, and returns each capability as:

```js
{
  healthy: true,
  selectedModel: 'qwen/qwen3.8-27b',
  rejectedPreferences: ['qwen/qwen3.6-27b'],
  checkedAt: '2026-09-26T10:00:00.000Z'
}
```

Failed capabilities include `healthy: false`, `selectedModel: null`, and a normalized `error` string.

- [ ] **Step 4: Run the complete backend unit suite**

Run: `npm test`

Expected: all Groq client and resolver tests PASS.

- [ ] **Step 5: Commit failover behavior**

```bash
git add lib/model-resolver.js test/model-resolver.test.js
git commit -m "feat: fail over retired Groq models automatically"
```

---

### Task 4: Integrate resolver, health route, and deduplicated alerts

**Files:**
- Modify: `server.js:1-210`
- Modify: `server.js:236-265`
- Modify: `server.js:289-328`
- Create: `test/server-models.test.js`

**Interfaces:**
- Consumes: `createGroqClient` and `createModelResolver` from Tasks 1-3.
- Preserves: `POST /api/analyze`, `POST /api/transcribe`, and authenticated `GET /model-check` public contracts.
- Produces: model-check response with capability health and selected model.

- [ ] **Step 1: Make server composition testable and write failing route tests**

Extract `createApp({ groqClient, resolver, notifier, counterStore })` from module startup and export it. Keep `app.listen` behind `if (require.main === module)`.

Using a real Express app on an ephemeral port and fake dependencies, test:

- `/api/analyze` passes `photo` to `resolver.execute` and returns its chat result.
- `/model-check` returns HTTP 200 when all three capabilities are healthy, including a stale rejected preference.
- `/model-check` returns HTTP 503 only when at least one capability has `healthy: false`.
- A critical health alert is sent once per day per failed capability.
- A model transition alert is sent once per day per `capability:from:to` transition.

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test -- test/server-models.test.js`

Expected: FAIL because `server.js` does not export `createApp` or consume a resolver.

- [ ] **Step 3: Wire the production dependencies**

Use these defaults only as preferences:

```js
const preferences = {
  text: parseModelList(process.env.GROQ_TEXT_MODELS || process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b'),
  photo: parseModelList(process.env.GROQ_PHOTO_MODELS || process.env.GROQ_PHOTO_MODEL || 'qwen/qwen3.8-27b'),
  transcribe: [process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3']
};
```

Set `cacheTtlMs` from `MODEL_CACHE_TTL_MS`, defaulting to `86400000`, and `maxCandidates` from `MODEL_MAX_CANDIDATES`, defaulting to `8`. `callGroqChat` becomes one resolver execution whose operation calls `groqClient.chat(model, messages, mode)`. Transcription resolves the model before calling the client.

- [ ] **Step 4: Replace alert semantics**

Persist deduplication keys in the existing daily counter file:

```text
model-transition:photo:qwen/qwen3.6-27b:qwen/qwen3.8-27b
model-critical:photo
```

Transition copy must say service continued automatically. Critical copy must say that no accessible Groq Free model satisfies the capability. Notification transport failures remain logged and never fail the user request.

- [ ] **Step 5: Run route, unit, and syntax checks**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run check`

Expected: exit code 0 for every file.

- [ ] **Step 6: Commit server integration**

```bash
git add server.js test/server-models.test.js
git commit -m "feat: integrate automatic Groq model resolution"
```

---

### Task 5: Documentation, legacy client, and full verification

**Files:**
- Modify: `README.md`
- Modify in parent repository: `calendar-ai-groq.html:673`
- Modify in parent repository: `README.md:58`
- Modify in parent repository: `tests/groq-models.test.js`

**Interfaces:**
- Documents: model variables are preferences and automatic discovery is Groq-only.
- Preserves: legacy direct-client behavior while replacing its retired photo model.

- [ ] **Step 1: Extend the parent regression test and verify RED**

Add `qwen/qwen3.6-27b` to `deprecatedModels` and include backend documentation/source files that belong to the checked checkout when the test is run from the parent repository. Run:

`node tests/groq-models.test.js`

Expected: FAIL on the current retired references.

- [ ] **Step 2: Update active model references**

Change the legacy direct-client photo model and human-facing current-model examples to `qwen/qwen3.8-27b`. Do not describe that fixed legacy page as dynamically resilient.

- [ ] **Step 3: Document resolver operation**

In the backend README, document:

- existing model variables are ordered preferences;
- stale preferences are skipped automatically;
- `MODEL_CACHE_TTL_MS=86400000` and `MODEL_MAX_CANDIDATES=8` defaults;
- `/model-check` is healthy when a verified replacement exists;
- transition versus critical Telegram alerts;
- Groq-only limitation when no accessible free vision model exists.

Replace old sample responses with capability objects containing `healthy`, `selectedModel`, and `rejectedPreferences`.

- [ ] **Step 4: Run all repository checks**

From `C:\KalenderAI_project\backend-repo` run:

```powershell
npm test
npm run check
git diff --check
```

From `C:\KalenderAI_project` run:

```powershell
node tests/groq-models.test.js
node tests/image-utils.test.js
node tests/privacy-link.test.js
git diff --check
```

Expected: every command exits 0, with no network requests and no credentials required.

- [ ] **Step 5: Review production configuration without exposing secrets**

Confirm the deployment documentation does not require removal of existing `GROQ_*_MODEL(S)` values. Confirm no test output, diff, or tracked file contains `GROQ_API_KEY`, Telegram token, or model-check token values.

- [ ] **Step 6: Commit documentation in each repository**

Backend repository:

```bash
git add README.md
git commit -m "docs: explain automatic Groq model selection"
```

Parent repository:

```bash
git add calendar-ai-groq.html README.md tests/groq-models.test.js
git commit -m "fix: update retired Groq vision model"
```

- [ ] **Step 7: Record deployment handoff**

Report the backend and parent commit IDs, the exact passing verification commands, and these deployment actions: push both repositories, let Render redeploy the backend, then call the authenticated `/model-check` once and confirm `photo.healthy` is true with a non-null `selectedModel`.
