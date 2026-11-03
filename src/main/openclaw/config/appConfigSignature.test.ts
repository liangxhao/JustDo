import { describe, expect, it } from 'vitest';

import { getOpenClawAppConfigSignature } from './appConfigSignature';

describe('runtime app configuration changes', () => {
  it('does not reapply the runtime when first saving the default Chinese preference', () => {
    const previous = { providers: {} };
    const initialized = { ...previous, language: 'zh', language_initialized: true };

    expect(getOpenClawAppConfigSignature(initialized)).toBe(
      getOpenClawAppConfigSignature(previous),
    );
  });

  it('matches the runtime Chinese fallback for absent or invalid stored languages', () => {
    const chinese = getOpenClawAppConfigSignature({ language: 'zh' });

    for (const language of [undefined, null, '', 'zh-CN', 'fr', true]) {
      expect(getOpenClawAppConfigSignature({ language })).toBe(chinese);
    }
    expect(getOpenClawAppConfigSignature(undefined)).toBe(chinese);
  });

  it('reapplies the runtime for English selection and for switching back to Chinese', () => {
    const initial = getOpenClawAppConfigSignature({});
    const english = getOpenClawAppConfigSignature({ language: 'en' });
    const chinese = getOpenClawAppConfigSignature({ language: 'zh' });

    expect(english).not.toBe(initial);
    expect(chinese).not.toBe(english);
  });

  it('retains provider and speech changes that require runtime synchronization', () => {
    const baseline = getOpenClawAppConfigSignature({});

    expect(getOpenClawAppConfigSignature({ providers: {} })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { outputEnabled: true } })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { inputEnabled: true } })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { recognitionMode: 'online' } })).not.toBe(baseline);
  });

  it('only changes Control UI admission when both developer mode and its switch are enabled', () => {
    const baseline = getOpenClawAppConfigSignature({});

    expect(getOpenClawAppConfigSignature({ developerMode: true })).toBe(baseline);
    expect(getOpenClawAppConfigSignature({ controlUiEnabled: true })).toBe(baseline);
    expect(getOpenClawAppConfigSignature({
      developerMode: true,
      controlUiEnabled: true,
    })).not.toBe(baseline);
  });
});
