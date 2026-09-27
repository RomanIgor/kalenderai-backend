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

function createResolver(overrides) {
  return createModelResolver({
    preferences,
    cacheTtlMs: 86400000,
    maxCandidates: 8,
    now: () => 1790000000000,
    ...overrides
  });
}

function createFakeClient({ models, definitiveFailures = [], probeErrors = new Map(), beforeList }) {
  const calls = [];
  const definitiveFailureSet = new Set(definitiveFailures);

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
      if (definitiveFailureSet.has(model)) {
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
