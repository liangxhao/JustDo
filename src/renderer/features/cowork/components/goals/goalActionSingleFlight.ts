import type React from 'react';

export const runGoalActionSingleFlight = async (
  pendingRef: React.MutableRefObject<boolean>,
  setPending: (pending: boolean) => void,
  action: () => void | Promise<void>,
): Promise<boolean> => {
  if (pendingRef.current) return false;

  pendingRef.current = true;
  setPending(true);
  try {
    await action();
    return true;
  } finally {
    pendingRef.current = false;
    setPending(false);
  }
};
