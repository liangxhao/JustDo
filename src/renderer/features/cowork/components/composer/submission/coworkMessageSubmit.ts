export const submitCoworkMessage = async (
  send: () => Promise<void>,
  onFailure: (error: unknown) => void | Promise<void>,
): Promise<boolean> => {
  try {
    await send();
    return true;
  } catch (error) {
    await onFailure(error);
    return false;
  }
};
