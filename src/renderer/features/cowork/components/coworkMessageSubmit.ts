export const submitCoworkMessage = async (
  send: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<boolean> => {
  try {
    await send();
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
};
