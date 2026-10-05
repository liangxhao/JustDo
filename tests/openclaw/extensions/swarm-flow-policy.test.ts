import { expect, it } from 'vitest';
import { assertCrossAgentPolicy, parentPolicy } from '../../../openclaw-extensions/swarm-flow/policy';

it('captures selected model and exact tool restrictions without weakening them', () => {
  const toolOverrides = { webSearch: false, skills: { coding: false }, mcpToolsDeny: { test: ['write'] } };
  expect(JSON.parse(parentPolicy({ modelOverride: 'model', providerOverride: 'provider', toolOverrides })))
    .toEqual({ model: 'provider/model', toolOverrides });
});
it.each(['sandbox', 'execNode', 'execHost', 'cronRunContinuation', 'inheritedToolPolicyVersion', 'inheritedToolAllow', 'inheritedToolDeny'])
  ('refuses unrepresentable %s authority instead of losing its restrictions', key => {
    expect(() => parentPolicy({ [key]: 'restricted' })).toThrow();
  });
it('refuses incomplete model overrides and alternate execution runtimes', () => {
  expect(() => parentPolicy({ modelOverride: 'model' })).toThrow();
  expect(() => parentPolicy({ agentRuntimeOverride: 'other' })).toThrow();
});

it.each([
  ['restricted', 'main', { restricted: { tools: { deny: ['exec'] } }, main: {} }],
  ['main', 'specialist', { main: { tools: { allow: ['read'] } }, specialist: {} }],
  ['main', 'specialist', { main: {}, specialist: { tools: { profile: 'full' } } }],
  ['restricted', 'main', { restricted: { sandbox: { mode: 'all' } }, main: {} }],
  ['main', 'specialist', { main: {}, specialist: { sandbox: { mode: 'off' } } }],
] as const)('refuses %s to %s when agent policy cannot be inherited', (parent, target, entries) => {
  expect(() => assertCrossAgentPolicy({ agents: { entries } }, parent, target))
    .toThrow('cannot safely inherit configured');
});

it('does not assume identical agent policy objects preserve native effective authority', () => {
  const tools = { allow: ['read'] };
  expect(() => assertCrossAgentPolicy({ agents: { entries: { main: { tools }, reviewer: { tools } } } }, 'main', 'reviewer'))
    .toThrow('cannot safely inherit configured');
});

it('allows default main and requested specialist when no agent-scoped policy is present', () => {
  const config = { agents: { entries: { main: {}, specialist: { model: 'provider/model' } } }, tools: { deny: ['message'] } };
  expect(() => assertCrossAgentPolicy(config, 'specialist', 'main')).not.toThrow();
  expect(() => assertCrossAgentPolicy(config, 'main', 'specialist')).not.toThrow();
});

it('retains native same-agent configured restrictions without rejecting the flow', () => {
  expect(() => assertCrossAgentPolicy({ agents: { entries: { main: { tools: { deny: ['exec'] }, sandbox: { mode: 'all' } } } } }, 'main', 'main'))
    .not.toThrow();
});

it('refuses provider-dependent policies and unavailable live config for cross-agent admission', () => {
  expect(() => assertCrossAgentPolicy({ tools: { byProvider: { provider: { deny: ['exec'] } } } }, 'main', 'reviewer'))
    .toThrow('provider-scoped');
  expect(() => assertCrossAgentPolicy(undefined, 'main', 'reviewer')).toThrow('unavailable');
});

it('rechecks current configuration rather than accepting earlier authorization', () => {
  const config = { agents: { entries: { main: {}, reviewer: {} } } };
  expect(() => assertCrossAgentPolicy(config, 'main', 'reviewer')).not.toThrow();
  Object.assign(config.agents.entries.main, { tools: { deny: ['exec'] } });
  expect(() => assertCrossAgentPolicy(config, 'main', 'reviewer')).toThrow('cannot safely inherit');
});
