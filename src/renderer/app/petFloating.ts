export const PET_FLOATING_POSITION_KEY = 'justdo-pet-floating-position';
export const PET_FLOATING_RESET_EVENT = 'justdo-pet-floating-reset';

export interface PetPosition { x: number; y: number }

export const clampPetPosition = (position: PetPosition, size: number, viewport: Pick<Window, 'innerWidth' | 'innerHeight'> = window): PetPosition => ({
  x: Math.max(0, Math.min(position.x, viewport.innerWidth - size)),
  y: Math.max(0, Math.min(position.y, viewport.innerHeight - size)),
});

export const defaultPetPosition = (size: number, viewport: Pick<Window, 'innerWidth' | 'innerHeight'> = window): PetPosition => clampPetPosition({
  x: viewport.innerWidth - size - 24,
  y: viewport.innerHeight - size - 96,
}, size, viewport);

export const readPetPosition = (size: number, viewport: Pick<Window, 'innerWidth' | 'innerHeight'> = window): PetPosition => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PET_FLOATING_POSITION_KEY) ?? 'null');
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      return clampPetPosition(stored, size, viewport);
    }
  } catch {
    // Damaged or unavailable local storage falls back to a visible position.
  }
  return defaultPetPosition(size, viewport);
};

export const savePetPosition = (position: PetPosition): void => {
  try {
    window.localStorage.setItem(PET_FLOATING_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Dragging still works when local storage is unavailable.
  }
};
