import { describe, expect, test } from 'vitest';

import { PluginActionReason, PluginHubScope } from './management';
import {
  getExtensionManagement,
  getExtensionProvidedManagement,
  getHookManagement,
  getUserMcpManagement,
} from './management';
import { getSkillManagementCapabilities, getSkillScope } from './skillManagement';

describe('skill management projection', () => {
  test.each([
    ['openclaw-bundled', PluginHubScope.SYSTEM],
    ['openclaw-custodian', PluginHubScope.SYSTEM],
    ['openclaw-managed', PluginHubScope.PERSONAL],
    ['openclaw-workshop', PluginHubScope.PERSONAL],
    ['agents-skills-personal', PluginHubScope.PERSONAL],
    ['agents-skills-project', PluginHubScope.PROJECT],
    ['openclaw-workspace', PluginHubScope.PROJECT],
    ['openclaw-extra', PluginHubScope.OTHER],
    ['future-source', PluginHubScope.OTHER],
  ])('maps %s to %s', (source, scope) => {
    expect(getSkillScope(source)).toBe(scope);
  });

  test('allows removing a user-owned managed skill', () => {
    const capabilities = getSkillManagementCapabilities({
      source: 'openclaw-managed',
      bundled: false,
      eligible: true,
      hasPath: true,
    });

    expect(capabilities.remove.allowed).toBe(true);
    expect(capabilities.enable.allowed).toBe(true);
  });

  test('keeps native workshop skills out of imported skill deletion while allowing toggles', () => {
    const capabilities = getSkillManagementCapabilities({
      source: 'openclaw-workshop',
      bundled: false,
      eligible: true,
      hasPath: true,
      filePath: 'C:/state/agents/main/agent/workshop-skills/procedure/SKILL.md',
    });

    expect(capabilities.remove).toEqual({
      allowed: false,
      reason: PluginActionReason.READ_ONLY_SOURCE,
    });
    expect(capabilities.enable.allowed).toBe(true);
    expect(capabilities.disable.allowed).toBe(true);
    expect(capabilities.revealInFolder.allowed).toBe(true);
  });

  test('distinguishes plugin-managed skills from ordinary extra directories', () => {
    const filePath = 'C:/state/plugin-skills/browser-automation/SKILL.md';
    const capabilities = getSkillManagementCapabilities({
      source: 'openclaw-extra',
      bundled: false,
      eligible: true,
      hasPath: true,
      filePath,
    });

    expect(getSkillScope('openclaw-extra', filePath)).toBe(PluginHubScope.EXTENSION);
    expect(capabilities.disable).toEqual({
      allowed: false,
      reason: PluginActionReason.MANAGED_BY_EXTENSION,
    });
    expect(capabilities.remove.reason).toBe(PluginActionReason.MANAGED_BY_EXTENSION);
    expect(getSkillScope('openclaw-extra', 'C:/shared-skills/example/SKILL.md')).toBe(
      PluginHubScope.OTHER,
    );
  });

  test('allows configuration while keeping system removal protected', () => {
    const capabilities = getSkillManagementCapabilities({
      source: 'openclaw-custodian',
      bundled: true,
      eligible: false,
      hasPath: true,
    });

    expect(capabilities.remove).toEqual({
      allowed: false,
      reason: PluginActionReason.MANAGED_BY_SYSTEM,
    });
    expect(capabilities.enable.allowed).toBe(true);
    expect(capabilities.disable.allowed).toBe(true);
  });
});

describe('plugin action capability projections', () => {
  test('does not infer a lock from bundled origin when the extension is toggleable', () => {
    const result = getExtensionManagement({
      origin: 'bundled',
      managed: false,
      canToggle: true,
      removable: false,
    });

    expect(result.scope).toBe(PluginHubScope.SYSTEM);
    expect(result.management.disable.allowed).toBe(true);
    expect(result.management.remove.reason).toBe(PluginActionReason.READ_ONLY_SOURCE);
  });

  test('does not advertise configuration for a product-managed extension', () => {
    const result = getExtensionManagement({
      managed: true,
      canToggle: true,
      removable: true,
      configurationFieldCount: 2,
    });

    expect(result.management.enable.reason).toBe(PluginActionReason.MANAGED_BY_SYSTEM);
    expect(result.management.remove.reason).toBe(PluginActionReason.MANAGED_BY_SYSTEM);
    expect(result.management.configure.reason).toBe(PluginActionReason.MANAGED_BY_SYSTEM);
  });

  test('marks extension-provided capabilities as parent managed', () => {
    const result = getExtensionProvidedManagement({ id: 'calendar', name: 'Calendar' });

    expect(result.scope).toBe(PluginHubScope.EXTENSION);
    expect(result.management.remove).toMatchObject({
      allowed: false,
      reason: PluginActionReason.MANAGED_BY_EXTENSION,
      managedById: 'calendar',
    });
  });

  test('keeps registry-installed MCP servers user manageable', () => {
    const result = getUserMcpManagement();

    expect(result.management.configure.allowed).toBe(true);
    expect(result.management.remove.allowed).toBe(true);
  });

  test('allows disabling an ineligible hook but blocks enabling it', () => {
    const result = getHookManagement({
      source: 'openclaw-managed',
      requirementsSatisfied: false,
      filePath: 'C:/hooks/example/HOOK.md',
    });

    expect(result.management.enable.reason).toBe(PluginActionReason.REQUIREMENTS_MISSING);
    expect(result.management.disable.allowed).toBe(true);
    expect(result.management.remove.allowed).toBe(true);
  });
});
