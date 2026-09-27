const test = require('node:test');
const assert = require('node:assert/strict');

const { CapabilityUnavailableError, createModelResolver } = require('../lib/model-resolver');

const preferences = {
  text: ['openai/gpt-oss-120b'],
  photo: ['qwen/qwen3.6-27b'],
  transcribe: ['whisper-large-v3']
};

test('discovers a working photo model when the configured preference is absent', async () => {
  const client = createFakeClient({
    models: ['qwen/qwen3.8-27b', 'whisper-large-v3']
  });
  const resolver = createResolver({ client });

  const result = await resolver.resolve('photo');

  assert.deepEqual(result, {
    model: 'qwen/qwen3.8-27b',
    source: 'discovered',
    checkedAt: 1790000000000
  });
  assert.deepEqual(client.calls, [
    ['listModels'],
    ['probeChatModel', 'qwen/qwen3.8-27b', 'photo']
  ]);
});

test('returns a cached model without repeating discovery before its TTL expires', async () => {
  const client = createFakeClient({ models: ['qwen/qwen3.8-27b'] });
  const resolver = createResolver({ client });

  const first = await resolver.resolve('photo');
  const second = await resolver.resolve('photo');

  assert.deepEqual(second, first);
  assert.deepEqual(client.calls, [
    ['listModels'],
    ['probeChatModel', 'qwen/qwen3.8-27b', 'photo']
  ]);
});

test('shares one in-flight discovery between simultaneous callers', async () => {
  let releaseCatalog;
  const catalogReady = new Promise(resolve => { releaseCatalog = resolve; });
  const client = createFakeClient({
    models: ['qwen/qwen3.8-27b'],
    beforeList: () => catalogReady
  });
  const resolver = createResolver({ client });

  const firstPromise = resolver.resolve('photo');
  const secondPromise = resolver.resolve('photo');
  releaseCatalog();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.model, 'qwen/qwen3.8-27b');
  assert.deepEqual(second, first);
  assert.deepEqual(client.calls, [
    ['listModels'],
    ['probeChatModel', 'qwen/qwen3.8-27b', 'photo']
  ]);
});

test('does not share an excluded result between simultaneous callers', async () => {
  let releaseCatalog;
  const catalogReady = new Promise(resolve => { releaseCatalog = resolve; });
  const client = createFakeClient({
    models: ['model-a', 'model-b'],
    beforeList: () => catalogReady
  });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });

  const unrestrictedPromise = resolver.resolve('photo');
  const excludingPromise = resolver.resolve('photo', { exclude: ['model-a'] });
  releaseCatalog();
  const [unrestricted, excluding] = await Promise.all([
    unrestrictedPromise,
    excludingPromise
  ]);

  assert.equal(unrestricted.model, 'model-a');
  assert.equal(excluding.model, 'model-b');
  assert.equal(client.calls.filter(call => call[0] === 'listModels').length, 2);
  assert.deepEqual(probedModels(client), ['model-a', 'model-b']);
});

test('probes present preferences first and remaining catalog IDs lexicographically', async () => {
  const client = createFakeClient({
    models: ['z-model', 'preferred-a', 'a-model', 'preferred-z'],
    definitiveFailures: ['preferred-z', 'preferred-a', 'a-model']
  });
  const resolver = createResolver({
    client,
    preferences: { ...preferences, text: ['preferred-z', 'missing', 'preferred-a'] }
  });

  const result = await resolver.resolve('text');

  assert.equal(result.model, 'z-model');
  assert.deepEqual(probedModels(client), ['preferred-z', 'preferred-a', 'a-model', 'z-model']);
});

test('never probes known non-chat model families for text or photo', async () => {
  const client = createFakeClient({
    models: [
      'WHISPER-large-v3',
      'llama-guard-4',
      'playai-tts',
      'compound-speech',
      'chat-model'
    ]
  });
  const resolver = createResolver({ client, preferences: { text: [], photo: [], transcribe: [] } });

  assert.equal((await resolver.resolve('text')).model, 'chat-model');
  resolver.invalidate('text', 'chat-model');
  assert.equal((await resolver.resolve('photo')).model, 'chat-model');

  assert.deepEqual(probedModels(client), ['chat-model', 'chat-model']);
});

test('does not probe more than maxCandidates', async () => {
  const client = createFakeClient({
    models: ['model-c', 'model-a', 'model-b'],
    definitiveFailures: ['model-a', 'model-b', 'model-c']
  });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] },
    maxCandidates: 2
  });

  await assert.rejects(
    resolver.resolve('photo'),
    error => error instanceof CapabilityUnavailableError
      && error.capability === 'photo'
      && assert.deepEqual(error.rejectedModels, ['model-a', 'model-b']) === undefined
  );
  assert.deepEqual(probedModels(client), ['model-a', 'model-b']);
});

test('selects a configured transcription model from the catalog without probing it', async () => {
  const client = createFakeClient({ models: ['other-model', 'whisper-large-v3'] });
  const resolver = createResolver({ client });

  const result = await resolver.resolve('transcribe');

  assert.deepEqual(result, {
    model: 'whisper-large-v3',
    source: 'preferred',
    checkedAt: 1790000000000
  });
  assert.deepEqual(client.calls, [['listModels']]);
});

test('continues only after definitive model failures', async () => {
  const client = createFakeClient({
    models: ['model-a', 'model-b'],
    definitiveFailures: ['model-a']
  });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });

  assert.equal((await resolver.resolve('text')).model, 'model-b');
  assert.deepEqual(probedModels(client), ['model-a', 'model-b']);
});

test('rethrows a non-definitive probe error without trying another model', async () => {
  const transientError = Object.assign(new Error('temporary outage'), {
    definitiveModelFailure: false
  });
  const client = createFakeClient({
    models: ['model-a', 'model-b'],
    probeErrors: new Map([['model-a', transientError]])
  });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });

  await assert.rejects(resolver.resolve('text'), error => error === transientError);
  assert.deepEqual(probedModels(client), ['model-a']);
});

test('force refresh, exclusion, and invalidation bypass an otherwise usable cache entry', async () => {
  const client = createFakeClient({ models: ['model-a', 'model-b'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });

  assert.equal((await resolver.resolve('photo')).model, 'model-a');
  assert.equal((await resolver.resolve('photo', { forceRefresh: true, exclude: ['model-a'] })).model, 'model-b');
  resolver.invalidate('photo', 'model-b');
  assert.equal((await resolver.resolve('photo', { exclude: ['model-a'] })).model, 'model-b');

  assert.equal(client.calls.filter(call => call[0] === 'listModels').length, 3);
});

test('execute retries a definitive request failure with a second verified model', async () => {
  const client = createFakeClient({ models: ['model-a', 'model-b'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });
  const attempts = [];

  const result = await resolver.execute('photo', async model => {
    attempts.push(model);
    if (model === 'model-a') {
      throw Object.assign(new Error('model retired'), {
        category: 'model_unavailable',
        definitiveModelFailure: true
      });
    }
    return 'replacement response';
  });

  assert.equal(result, 'replacement response');
  assert.deepEqual(attempts, ['model-a', 'model-b']);
  assert.deepEqual(probedModels(client), ['model-a', 'model-b']);
});

test('execute refreshes the selected model cache after a successful request', async () => {
  let currentTime = 1000;
  const client = createFakeClient({ models: ['model-a'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] },
    cacheTtlMs: 100,
    now: () => currentTime
  });

  await resolver.execute('photo', async model => {
    assert.equal(model, 'model-a');
    currentTime = 1050;
    return 'ok';
  });
  currentTime = 1125;

  const cached = await resolver.resolve('photo');

  assert.equal(cached.checkedAt, 1050);
  assert.equal(client.calls.filter(call => call[0] === 'listModels').length, 1);
});

test('execute returns a rate-limit error without invalidating or rediscovering', async () => {
  const rateLimitError = Object.assign(new Error('rate limited'), {
    status: 429,
    category: 'rate_limit',
    definitiveModelFailure: false
  });
  const client = createFakeClient({ models: ['model-a', 'model-b'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });
  const attempts = [];

  await assert.rejects(
    resolver.execute('photo', async model => {
      attempts.push(model);
      throw rateLimitError;
    }),
    error => error === rateLimitError
  );
  assert.equal((await resolver.resolve('photo')).model, 'model-a');
  assert.deepEqual(attempts, ['model-a']);
  assert.equal(client.calls.filter(call => call[0] === 'listModels').length, 1);
  assert.deepEqual(probedModels(client), ['model-a']);
});

test('execute returns a transient server error without invalidating or rediscovering', async () => {
  const serverError = Object.assign(new Error('upstream unavailable'), {
    status: 500,
    category: 'server_error',
    definitiveModelFailure: false
  });
  const client = createFakeClient({ models: ['model-a', 'model-b'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] }
  });
  const attempts = [];

  await assert.rejects(
    resolver.execute('photo', async model => {
      attempts.push(model);
      throw serverError;
    }),
    error => error === serverError
  );
  assert.equal((await resolver.resolve('photo')).model, 'model-a');
  assert.deepEqual(attempts, ['model-a']);
  assert.equal(client.calls.filter(call => call[0] === 'listModels').length, 1);
  assert.deepEqual(probedModels(client), ['model-a']);
});

test('execute attempts each model once and stops at maxCandidates', async () => {
  const client = createFakeClient({ models: ['model-a', 'model-b', 'model-c'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] },
    maxCandidates: 2
  });
  const attempts = [];
  const failures = new Map([
    ['model-a', Object.assign(new Error('model-a retired'), { definitiveModelFailure: true })],
    ['model-b', Object.assign(new Error('model-b retired'), { definitiveModelFailure: true })]
  ]);

  await assert.rejects(
    resolver.execute('photo', async model => {
      attempts.push(model);
      throw failures.get(model);
    }),
    error => error instanceof CapabilityUnavailableError
      && error.capability === 'photo'
      && assert.deepEqual(error.rejectedModels, ['model-a', 'model-b']) === undefined
  );
  assert.deepEqual(attempts, ['model-a', 'model-b']);
  assert.equal(new Set(attempts).size, attempts.length);
});

test('execute notifies a transition only after the replacement request succeeds', async () => {
  const events = [];
  const client = createFakeClient({ models: ['model-a', 'model-b'] });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: [] },
    onTransition: async transition => {
      events.push(['transition', transition]);
    }
  });

  const result = await resolver.execute('photo', async model => {
    events.push(['operation', model]);
    if (model === 'model-a') {
      throw Object.assign(new Error('model retired'), {
        category: 'model_unavailable',
        definitiveModelFailure: true
      });
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(events, [
    ['operation', 'model-a'],
    ['operation', 'model-b'],
    ['transition', {
      capability: 'photo',
      from: 'model-a',
      to: 'model-b',
      reason: 'model_unavailable'
    }]
  ]);
});

test('checkHealth stays healthy when stale preferences are replaced', async () => {
  const client = createFakeClient({
    models: ['chat-model', 'whisper-large-v3']
  });
  const resolver = createResolver({ client });

  const health = await resolver.checkHealth();

  assert.deepEqual(health, {
    ok: true,
    capabilities: {
      text: {
        healthy: true,
        selectedModel: 'chat-model',
        rejectedPreferences: ['openai/gpt-oss-120b'],
        checkedAt: '2026-09-21T14:13:20.000Z'
      },
      photo: {
        healthy: true,
        selectedModel: 'chat-model',
        rejectedPreferences: ['qwen/qwen3.6-27b'],
        checkedAt: '2026-09-21T14:13:20.000Z'
      },
      transcribe: {
        healthy: true,
        selectedModel: 'whisper-large-v3',
        rejectedPreferences: [],
        checkedAt: '2026-09-21T14:13:20.000Z'
      }
    }
  });
});

test('checkHealth reports an unavailable photo capability with no selected model', async () => {
  const client = createFakeClient({
    models: ['chat-model', 'whisper-large-v3'],
    definitiveFailureCapabilities: ['photo']
  });
  const resolver = createResolver({ client });

  const health = await resolver.checkHealth();

  assert.equal(health.ok, false);
  assert.deepEqual(health.capabilities.photo, {
    healthy: false,
    selectedModel: null,
    rejectedPreferences: ['qwen/qwen3.6-27b'],
    checkedAt: '2026-09-21T14:13:20.000Z',
    error: 'No usable Groq model is available for photo'
  });
});

test('checkHealth clears a cached model when forced refresh can no longer resolve it', async () => {
  const models = ['model-a', 'whisper-large-v3'];
  const client = createFakeClient({ models });
  const resolver = createResolver({
    client,
    preferences: { text: [], photo: [], transcribe: ['whisper-large-v3'] }
  });

  assert.equal((await resolver.resolve('photo')).model, 'model-a');
  models.splice(0, models.length, 'whisper-large-v3');

  const health = await resolver.checkHealth();
  assert.equal(health.capabilities.photo.healthy, false);
  const listCallsAfterHealth = client.calls.filter(call => call[0] === 'listModels').length;

  await assert.rejects(
    resolver.resolve('photo'),
    error => error instanceof CapabilityUnavailableError && error.capability === 'photo'
  );
  assert.equal(
    client.calls.filter(call => call[0] === 'listModels').length,
    listCallsAfterHealth + 1
  );
});

function createResolver(overrides) {
  return createModelResolver({
    preferences,
    cacheTtlMs: 86400000,
    maxCandidates: 8,
    now: () => 1790000000000,
    ...overrides
  });
}

function createFakeClient({
  models,
  definitiveFailures = [],
  definitiveFailureCapabilities = [],
  probeErrors = new Map(),
  beforeList
}) {
  const calls = [];
  const definitiveFailureSet = new Set(definitiveFailures);
  const definitiveFailureCapabilitySet = new Set(definitiveFailureCapabilities);

  return {
    calls,
    async listModels() {
      calls.push(['listModels']);
      if (beforeList) await beforeList();
      return models;
    },
    async probeChatModel(model, capability) {
      calls.push(['probeChatModel', model, capability]);
      if (probeErrors.has(model)) throw probeErrors.get(model);
      if (definitiveFailureSet.has(model) || definitiveFailureCapabilitySet.has(capability)) {
        throw Object.assign(new Error(`${model} rejected`), { definitiveModelFailure: true });
      }
    }
  };
}

function probedModels(client) {
  return client.calls
    .filter(call => call[0] === 'probeChatModel')
    .map(call => call[1]);
}
