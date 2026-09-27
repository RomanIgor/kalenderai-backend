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
  now = Date.now,
  onTransition
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

  async function execute(capability, operation) {
    const attemptedModels = new Set();
    let pendingTransition;
    let lastFailure;

    while (attemptedModels.size < maxCandidates) {
      const selected = await resolve(capability, { exclude: [...attemptedModels] });
      attemptedModels.add(selected.model);

      let result;
      try {
        result = await operation(selected.model);
      } catch (error) {
        if (error.definitiveModelFailure !== true) throw error;
        invalidate(capability, selected.model);
        pendingTransition = { from: selected.model, error };
        lastFailure = error;
        continue;
      }

      if (pendingTransition && onTransition) {
        await onTransition({
          capability,
          from: pendingTransition.from,
          to: selected.model,
          reason: transitionReason(pendingTransition.error)
        });
      }
      return result;
    }

    throw lastFailure;
  }

  async function checkHealth() {
    const capabilityNames = ['text', 'photo', 'transcribe'];
    const results = await Promise.all(capabilityNames.map(async capability => {
      try {
        const selected = await resolve(capability, { forceRefresh: true });
        return [capability, {
          healthy: true,
          selectedModel: selected.model,
          rejectedPreferences: rejectedPreferences(capability, selected.model),
          checkedAt: new Date(selected.checkedAt).toISOString()
        }];
      } catch (error) {
        return [capability, {
          healthy: false,
          selectedModel: null,
          rejectedPreferences: [...(preferences[capability] || [])],
          checkedAt: new Date(now()).toISOString(),
          error: normalizeError(error)
        }];
      }
    }));
    const capabilities = Object.fromEntries(results);

    return {
      ok: capabilityNames.every(capability => capabilities[capability].healthy),
      capabilities
    };
  }

  function rejectedPreferences(capability, selectedModel) {
    const configured = preferences[capability] || [];
    const selectedIndex = configured.indexOf(selectedModel);
    return selectedIndex === -1 ? [...configured] : configured.slice(0, selectedIndex);
  }

  return { resolve, invalidate, execute, checkHealth };
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

function transitionReason(error) {
  return error.category || error.code || error.message || String(error);
}

function normalizeError(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = { CapabilityUnavailableError, createModelResolver };
