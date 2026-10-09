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

    const clearDefinitivelyStaleCacheOnFailure = promise => {
      if (!forceRefresh) return promise;
      return promise.catch(error => {
        if (error instanceof CapabilityUnavailableError && cache.get(capability) === cached) {
          cache.delete(capability);
        }
        throw error;
      });
    };

    if (inFlight.has(inFlightKey)) {
      return clearDefinitivelyStaleCacheOnFailure(inFlight.get(inFlightKey));
    }

    const discovery = discover(capability, excludedModels, cached)
      .finally(() => inFlight.delete(inFlightKey));
    inFlight.set(inFlightKey, discovery);
    return clearDefinitivelyStaleCacheOnFailure(discovery);
  }

  async function discover(capability, excludedModels, previousEntry) {
    const catalog = await client.listModels();
    const configured = preferences[capability] || [];
    const catalogModels = new Set(catalog);

    if (capability === 'transcribe') {
      const model = configured.find(candidate => (
        catalogModels.has(candidate) && !excludedModels.has(candidate)
      ));
      if (model) {
        const selected = remember(capability, model, 'preferred');
        await notifySelectionChange(capability, previousEntry, selected, catalogModels);
        return selected;
      }
      throw new CapabilityUnavailableError(capability, []);
    }

    const candidates = orderChatCandidates(
      configured,
      previousEntry && previousEntry.model,
      catalog,
      excludedModels
    )
      .slice(0, maxCandidates);
    const rejectedModels = [];
    const rejectionReasons = new Map();

    for (const model of candidates) {
      try {
        await client.probeChatModel(model, capability);
        const source = configured.includes(model) ? 'preferred' : 'discovered';
        const selected = remember(capability, model, source);
        await notifySelectionChange(
          capability,
          previousEntry,
          selected,
          catalogModels,
          rejectionReasons
        );
        return selected;
      } catch (error) {
        if (error.candidateRejection !== true && error.definitiveModelFailure !== true) throw error;
        rejectedModels.push(model);
        rejectionReasons.set(model, error);
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

    while (attemptedModels.size < maxCandidates) {
      const selected = await resolve(capability, { exclude: [...attemptedModels] });
      attemptedModels.add(selected.model);

      let result;
      try {
        result = await operation(selected.model);
      } catch (error) {
        if (error.definitiveModelFailure !== true) throw error;
        invalidate(capability, selected.model);
        if (!pendingTransition) pendingTransition = { from: selected.model, error };
        continue;
      }

      remember(capability, selected.model, selected.source);
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

    throw new CapabilityUnavailableError(capability, [...attemptedModels]);
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

  async function notifySelectionChange(
    capability,
    previousEntry,
    selected,
    catalogModels,
    rejectionReasons = new Map()
  ) {
    if (!onTransition || !previousEntry || previousEntry.model === selected.model) return;

    const rejection = rejectionReasons.get(previousEntry.model);
    const reason = !catalogModels.has(previousEntry.model)
      ? 'catalog_removed'
      : rejection
        ? transitionReason(rejection)
        : 'selection_refresh';

    await onTransition({
      capability,
      from: previousEntry.model,
      to: selected.model,
      reason
    });
  }

  return { resolve, invalidate, execute, checkHealth };
}

function orderChatCandidates(configured, lastSuccessfulModel, catalog, excludedModels) {
  const catalogModels = new Set(catalog);
  const isEligible = model => (
    !excludedModels.has(model) && !NON_CHAT_MODEL_PATTERN.test(model)
  );
  const preferred = configured.filter(model => (
    catalogModels.has(model) && isEligible(model)
  ));
  const preferredModels = new Set(preferred);
  const lastSuccessful = lastSuccessfulModel
    && catalogModels.has(lastSuccessfulModel)
    && isEligible(lastSuccessfulModel)
    && !preferredModels.has(lastSuccessfulModel)
    ? [lastSuccessfulModel]
    : [];
  const prioritizedModels = new Set([...preferred, ...lastSuccessful]);
  const discovered = [...new Set(catalog)]
    .filter(model => isEligible(model) && !prioritizedModels.has(model))
    .sort();

  return [...new Set(preferred), ...lastSuccessful, ...discovered];
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
