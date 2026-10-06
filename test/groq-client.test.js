const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

test('unsupported image URL values are request-local invalid requests', () => {
  const malformedImageCases = [
    {
      status: 400,
      data: { error: { code: 'invalid_value', message: 'image_url uses an unsupported URL scheme' } }
    },
    {
      status: 400,
      data: { error: { code: 'invalid_value', message: 'image_url has an unsupported URL format' } }
    },
    {
      status: 422,
      data: { error: { code: 'unsupported_value', param: 'image_url', message: 'Unsupported image_url value' } }
    }
  ];

  for (const input of malformedImageCases) {
    const error = new GroqRequestError({ ...input, model: 'vision-model' });

    assert.equal(classifyGroqError(input), 'invalid_request');
    assert.equal(error.category, 'invalid_request');
    assert.equal(error.definitiveModelFailure, false);
  }
});

test('status-wide failures take precedence over model-looking messages', () => {
  const statusCases = [
    [429, 'The model was decommissioned', 'rate_limit'],
    [401, 'The model does not exist', 'authentication'],
    [403, 'The model is unavailable', 'authentication'],
    [503, 'The model was decommissioned', 'transient']
  ];

  for (const [status, message, expected] of statusCases) {
    const input = { status, data: { error: { message } } };
    const error = new GroqRequestError({ ...input, model: 'test-model' });

    assert.equal(classifyGroqError(input), expected);
    assert.equal(error.category, expected);
    assert.equal(error.definitiveModelFailure, false);
  }
});

test('recognizes definitive model codes and model-specific access messages', () => {
  const modelCases = [
    {
      status: 404,
      data: { error: { code: 'model_not_found', message: 'Requested resource was not found' } }
    },
    {
      status: 400,
      data: { error: { code: 'model_decommissioned', message: 'This identifier is retired' } }
    },
    {
      status: 404,
      data: { error: { message: 'The model `old-model` does not exist or you do not have access to it.' } }
    },
    {
      status: 403,
      data: {
        error: {
          code: 'model_permission_blocked_project',
          message: 'The model `restricted-model` is blocked at the project level.'
        }
      }
    }
  ];

  for (const input of modelCases) {
    const error = new GroqRequestError({ ...input, model: 'test-model' });

    assert.equal(classifyGroqError(input), 'model_unavailable');
    assert.equal(error.definitiveModelFailure, true);
  }
});

test('recognizes unsupported production chat features as capability failures', () => {
  const capabilityCases = [
    {
      status: 400,
      data: {
        error: {
          code: 'invalid_value',
          message: 'The model does not support image inputs'
        }
      }
    },
    {
      status: 422,
      data: {
        error: {
          code: 'invalid_value',
          message: 'Vision is not supported by this model'
        }
      }
    },
    {
      status: 400,
      data: {
        error: {
          code: 'unsupported_parameter',
          param: 'reasoning_effort',
          message: 'reasoning_effort is not supported for this model'
        }
      }
    },
    {
      status: 400,
      data: {
        error: {
          code: 'invalid_request_error',
          message: 'response_format json_object is not supported by this model'
        }
      }
    },
    {
      status: 400,
      data: {
        error: {
          code: 'unsupported_value',
          message: 'reasoning_format hidden is not supported with the selected model'
        }
      }
    }
  ];

  for (const input of capabilityCases) {
    const error = new GroqRequestError({ ...input, model: 'test-model' });

    assert.equal(classifyGroqError(input), 'capability_unsupported');
    assert.equal(error.definitiveModelFailure, true);
  }
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
    response_format: { type: 'json_object' },
    reasoning_format: 'hidden',
    reasoning_effort: 'low'
  });
  assert.equal(requests[1].body.model, 'vision-model');
  assert.equal(requests[1].body.messages[0].content[0].text, 'Reply with {"ok":true}.');
  assert.equal(requests[1].body.messages[0].content[1].type, 'image_url');
  assert.match(requests[1].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(requests[1].body.reasoning_format, 'hidden');
  assert.equal(requests[1].body.reasoning_effort, 'none');
});

test('transcribe sends a valid multipart body with the production default transport', async () => {
  let requestDetails;

  await withLoopbackServer(async ({ apiUrl, request }) => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('native fetch must not be the Groq client default');
    };

    try {
      const client = createGroqClient({ apiKey: 'wire-test-key', apiUrl });
      const transcript = await client.transcribe('whisper-test', {
        buffer: Buffer.from('wire-audio'),
        originalname: 'voice.webm',
        mimetype: 'audio/webm'
      });

      assert.equal(transcript, 'wire transcript');
      requestDetails = await request;
    } finally {
      global.fetch = originalFetch;
    }
  });

  assert.equal(requestDetails.url, '/audio/transcriptions');
  assert.equal(requestDetails.headers.authorization, 'Bearer wire-test-key');
  assert.match(requestDetails.headers['content-type'], /^multipart\/form-data; boundary=/);

  const boundary = requestDetails.headers['content-type'].match(/boundary=(?:"([^"]+)"|([^;]+))/)[1]
    || requestDetails.headers['content-type'].match(/boundary=(?:"([^"]+)"|([^;]+))/)[2];
  const body = requestDetails.body.toString('utf8');
  assert.match(body, new RegExp(`--${escapeRegExp(boundary)}`));
  assert.match(body, /name="file"; filename="voice\.webm"/);
  assert.match(body, /Content-Type: audio\/webm/i);
  assert.match(body, /wire-audio/);
  assert.match(body, /name="model"\r\n\r\nwhisper-test/);
  assert.match(body, /name="language"\r\n\r\nde/);
  assert.match(body, /name="response_format"\r\n\r\ntext/);
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

async function withLoopbackServer(run) {
  let resolveRequest;
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      resolveRequest({
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks)
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('wire transcript');
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const { port } = server.address();
    await run({ apiUrl: `http://127.0.0.1:${port}`, request });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
