const FormData = require('form-data');
const fetch = require('node-fetch');

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
  const code = String(error.code || '').toLowerCase();
  const param = String(error.param || '').toLowerCase();

  if (status === 429) return 'rate_limit';
  if (status === 401) return 'authentication';
  if (status >= 500 || !status) return 'transient';

  const definitiveModelCode = /^model_(?:not_found|decommissioned|deprecated|retired|unavailable|access_denied|not_permitted|permission_blocked_(?:org|project))$/.test(code);
  if (definitiveModelCode) return 'model_unavailable';
  if (status === 403) return 'authentication';

  const namesModelFailure = /model.*(?:decommissioned|deprecated|retired|not found|does not exist|no longer (?:available|supported)|unavailable)|(?:decommissioned|deprecated|retired|not found|does not exist|unavailable).*model|(?:do not|don't) have access to (?:it|the model)/.test(message);
  if (namesModelFailure) return 'model_unavailable';

  const feature = `${param} ${message}`;
  const namesMalformedImageValue = /image(?:_url)?|image url/.test(message)
    && /unsupported|invalid/.test(message)
    && (/\burl[ _-]+(?:scheme|format)\b/.test(message)
      || /(?:image(?:_url)?|image url)[ _-]+value|value(?:[ _-]+for)?[ _-]+(?:image(?:_url)?|image url)/.test(message));
  if ((status === 400 || status === 422) && namesMalformedImageValue) {
    return 'invalid_request';
  }

  const namesProductionFeature = /image(?:_url)?|vision|response[_ .]?format|json(?:[_ ]object| mode)?|reasoning[_ .]?(?:effort|format)/.test(feature);
  const rejectsFeature = /unsupported|not supported|does not support|doesn't support/.test(message)
    || (/^unsupported_(?:parameter|value)$/.test(code) && Boolean(param));
  if ((status === 400 || status === 422) && namesProductionFeature && rejectsFeature) {
    return 'capability_unsupported';
  }

  return 'invalid_request';
}

function createGroqClient({ apiKey, fetchImpl = fetch, apiUrl = API_URL }) {
  async function requestJson(path, options = {}, model) {
    const { responseType = 'json', ...requestOptions } = options;
    const response = await fetchImpl(`${apiUrl}${path}`, {
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
          response_format: { type: 'json_object' },
          reasoning_format: 'hidden',
          reasoning_effort: capability === 'photo' ? 'none' : 'low'
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
