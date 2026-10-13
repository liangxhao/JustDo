import { ipcMain } from 'electron';

import { SwarmWorkflowIpc } from '../../../../shared/cowork/swarm-workflow';
import {
  createSwarmWorkflowCoordinator,
  type SwarmWorkflowDependencies,
} from '../../../cowork/swarm-workflow/swarmWorkflowCoordinator';

export function registerSwarmWorkflowHandlers(deps: SwarmWorkflowDependencies): void {
  const coordinator = createSwarmWorkflowCoordinator(deps);
  ipcMain.handle(
    SwarmWorkflowIpc.Prepare,
    (_event, ...args: Parameters<typeof coordinator.prepareSwarmWorkflow>) =>
      coordinator.prepareSwarmWorkflow(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.Batch,
    (_event, ...args: Parameters<typeof coordinator.getSwarmWorkflowBatch>) =>
      coordinator.getSwarmWorkflowBatch(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.RetryBatch,
    (_event, ...args: Parameters<typeof coordinator.retrySwarmWorkflowBatch>) =>
      coordinator.retrySwarmWorkflowBatch(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.List,
    (_event, ...args: Parameters<typeof coordinator.getSwarmWorkflows>) =>
      coordinator.getSwarmWorkflows(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.Detail,
    (_event, ...args: Parameters<typeof coordinator.getSwarmWorkflowDetail>) =>
      coordinator.getSwarmWorkflowDetail(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.Intervene,
    (_event, ...args: Parameters<typeof coordinator.interveneSwarmWorkflow>) =>
      coordinator.interveneSwarmWorkflow(...args),
  );
  ipcMain.handle(
    SwarmWorkflowIpc.Control,
    (_event, ...args: Parameters<typeof coordinator.controlSwarmWorkflow>) =>
      coordinator.controlSwarmWorkflow(...args),
  );
}
