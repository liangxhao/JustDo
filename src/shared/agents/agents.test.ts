import { describe, expect, it } from 'vitest';

import { parseAgentProfile } from './agents';
const profile = {
  name: '研究',
  description: '',
  icon: '',
  model: '',
  enabled: true,
  isDefault: false,
};
describe('agent profile validation', () => {
  it('preserves an empty model as an inherited default', () =>
    expect(parseAgentProfile(profile).model).toBe(''));
  it.each([
    null,
    {},
    { ...profile, name: ' ' },
    { ...profile, id: '../main' },
    { ...profile, enabled: false, isDefault: true },
    { ...profile, model: 'unqualified' },
    { ...profile, name: 'x'.repeat(81) },
  ])('rejects malformed profile %j', input => {
    expect(() => parseAgentProfile(input)).toThrow();
  });
});
