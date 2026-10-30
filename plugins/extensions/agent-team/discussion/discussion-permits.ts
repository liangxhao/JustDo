import { FifoPermits } from '@runtime-services/sdk/fifo-permits';

/** Release only after dispatch cleanup AND exact native whole-run terminal evidence. */
export class DiscussionPermits extends FifoPermits {
  constructor(capacity: number, signal: AbortSignal) {
    super(capacity, signal, () => new Error('teamDiscussionCancelled'));
  }
}
