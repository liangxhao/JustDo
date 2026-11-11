let frozen = false;
export const isStorageExecutionFrozen = (): boolean => frozen;
export function freezeStorageExecutionAdmission(): () => void {
  if (frozen) throw new Error('Storage maintenance already owns execution admission.');
  frozen = true;
  return () => {
    frozen = false;
  };
}
export function assertStorageExecutionAdmission(): void {
  if (frozen) throw new Error('Execution admission is closed for storage maintenance.');
}
