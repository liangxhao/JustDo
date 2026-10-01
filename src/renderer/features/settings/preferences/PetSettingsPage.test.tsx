// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';

import { PetSettingsPage } from './PetSettingsPage';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  test('updates placement and motion choices without resetting other pet settings', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, top: 100, left: 100, bottom: 140, right: 256,
      width: 156, height: 40, toJSON: () => ({}),
    });
    const onChange = vi.fn();
    const { rerender } = render(<PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetShowHome' }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultAppearanceConfig, petShowHome: false });

    const updated = { ...defaultAppearanceConfig, petShowHome: false };
    rerender(<PetSettingsPage value={updated} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetVariety' }));
    fireEvent.click(screen.getByRole('option', { name: 'coworkPetVarietyClassic' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petVariety: 'classic' });
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetRestAfter' }));
    fireEvent.click(screen.getByRole('option', { name: 'coworkPetRestNever' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petRestAfter: 'never' });
    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetFloating' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petFloatingEnabled: true });
    fireEvent.click(screen.getByRole('radio', { name: 'coworkPetWhiteCat' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petCatSelection: 'white' });
  });

  test('shows thumbnail choices first and marks the selected cat', () => {
    const { container } = render(<PetSettingsPage value={defaultAppearanceConfig} onChange={vi.fn()} />);
    expect(container.querySelector('section')?.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'coworkPetBothCats' }).getAttribute('checked')).not.toBeNull();
    expect(container.querySelectorAll('.pet-choice-thumbnail__sprite')).toHaveLength(3);
    expect(screen.queryByText('coworkPetWhiteCat')).toBeNull();
    expect(screen.queryByText('coworkPetBlackCat')).toBeNull();
    expect(screen.queryByText('coworkPetBothCats')).toBeNull();
  });
});
