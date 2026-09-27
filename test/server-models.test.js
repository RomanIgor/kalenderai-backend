const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../server');

const CHECKED_AT = '2026-09-27T08:00:00.000Z';

test('POST /api/analyze executes the photo capability and returns its chat result', async () => {
  const calls = [];
  const expected = { choices: [{ message: { content: '{"events":[]}' } }] };
  const dependencies = createDependencies({
    groqClient: {
      async chat(model, messages, capability) {
        calls.push(['chat', model, messages, capability]);
        return expected;
      }
    },
    resolver: {
      async execute(capability, operation) {
        calls.push(['execute', capability]);
        return operation('vision-model');
      }
    }
  });

  await withServer(dependencies, async baseUrl => {
    const messages = [{ role: 'user', content: 'inspect photo' }];
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, mode: 'photo' })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.deepEqual(calls, [
      ['execute', 'photo'],
      ['chat', 'vision-model', messages, 'photo']
    ]);
  });
});

test('GET /model-check stays healthy when a stale preference has a working replacement', async () => {
  const capabilities = healthyCapabilities();
  capabilities.photo = {
    healthy: true,
    selectedModel: 'qwen/qwen3.8-27b',
    rejectedPreferences: ['qwen/qwen3.6-27b'],
    checkedAt: CHECKED_AT
  };
  const dependencies = createDependencies({
    resolver: {
      async checkHealth() {
        return { ok: true, capabilities };
      }
    }
  });

  await withServer(dependencies, async baseUrl => {
    const response = await fetch(`${baseUrl}/model-check`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.checks, capabilities);
    assert.deepEqual(dependencies.notifier.alerts, []);
  });
});

test('GET /model-check returns 503 only for an explicitly unhealthy capability', async () => {
  const allHealthy = healthyCapabilities();
  const unhealthy = healthyCapabilities();
  unhealthy.photo = {
    healthy: false,
    selectedModel: null,
    rejectedPreferences: ['qwen/qwen3.8-27b'],
    checkedAt: CHECKED_AT,
    error: 'No usable Groq model is available for photo'
  };
  const healthResults = [
    { ok: false, capabilities: allHealthy },
    { ok: false, capabilities: unhealthy }
  ];
  const dependencies = createDependencies({
    resolver: {
      async checkHealth() {
        return healthResults.shift();
      }
    }
  });

  await withServer(dependencies, async baseUrl => {
    const healthyResponse = await fetch(`${baseUrl}/model-check`);
    const unhealthyResponse = await fetch(`${baseUrl}/model-check`);

    assert.equal(healthyResponse.status, 200);
    assert.equal(unhealthyResponse.status, 503);
    assert.equal((await unhealthyResponse.json()).status, 'model_unavailable');
  });
});

test('GET /model-check sends one critical alert per failed capability per day', async () => {
  const capabilities = healthyCapabilities();
  capabilities.text = unavailableCapability('text', 'openai/gpt-oss-120b');
  capabilities.photo = unavailableCapability('photo', 'qwen/qwen3.8-27b');
  const dependencies = createDependencies({
    resolver: {
      async checkHealth() {
        return { ok: false, capabilities };
      }
    }
  });

  await withServer(dependencies, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/model-check`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/model-check`)).status, 503);
  });

  assert.equal(dependencies.notifier.alerts.length, 2);
  assert.match(dependencies.notifier.alerts[0].message, /no accessible Groq Free model satisfies the text capability/i);
  assert.match(dependencies.notifier.alerts[1].message, /no accessible Groq Free model satisfies the photo capability/i);
  assert.deepEqual(dependencies.counterStore.counter.modelAlerts, {
    'model-critical:text': '2026-09-27',
    'model-critical:photo': '2026-09-27'
  });
});

test('POST /api/analyze sends one daily alert per successful model transition', async () => {
  const priorPreference = process.env.GROQ_PHOTO_MODELS;
  process.env.GROQ_PHOTO_MODELS = 'qwen/qwen3.6-27b';
  const calls = [];
  const groqClient = {
    async listModels() {
      return ['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b'];
    },
    async probeChatModel(model, capability) {
      calls.push(['probe', model, capability]);
    },
    async chat(model) {
      calls.push(['chat', model]);
      if (model === 'qwen/qwen3.6-27b') {
        throw Object.assign(new Error('model retired'), {
          category: 'model_unavailable',
          definitiveModelFailure: true
        });
      }
      return { model };
    }
  };
  const dependencies = createDependencies({ groqClient, resolver: undefined });

  try {
    await withServer(dependencies, async baseUrl => {
      const request = () => fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [], mode: 'photo' })
      });

      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 200);
    });
  } finally {
    restoreEnv('GROQ_PHOTO_MODELS', priorPreference);
  }

  assert.deepEqual(calls.filter(call => call[0] === 'chat'), [
    ['chat', 'qwen/qwen3.6-27b'],
    ['chat', 'qwen/qwen3.8-27b'],
    ['chat', 'qwen/qwen3.8-27b']
  ]);
  assert.equal(dependencies.notifier.alerts.length, 1);
  assert.match(dependencies.notifier.alerts[0].message, /service continued automatically/i);
  assert.equal(
    dependencies.counterStore.counter.modelAlerts['model-transition:photo:qwen/qwen3.6-27b:qwen/qwen3.8-27b'],
    '2026-09-27'
  );
});

test('POST /api/transcribe resolves the transcription model before invoking the client', async () => {
  const calls = [];
  const dependencies = createDependencies({
    groqClient: {
      async transcribe(model, file) {
        calls.push(['transcribe', model, file.originalname, file.mimetype]);
        return 'transcribed text';
      }
    },
    resolver: {
      async resolve(capability) {
        calls.push(['resolve', capability]);
        return { model: 'whisper-current', source: 'preferred', checkedAt: 1 };
      }
    }
  });

  await withServer(dependencies, async baseUrl => {
    const form = new FormData();
    form.append('file', new Blob(['audio']), 'voice.webm');
    const response = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', body: form });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'transcribed text');
    assert.deepEqual(calls, [
      ['resolve', 'transcribe'],
      ['transcribe', 'whisper-current', 'voice.webm', 'application/octet-stream']
    ]);
  });
});

function createDependencies(overrides = {}) {
  const notifier = overrides.notifier || {
    alerts: [],
    async notify(alert) {
      this.alerts.push(alert);
    }
  };
  const counterStore = overrides.counterStore || createMemoryCounterStore();
  const groqClient = {
    async chat() {
      return { choices: [] };
    },
    async transcribe() {
      return '';
    },
    ...overrides.groqClient
  };
  const resolver = overrides.resolver === undefined && Object.hasOwn(overrides, 'resolver')
    ? undefined
    : {
        async execute(capability, operation) {
          return operation(`${capability}-model`);
        },
        async resolve(capability) {
          return { model: `${capability}-model`, source: 'preferred', checkedAt: 1 };
        },
        async checkHealth() {
          return { ok: true, capabilities: healthyCapabilities() };
        },
        ...overrides.resolver
      };

  return { groqClient, resolver, notifier, counterStore };
}

function createMemoryCounterStore() {
  return {
    counter: { date: '2026-09-27', count: 0, alerted: false },
    get() {
      return this.counter;
    },
    save(counter) {
      this.counter = counter;
    }
  };
}

function healthyCapabilities() {
  return {
    text: {
      healthy: true,
      selectedModel: 'text-model',
      rejectedPreferences: [],
      checkedAt: CHECKED_AT
    },
    photo: {
      healthy: true,
      selectedModel: 'photo-model',
      rejectedPreferences: [],
      checkedAt: CHECKED_AT
    },
    transcribe: {
      healthy: true,
      selectedModel: 'whisper-large-v3',
      rejectedPreferences: [],
      checkedAt: CHECKED_AT
    }
  };
}

function unavailableCapability(capability, preference) {
  return {
    healthy: false,
    selectedModel: null,
    rejectedPreferences: [preference],
    checkedAt: CHECKED_AT,
    error: `No usable Groq model is available for ${capability}`
  };
}

async function withServer(dependencies, run) {
  const app = createApp(dependencies);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
