// This module is copied beside facts/policy in native-support. The registration
// entry never imports it: only the admitted native attempt can install a hook.
const toolCallRecoveryAgents = new WeakMap();

export function installToolCallValidationRecovery(agent, recover) {
  if (typeof recover !== 'function') return () => {};
  if (toolCallRecoveryAgents.has(agent)) throw new Error('Tool validation recovery is already installed');
  const entry = { active: true, recover };
  toolCallRecoveryAgents.set(agent, entry);
  return () => {
    entry.active = false;
    if (toolCallRecoveryAgents.get(agent) === entry) toolCallRecoveryAgents.delete(agent);
  };
}

export function readToolCallValidationRecovery(agent) {
  const entry = toolCallRecoveryAgents.get(agent);
  return entry && ((...args) => entry.active ? entry.recover(...args) : undefined);
}

/** One run owner shares its counter across native loops/compaction/attempts. */
export function createToolCallValidationRecovery(owner) {
  return async (message, facts) => {
    const observed = owner.observe(message);
    if (!observed.rejected || !owner.isInitialModel(facts.model)) return undefined;
    owner.state.claimed = true;
    const decision = owner.resolve({
      ...observed,
      initialCandidate: true,
      allToolsSettled: facts.executedCount === 0 && facts.committedCount === 0 && facts.batchCount === 0,
      excluded: false,
      attempts: owner.state.attempts,
      aborted: facts.aborted !== false || owner.isAborted(),
    });
    const available = owner.hasBudget();
    owner.onDecision(decision, available);
    if (decision.action !== 'retry' || !available) return undefined;
    owner.assertActive();
    owner.consumeBudget();
    owner.state.attempts += 1;
    await owner.onRetry();
    owner.assertActive();
    return {
      // Native runtime-context updates require prompt-owned retention and are
      // stripped here. A plugin-owned custom message uses native context replay.
      role: 'custom', customType: 'runtime-services.tool-call-validation', display: false,
      content: decision.instruction,
      timestamp: Date.now(),
    };
  };
}

/** Accept only the final, completed native producer receipt before committing it. */
export async function prepareToolCallValidationHandoff(config, message, facts) {
  if (typeof config.toolCallRecovery !== 'function') return undefined;
  const model = { api: config.model?.api, provider: config.model?.provider, id: config.model?.id };
  const feedback = await config.toolCallRecovery(message, { ...facts, model: config.model });
  if (!feedback) return undefined;
  facts.signal?.throwIfAborted();
  const { errorCode: _code, errorMessage: _error, ...continuation } = message;
  return { message: { ...continuation, stopReason: 'stop', endTurn: false }, feedback, model };
}

export function assertToolCallValidationModel(expected, current) {
  if (!['api', 'provider', 'id'].every(key => typeof expected?.[key] === 'string' &&
    expected[key].length > 0 && expected[key] === current?.[key])) {
    throw new Error('Tool-call correction model changed before continuation');
  }
}
