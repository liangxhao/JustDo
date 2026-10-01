export const PET_FLOATING_POSITION_KEY = 'justdo-pet-floating-position';
export const PET_FLOATING_RESET_EVENT = 'justdo-pet-floating-reset';

export interface PetPosition { x: number; y: number }

export const clampPetPosition = (position: PetPosition, size: number): PetPosition => ({
  x: Math.max(0, Math.min(position.x, window.innerWidth - size)),
  y: Math.max(0, Math.min(position.y, window.innerHeight - size)),
});

export const defaultPetPosition = (size: number): PetPosition => clampPetPosition({
  x: window.innerWidth - size - 24,
  y: window.innerHeight - size - 96,
}, size);

export const readPetPosition = (size: number): PetPosition => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PET_FLOATING_POSITION_KEY) ?? 'null');
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      return clampPetPosition(stored, size);
    }
  } catch {
    // Damaged or unavailable local storage falls back to a visible position.
  }
  return defaultPetPosition(size);
};

export const savePetPosition = (position: PetPosition): void => {
  try {
    window.localStorage.setItem(PET_FLOATING_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Dragging still works when local storage is unavailable.
  }
};
