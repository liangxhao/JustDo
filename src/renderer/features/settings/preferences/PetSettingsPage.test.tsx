// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';

import { PetSettingsPage } from './PetSettingsPage';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(cleanup);

describe('PetSettingsPage', () => {
  test('updates pet visibility and animation independently using the appearance draft', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />,
    );
    expect(screen.getByRole('switch', { name: 'coworkPetShow' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'coworkPetAnimation' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetShow' }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultAppearanceConfig, petEnabled: false });

    const hidden = { ...defaultAppearanceConfig, petEnabled: false };
    rerender(<PetSettingsPage value={hidden} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetAnimation' }));
    expect(onChange).toHaveBeenCalledWith({ ...hidden, petAnimationEnabled: false });
  });
});
