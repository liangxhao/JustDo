// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';
import { PET_FLOATING_POSITION_KEY, PET_FLOATING_RESET_EVENT } from '@/app/petFloating';

import { PetSettingsPage } from './PetSettingsPage';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('PetSettingsPage', () => {
  test('closes an open motion menu when pet settings become disabled', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, top: 100, left: 100, bottom: 140, right: 256,
      width: 156, height: 40, toJSON: () => ({}),
    });
    const onChange = vi.fn();
    const { rerender } = render(<PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetSpeed' }));
    expect(screen.getByRole('listbox')).not.toBeNull();

    rerender(<PetSettingsPage value={{ ...defaultAppearanceConfig, petEnabled: false }} onChange={onChange} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    rerender(<PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetSpeed' }));
    fireEvent.click(screen.getByRole('option', { name: 'coworkPetSpeedCalm' }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultAppearanceConfig, petSpeed: 'calm' });
  });

  test('disables all other settings when hidden and restores them without resetting preferences', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />,
    );
    expect(screen.getByRole('switch', { name: 'coworkPetShow' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'coworkPetAnimation' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetShow' }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultAppearanceConfig, petEnabled: false });

    const hidden = { ...defaultAppearanceConfig, petEnabled: false, petCatSelection: 'black' as const, petSpeed: 'calm' as const };
    rerender(<PetSettingsPage value={hidden} onChange={onChange} />);
    onChange.mockClear();
    const showPet = screen.getByRole('switch', { name: 'coworkPetShow' });
    expect((showPet as HTMLButtonElement).disabled).toBe(false);
    for (const control of [
      ...screen.getAllByRole('switch').filter(control => control !== showPet),
      ...screen.getAllByRole('radio'),
      ...screen.getAllByRole('combobox'),
      screen.getByRole('button', { name: 'coworkPetResetPosition' }),
    ]) {
      expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(true);
    }
    const resetEvent = vi.fn();
    window.addEventListener(PET_FLOATING_RESET_EVENT, resetEvent);
    window.localStorage.setItem(PET_FLOATING_POSITION_KEY, 'saved-position');
    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetAnimation' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetSpeed' }));
    fireEvent.click(screen.getByRole('button', { name: 'coworkPetResetPosition' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(window.localStorage.getItem(PET_FLOATING_POSITION_KEY)).toBe('saved-position');
    expect(resetEvent).not.toHaveBeenCalled();
    window.removeEventListener(PET_FLOATING_RESET_EVENT, resetEvent);

    fireEvent.click(showPet);
    const visible = { ...hidden, petEnabled: true };
    expect(onChange).toHaveBeenCalledWith(visible);
    rerender(<PetSettingsPage value={visible} onChange={onChange} />);
    expect((screen.getByRole('radio', { name: 'coworkPetBlackCat' }) as HTMLInputElement).checked).toBe(true);
    for (const control of screen.getAllByRole('combobox')) {
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }
    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetAnimation' }));
    expect(onChange).toHaveBeenCalledWith({ ...visible, petAnimationEnabled: false });
  });

  test('updates placement and motion choices without resetting other pet settings', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, top: 100, left: 100, bottom: 140, right: 256,
      width: 156, height: 40, toJSON: () => ({}),
    });
    const onChange = vi.fn();
    const { rerender } = render(<PetSettingsPage value={defaultAppearanceConfig} onChange={onChange} />);

    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetFloating' }));
    expect(onChange).toHaveBeenCalledWith({ ...defaultAppearanceConfig, petFloatingEnabled: true });

    const updated = { ...defaultAppearanceConfig, petFloatingEnabled: true };
    rerender(<PetSettingsPage value={updated} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetVariety' }));
    fireEvent.click(screen.getByRole('option', { name: 'coworkPetVarietyClassic' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petVariety: 'classic' });
    fireEvent.click(screen.getByRole('combobox', { name: 'coworkPetRestAfter' }));
    fireEvent.click(screen.getByRole('option', { name: 'coworkPetRestNever' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petRestAfter: 'never' });
    fireEvent.click(screen.getByRole('switch', { name: 'coworkPetFloating' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petFloatingEnabled: false });
    fireEvent.click(screen.getByRole('radio', { name: 'coworkPetWhiteCat' }));
    expect(onChange).toHaveBeenCalledWith({ ...updated, petCatSelection: 'white' });
  });

  test('shows a single visibility switch first and marks the selected cat', () => {
    const { container } = render(<PetSettingsPage value={defaultAppearanceConfig} onChange={vi.fn()} />);
    expect(container.querySelector('section')?.querySelector('[role="switch"]')).toBe(screen.getByRole('switch', { name: 'coworkPetShow' }));
    expect(screen.queryByRole('switch', { name: 'coworkPetShowHome' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'coworkPetShowChat' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'coworkPetBothCats' }).getAttribute('checked')).not.toBeNull();
    expect(container.querySelectorAll('.pet-choice-thumbnail__sprite')).toHaveLength(3);
    const white = container.querySelector('.pet-choice-thumbnail__sprite--white') as HTMLElement;
    const black = container.querySelector('.pet-choice-thumbnail__sprite--black') as HTMLElement;
    const both = container.querySelector('.pet-choice-thumbnail__sprite--both') as HTMLElement;
    expect(white.style.clipPath).toMatch(/^polygon\(/);
    expect(black.style.clipPath).toMatch(/^polygon\(/);
    expect(both.style.clipPath).toBe('');
    expect(screen.queryByText('coworkPetWhiteCat')).toBeNull();
    expect(screen.queryByText('coworkPetBlackCat')).toBeNull();
    expect(screen.queryByText('coworkPetBothCats')).toBeNull();
  });
});
