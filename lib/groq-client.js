const FormData = require('form-data');
const fetch = require('node-fetch');

const API_URL = 'https://api.groq.com/openai/v1';
const PROBE_IMAGE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJ6SURBVHhe7ZBBisQwDATz/0/vMgdDKFR2O+uEZDMFurilkvD283I2PryN7wfw4W18P4APb0M/YNu2f1WGJhQ8vQxNKHh6GZpQ8PQyNKEgkd0B3jq6WRMKWHeENyb3akJBVXeCt7EMTSoB33riK+FNVRmamIDvPfkV8JZ2T/VWoUlPwIz5VfCG/R32TjQZCZhXPWfC3dzfy/ZokgjYY32r4c5q7yhvaBILgmNWwl22L+n5oEkq+MDeUf9RuKO3J+7jQyMVNNifzMxA98if9mqSCvZwJp0bQWfiTfs1SQWEczOzFXSlvnRGk1RQwdnZ+QYdM550TpNUYHB+1sHZv84bmqSCHnSkHs6kc3vSeU1SwQh6Ri72jvqN1KFJKkigy3zssb6E1KNJKkihj05mzGdJXZqkghnobF6+rdiX+jRJBbPQW9UKUqcmqeAIdJ+xJ/VqkgqOQv/qHalbk1RwBLrP2JN6NUkFs9Bb1QpSpyapYAY6m5dvK/alPk1SQQp9dDJjPkvq0iQVJNBlPvZYX0Lq0SQVjKBn5GLvqN9IHZqkgh50pB7OpHN70nlNUoHB+VkHZ/86b2iSCio4OzvfoGPGk85pkgoI52ZmK+hKfemMJqlgD2fSuRF0Jt60X5NU0GB/MjMD3SN/2qtJKvjA3lH/Ubijtyfu40MjFkwctQLusn1JzwdNEgF7rG813FntHeUNTUYC5lXPmXA39/eyPZr0BMyYXwVv2N9h70QTE/C9J78C3tLuqd4qNKkEfOuJr4Q3VWVoQkFVd4K3sQxNKGDdEd6Y3KsJBU8vQxMKnl6GJhQ8vQxNKHh6GZ68hO8H8OFtfD+AD2/j9R/wC7kG9rq32PBLAAAAAElFTkSuQmCC';
const PROBE_INSTRUCTION = 'Reply with a valid json object: {"ok":true}.';
const JSON_MODE_INSTRUCTION = { role: 'system', content: 'Return the response as a valid json object.' };
const PHOTO_PROBE_MESSAGES = [{
  role: 'user',
  content: [
    { type: 'text', text: PROBE_INSTRUCTION },
    { type: 'image_url', image_url: { url: PROBE_IMAGE_PNG } }
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
  const namesImageInput = /image(?:_url)?|image url/.test(message);
  const namesMalformedImageTransport = namesImageInput
    && (/(?:unsupported|invalid)[ _-]+url[ _-]+(?:scheme|format)\b/.test(message)
      || /\b(?:invalid|valid) data url\b/.test(message));
  if ((status === 400 || status === 422) && namesMalformedImageTransport) {
    return 'invalid_request';
  }

  const namesExplicitModelCapability = /(?:image(?:_url)?(?:[ _-]+value)?|image inputs?|vision).{0,30}(?:unsupported|not supported).{0,20}\bby (?:this|the|selected) model\b/.test(message)
    || /\b(?:this|the|selected) model\b.{0,30}\b(?:does not support|doesn't support)\b.{0,30}(?:image(?:_url)?|image inputs?|vision)/.test(message)
    || /\b(?:this|the|selected) model\b.{0,20}\b(?:marks|rejects)\b.{0,30}(?:image(?:_url)?(?:[ _-]+value)?|image inputs?|vision).{0,20}\bunsupported\b/.test(message);
  const namesMalformedImageValue = namesImageInput
    && /unsupported|invalid/.test(message)
    && /(?:image(?:_url)?|image url)[ _-]+value|value(?:[ _-]+for)?[ _-]+(?:image(?:_url)?|image url)/.test(message);
  if ((status === 400 || status === 422) && namesMalformedImageValue && !namesExplicitModelCapability) {
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
          messages: [JSON_MODE_INSTRUCTION, ...messages],
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
