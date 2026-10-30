import type { ExecutionReceiptUpdate } from '@runtime-services/sdk/custody';
import { vi } from 'vitest';

/** Business-test port only. Native owner proof is exercised by SDK conformance tests. */
export function createCustodyClientFixture() {
  const bind = vi.fn<() => Promise<boolean>>();
  const isCurrent = vi.fn<() => boolean>();
  const writeExecutionReceipt = vi.fn<(receipt: ExecutionReceiptUpdate) => void>();
  const reset = () => {
    bind.mockReset().mockResolvedValue(true);
    isCurrent.mockReset().mockReturnValue(true);
    writeExecutionReceipt.mockReset();
  };
  reset();
  return { bind, isCurrent, writeExecutionReceipt, reset };
}

export function createNativeLifecycleFixture() {
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  return {
    signal: controller.signal,
    onDispose(cleanup: () => void) {
      cleanups.add(cleanup);
      return () => { cleanups.delete(cleanup); };
    },
    runInBackgroundContext<T>(callback: () => T): T { return callback(); },
  };
}
