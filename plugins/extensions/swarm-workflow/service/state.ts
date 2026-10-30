import type { FilesystemAdmission } from '@runtime-services/sdk/filesystem-contract';
import type { FlowStore } from '../data/store';
import type { FlowEngine } from '../execution/engine';
import type { FlowNotifier } from '../management/notifications';
import type { createResultBudgetTracker, ResultBudgetAttempt } from './result-budget';

type SubmissionCall = {
  runId: string;
  expiresAt: number;
  signal?: AbortSignal;
  budgetAttempt?: ResultBudgetAttempt;
};
export type StartAdmission = {
  parentKey: string;
  parentId: string;
  requestId: string;
  goal: string;
  mode: string;
  concurrency?: number;
  generation: number;
  expiresAt: number;
  assertCurrent: () => void;
  filesystem?: FilesystemAdmission;
};
type StartTurn = {
  requestId: string;
  mode: string;
  parentId: string;
  cwd: string;
  permissionMode: string;
  policy: string;
  generation: number;
  expiresAt: number;
};
type SharedService = {
  store?: FlowStore;
  engine?: FlowEngine;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  notifier?: FlowNotifier;
  pendingNotice?: Promise<void>;
  generation: number;
  submissionCalls: Map<string, SubmissionCall>;
  managementCalls: Map<string, SubmissionCall>;
  startAdmissions: Map<string, StartAdmission>;
  startTurns: Map<string, StartTurn>;
  resultBudgets?: ReturnType<typeof createResultBudgetTracker>;
};
// Native agent registries register separate tool/hook instances in this process.
// They must all address the service started by the Gateway registry, while each
// invocation still proves its own native session/run authority before writing.
const serviceKey = Symbol.for('swarm-workflow.service');
const processServices = globalThis as typeof globalThis & {
  [key: symbol]: SharedService | undefined;
};
export const state = (processServices[serviceKey] ??= {
  generation: 0,
  submissionCalls: new Map<string, SubmissionCall>(),
  managementCalls: new Map<string, SubmissionCall>(),
  startAdmissions: new Map<string, StartAdmission>(),
  startTurns: new Map<string, StartTurn>(),
});
