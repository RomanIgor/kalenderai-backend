const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyGroqError, createGroqClient, GroqRequestError } = require('../lib/groq-client');

const cases = [
  [{ status: 404, data: { error: { message: 'The model was decommissioned' } } }, 'model_unavailable', true],
  [{ status: 400, data: { error: { code: 'invalid_value', message: 'image_url is not supported by this model' } } }, 'capability_unsupported', true],
  [{ status: 429, data: { error: { message: 'Rate limit reached' } } }, 'rate_limit', false],
  [{ status: 401, data: { error: { message: 'Invalid API key' } } }, 'authentication', false],
  [{ status: 500, data: { error: { message: 'Internal error' } } }, 'transient', false]
];

test('classifyGroqError returns definitive categories for Groq responses', () => {
  for (const [input, category, definitiveModelFailure] of cases) {
    assert.equal(classifyGroqError(input), category);
    const error = new GroqRequestError({ ...input, model: 'test-model' });
    assert.equal(error.category, category);
    assert.equal(error.definitiveModelFailure, definitiveModelFailure);
  }
});

test('GroqRequestError exposes response and model details', () => {
  const error = new GroqRequestError({
    status: 400,
    data: { error: { code: 'invalid_value', message: 'image_url is not supported by this model' } },
    model: 'vision-model'
  });

  assert.equal(error.status, 400);
  assert.equal(error.code, 'invalid_value');
  assert.equal(error.model, 'vision-model');
  assert.equal(error.message, 'image_url is not supported by this model');
});

test('generic endpoint 404 is not a definitive model failure', () => {
  const input = { status: 404, data: { error: { message: 'Route not found' } } };
  const error = new GroqRequestError({ ...input, model: 'text-model' });

  assert.equal(classifyGroqError(input), 'invalid_request');
  assert.equal(error.category, 'invalid_request');
  assert.equal(error.definitiveModelFailure, false);
});

test('malformed image input is not a definitive capability failure', () => {
  const input = {
    status: 400,
    data: { error: { code: 'invalid_value', message: 'image_url must contain a valid data URL' } }
  };
  const error = new GroqRequestError({ ...input, model: 'vision-model' });

  assert.equal(classifyGroqError(input), 'invalid_request');
  assert.equal(error.category, 'invalid_request');
  assert.equal(error.definitiveModelFailure, false);
});

test('listModels returns Groq model ids in API order', async () => {
  const client = createGroqClient({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ data: [{ id: 'z' }, { id: 'a' }] })
  });

  assert.deepEqual(await client.listModels(), ['z', 'a']);
});

test('probeChatModel sends minimal JSON probes for text and photo capabilities', async () => {
  const requests = [];
  const client = createGroqClient({ apiKey: 'test-key', fetchImpl: captureJsonRequest(requests) });

  await client.probeChatModel('text-model', 'text');
  await client.probeChatModel('vision-model', 'photo');

  assert.deepEqual(requests[0].body, {
    model: 'text-model',
    messages: [{ role: 'user', content: 'Reply with {"ok":true}.' }],
    max_tokens: 16,
    temperature: 0,
    response_format: { type: 'json_object' }
  });
  assert.equal(requests[1].body.model, 'vision-model');
  assert.equal(requests[1].body.messages[0].content[0].text, 'Reply with {"ok":true}.');
  assert.equal(requests[1].body.messages[0].content[1].type, 'image_url');
  assert.match(requests[1].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('payload errors are converted to GroqRequestError', async () => {
  const client = createGroqClient({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse({ error: { message: 'The model was decommissioned' } })
  });

  await assert.rejects(
    client.probeChatModel('retired-model', 'text'),
    error => error instanceof GroqRequestError
      && error.model === 'retired-model'
      && error.category === 'model_unavailable'
  );
});

test('non-JSON HTTP errors are converted to GroqRequestError', async () => {
  const client = createGroqClient({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    })
  });

  await assert.rejects(
    client.probeChatModel('text-model', 'text'),
    error => error instanceof GroqRequestError
      && error.status === 502
      && error.model === 'text-model'
      && error.category === 'transient'
  );
});

test('chat uses the supplied photo model with no reasoning effort', async () => {
  const requests = [];
  const client = createGroqClient({ apiKey: 'test-key', fetchImpl: captureJsonRequest(requests) });

  await client.chat('vision-model', [{ role: 'user', content: 'photo' }], 'photo');

  assert.equal(requests[0].body.model, 'vision-model');
  assert.equal(requests[0].body.reasoning_effort, 'none');
});

test('chat uses the supplied text model with low reasoning effort', async () => {
  const requests = [];
  const client = createGroqClient({ apiKey: 'test-key', fetchImpl: captureJsonRequest(requests) });

  await client.chat('text-model', [{ role: 'user', content: 'text' }], 'text');

  assert.equal(requests[0].body.model, 'text-model');
  assert.equal(requests[0].body.reasoning_effort, 'low');
});

function captureJsonRequest(requests) {
  return async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ choices: [] });
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}
