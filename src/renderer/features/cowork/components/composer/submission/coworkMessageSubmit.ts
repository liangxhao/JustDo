export const submitCoworkMessage = async (
  send: () => Promise<void | boolean>,
  onFailure: (error: unknown) => void | Promise<void>,
): Promise<boolean> => {
  try {
    return (await send()) !== false;
  } catch (error) {
    await onFailure(error);
    return false;
  }
};
