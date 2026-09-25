/** Admission can start while a runtime snapshot is in flight. Check both sides. */
export async function browserTaskStopped(
  hasPendingSubmission: () => boolean,
  readRuntime: () => Promise<{ known: boolean; running: boolean }>,
): Promise<boolean> {
  if (hasPendingSubmission()) return false;
  const runtime = await readRuntime();
  return runtime.known && !runtime.running && !hasPendingSubmission();
}
