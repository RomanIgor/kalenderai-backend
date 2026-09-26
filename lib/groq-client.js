const FormData = require('form-data');

const API_URL = 'https://api.groq.com/openai/v1';
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLk4QAAAABJRU5ErkJggg==';
const PROBE_INSTRUCTION = 'Reply with {"ok":true}.';
const PHOTO_PROBE_MESSAGES = [{
  role: 'user',
  content: [
    { type: 'text', text: PROBE_INSTRUCTION },
    { type: 'image_url', image_url: { url: ONE_PIXEL_PNG } }
  ]
}];

class GroqRequestError extends Error {
  constructor({ status, data, model }) {
    const error = data && data.error ? data.error : {};
    super(error.message || `Groq request failed with status ${status}`);
    this.name = 'GroqRequestError';
    this.status = status;
    this.code = error.code;
    this.category = classifyGroqError({ status, data });
    this.model = model;
    this.definitiveModelFailure = this.category === 'model_unavailable' || this.category === 'capability_unsupported';
  }
}

function classifyGroqError({ status, data }) {
  const error = data && data.error ? data.error : {};
  const message = String(error.message || '').toLowerCase();
  const namesModelFailure = /model.*(?:decommissioned|not found|does not exist|unavailable)|(?:decommissioned|not found|does not exist|unavailable).*model/.test(message);
  const namesImageCapability = /image|image_url|vision/.test(message);
  const rejectsCapabilityForModel = /not supported by (?:this|the) model|(?:this|the) model (?:does not|doesn't) support/.test(message);

  if (namesModelFailure) return 'model_unavailable';
  if (status === 400 && namesImageCapability && rejectsCapabilityForModel) return 'capability_unsupported';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'authentication';
  if (status >= 500 || !status) return 'transient';
  return 'invalid_request';
}

function createGroqClient({ apiKey, fetchImpl = fetch }) {
  async function requestJson(path, options = {}, model) {
    const { responseType = 'json', ...requestOptions } = options;
    const response = await fetchImpl(`${API_URL}${path}`, {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...requestOptions.headers
      }
    });
    let data;
    if (responseType === 'text') {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      try {
        data = await response.json();
      } catch (error) {
        if (!response.ok) throw new GroqRequestError({ status: response.status, data: {}, model });
        throw error;
      }
    }

    if (!response.ok || (data && data.error)) throw new GroqRequestError({ status: response.status, data, model });
    return data;
  }

  return {
    async listModels() {
      const data = await requestJson('/models');
      return (data.data || []).map(model => model.id);
    },

    probeChatModel(model, capability) {
      const messages = capability === 'photo'
        ? PHOTO_PROBE_MESSAGES
        : [{ role: 'user', content: PROBE_INSTRUCTION }];
      return requestJson('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 16,
          temperature: 0,
          response_format: { type: 'json_object' }
        })
      }, model);
    },

    chat(model, messages, capability) {
      return requestJson('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 1500,
          response_format: { type: 'json_object' },
          reasoning_format: 'hidden',
          reasoning_effort: capability === 'photo' ? 'none' : 'low'
        })
      }, model);
    },

    async transcribe(model, file) {
      const formData = new FormData();
      formData.append('file', file.buffer, {
        filename: file.originalname || 'audio.webm',
        contentType: file.mimetype || 'audio/webm'
      });
      formData.append('model', model);
      formData.append('language', 'de');
      formData.append('response_format', 'text');

      return requestJson('/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
        responseType: 'text'
      }, model);
    }
  };
}

module.exports = { createGroqClient, GroqRequestError, classifyGroqError };
