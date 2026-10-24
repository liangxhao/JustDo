import { SHUTDOWN_BUDGET_MS } from '../../../shared/app/shutdownPolicy';

type CleanupTask = () => unknown | Promise<unknown>;
const CleanupSettlement = { Pending: 'pending', Fulfilled: 'fulfilled', Rejected: 'rejected' } as const;
type CleanupPhase = {
  name: string;
  state: typeof CleanupSettlement[keyof typeof CleanupSettlement];
  expired: boolean;
  failure?: unknown;
  task: Promise<void>;
};

/** Start every retirement even when another service rejects or stops responding. */
export async function settleCleanupTasks(tasks: CleanupTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Application resource retirement failed.');
}

/** A deadline permits further shutdown work; it never proves that a resource retired. */
export async function runApplicationCleanup(stages: {
  retireStartup: CleanupTask;
  retireServices: CleanupTask;
  retireGateway: CleanupTask;
  retireRemainingServices: CleanupTask;
  closeStore: CleanupTask;
}): Promise<void> {
  const phases: CleanupPhase[] = [];
  const errors: unknown[] = [];
  const observe = async (name: string, budgetMs: number, task: CleanupTask): Promise<number> => {
    const startedAt = performance.now();
    const phase: CleanupPhase = { name, state: CleanupSettlement.Pending, expired: false, task: Promise.resolve() };
    phases.push(phase);
    phase.task = Promise.resolve().then(task).then(
      () => { phase.state = CleanupSettlement.Fulfilled; },
      error => { phase.state = CleanupSettlement.Rejected; phase.failure = error; },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        phase.task,
        new Promise<void>(resolve => {
          timer = setTimeout(() => { phase.expired = true; resolve(); }, Math.max(0, budgetMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (phase.expired || phase.state !== CleanupSettlement.Fulfilled) {
      const error = new Error('Application ' + name + ' retirement remains unconfirmed.', { cause: phase.failure });
      errors.push(error);
      console.error('[AppCleanup] Resource retirement remains unconfirmed:', name, phase.failure);
    }
    return Math.max(0, performance.now() - startedAt);
  };

  await observe('startup', SHUTDOWN_BUDGET_MS.startupRetirement, stages.retireStartup);
  const serviceTime = await observe('services', SHUTDOWN_BUDGET_MS.otherAppCleanup, stages.retireServices);
  await observe('Gateway', SHUTDOWN_BUDGET_MS.gatewayStop, stages.retireGateway);
  await observe('remaining services', Math.max(0, SHUTDOWN_BUDGET_MS.otherAppCleanup - serviceTime),
    stages.retireRemainingServices);
  if (errors.length) {
    // Retain pending owners. A late settlement cannot erase a deadline failure
    // or enter the only Store-close success branch below.
    throw new AggregateError(errors, 'Application cleanup did not confirm every resource retirement.',
      { cause: { phases } });
  }
  await stages.closeStore();
}
