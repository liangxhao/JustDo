/** Serialized diagnostics and health observations for one ACPX runtime generation. */
import type { AcpRuntimeDoctorReport, AcpxRuntime } from 'acpx/runtime';

type AcpxRuntimeProbeParams = {
  getAgent: () => string;
  createRuntime: (agent: string) => Pick<AcpxRuntime, 'doctor' | 'shutdown'>;
  assertRunning: () => void;
  runWithLease: (
    agent: string,
    run: () => Promise<AcpRuntimeDoctorReport>,
  ) => Promise<AcpRuntimeDoctorReport>;
};

export class AcpxRuntimeProbe {
  private tail: Promise<unknown> = Promise.resolve();
  private health?: { agent: string; ok: boolean };
  private stopping = false;
  private readonly failedCleanupOwners = new Map<
    Pick<AcpxRuntime, 'doctor' | 'shutdown'>,
    unknown
  >();

  constructor(private readonly params: AcpxRuntimeProbeParams) {}

  isHealthy(): boolean {
    return (
      this.health !== undefined && (this.health.agent !== this.params.getAgent() || this.health.ok)
    );
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    return await this.runProbe();
  }

  async doctorAgent(agent: string): Promise<AcpRuntimeDoctorReport> {
    return await this.runProbe(agent);
  }

  private async runProbe(requestedAgent?: string): Promise<AcpRuntimeDoctorReport> {
    const probe = this.tail.then(async () => {
      this.params.assertRunning();
      if (this.stopping) throw new Error('ACP runtime probe is shut down.');
      const agent = requestedAgent ?? this.params.getAgent();
      const runtime = this.params.createRuntime(agent);
      const [result] = await Promise.allSettled([
        Promise.resolve().then(() => this.params.runWithLease(agent, () => runtime.doctor())),
      ]);
      try {
        await runtime.shutdown();
      } catch (error) {
        this.failedCleanupOwners.set(runtime, error);
        throw result.status === 'rejected'
          ? new AggregateError([result.reason, error], 'ACP probe and cleanup failed.')
          : error;
      }
      if (result.status === 'rejected') throw result.reason;
      this.params.assertRunning();
      if (this.stopping) throw new Error('ACP runtime probe is shut down.');
      if (requestedAgent === undefined) this.health = { agent, ok: result.value.ok };
      return result.value;
    });
    this.tail = probe.catch(() => {});
    return await probe;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.health = undefined;
    await this.tail;
    if (this.failedCleanupOwners.size) {
      throw new AggregateError([...this.failedCleanupOwners.values()], 'ACP probe cleanup failed.');
    }
  }
}
