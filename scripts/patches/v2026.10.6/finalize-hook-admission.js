'use strict';

// One native attempt owns this admission. It contains registration references,
// never conversation contents, execution outcomes or a replacement run ledger.
function createFinalizeHookAdmission(registry, execute) {
  let selected;
  let identity;
  const identityKeys = ['runId', 'sessionId', 'sessionKey'];
  const snapshot = context =>
    Object.freeze(
      Object.fromEntries(
        ['agentId', ...identityKeys, 'workspaceDir'].map(key => [key, context?.[key]]),
      ),
    );
  const validIdentity = context =>
    identityKeys.every(key => typeof context[key] === 'string' && context[key].trim().length > 0);
  const assertIdentity = context => {
    if (identity && identityKeys.some(key => context?.[key] !== identity[key])) {
      throw new Error('Finalization admission belongs to a different native run.');
    }
  };
  const admission = {
    lock(context) {
      if (selected) {
        assertIdentity(context);
        return;
      }
      identity = snapshot(context);
      const complete = validIdentity(identity);
      selected = new Map(
        registry.typedHooks
          .map(hook => [hook, hook.handler])
          .filter(([hook]) => {
            if (hook.hookName !== 'before_agent_finalize') return false;
            if (!complete || typeof hook.appliesToAgentRun !== 'function') return true;
            try {
              const result = hook.appliesToAgentRun(identity);
              // A mistaken async selector cannot opt out or leave a rejected promise
              // unobserved. Only a synchronous, explicit false proves exclusion.
              if (result && typeof result.then === 'function')
                Promise.resolve(result).catch(() => {});
              return result !== false;
            } catch {
              return true;
            }
          }),
      );
    },
    get required() {
      return selected
        ? selected.size > 0
        : registry.typedHooks.some(hook => hook.hookName === 'before_agent_finalize');
    },
    runner(original) {
      return {
        ...original,
        hasHooks(name, context) {
          return name === 'before_agent_finalize'
            ? admission.required
            : original.hasHooks(name, context);
        },
        runBeforeAgentFinalize(event, context) {
          assertIdentity(context);
          if (
            identity &&
            identityKeys.some(key => event?.[key] !== undefined && event[key] !== identity[key])
          ) {
            throw new Error('Finalization event belongs to a different native run.');
          }
          return execute(event, context, selected);
        },
      };
    },
  };
  return admission;
}

module.exports = { createFinalizeHookAdmission };
