const NON_CHAT_MODEL_PATTERN = /whisper|guard|tts|speech/i;

class CapabilityUnavailableError extends Error {
  constructor(capability, rejectedModels) {
    super(`No usable Groq model is available for ${capability}`);
    this.name = 'CapabilityUnavailableError';
    this.capability = capability;
    this.rejectedModels = rejectedModels;
  }
}

function createModelResolver({
  client,
  preferences = {},
  cacheTtlMs = 86400000,
  maxCandidates = 8,
  now = Date.now
}) {
  const cache = new Map();
  const inFlight = new Map();

  async function resolve(capability, { forceRefresh = false, exclude = [] } = {}) {
    const excludedModels = new Set(exclude);
    const inFlightKey = JSON.stringify([capability, [...excludedModels].sort()]);
    const cached = cache.get(capability);
    if (!forceRefresh
      && cached
      && cached.expiresAt > now()
      && !excludedModels.has(cached.model)) {
      return publicEntry(cached);
    }

    if (inFlight.has(inFlightKey)) return inFlight.get(inFlightKey);

    const discovery = discover(capability, excludedModels)
      .finally(() => inFlight.delete(inFlightKey));
    inFlight.set(inFlightKey, discovery);
    return discovery;
  }

  async function discover(capability, excludedModels) {
    const catalog = await client.listModels();
    const configured = preferences[capability] || [];
    const catalogModels = new Set(catalog);

    if (capability === 'transcribe') {
      const model = configured.find(candidate => (
        catalogModels.has(candidate) && !excludedModels.has(candidate)
      ));
      if (model) return remember(capability, model, 'preferred');
      throw new CapabilityUnavailableError(capability, []);
    }

    const candidates = orderChatCandidates(configured, catalog, excludedModels)
      .slice(0, maxCandidates);
    const rejectedModels = [];

    for (const model of candidates) {
      try {
        await client.probeChatModel(model, capability);
        const source = configured.includes(model) ? 'preferred' : 'discovered';
        return remember(capability, model, source);
      } catch (error) {
        if (!error.definitiveModelFailure) throw error;
        rejectedModels.push(model);
      }
    }

    throw new CapabilityUnavailableError(capability, rejectedModels);
  }

  function remember(capability, model, source) {
    const checkedAt = now();
    const entry = {
      model,
      source,
      checkedAt,
      expiresAt: checkedAt + cacheTtlMs
    };
    cache.set(capability, entry);
    return publicEntry(entry);
  }

  function invalidate(capability, model) {
    const cached = cache.get(capability);
    if (cached && cached.model === model) cache.delete(capability);
  }

  return { resolve, invalidate };
}

function orderChatCandidates(configured, catalog, excludedModels) {
  const catalogModels = new Set(catalog);
  const isEligible = model => (
    !excludedModels.has(model) && !NON_CHAT_MODEL_PATTERN.test(model)
  );
  const preferred = configured.filter(model => (
    catalogModels.has(model) && isEligible(model)
  ));
  const preferredModels = new Set(preferred);
  const discovered = [...new Set(catalog)]
    .filter(model => isEligible(model) && !preferredModels.has(model))
    .sort();

  return [...new Set(preferred), ...discovered];
}

function publicEntry({ model, source, checkedAt }) {
  return { model, source, checkedAt };
}

module.exports = { CapabilityUnavailableError, createModelResolver };
