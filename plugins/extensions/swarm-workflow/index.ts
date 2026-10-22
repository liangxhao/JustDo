import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { createWorkflowContext } from './service/context';
import { registerWorkflowGateway } from './service/gateway';
import { registerWorkflowExecutionHooks, registerWorkflowPromptHooks } from './service/hooks';
import { registerWorkflowLifecycle } from './service/lifecycle';
import {
  registerWorkflowResultTools,
  registerWorkflowStartTool,
  registerWorkflowSubmissionTools,
} from './service/tools';

export default {
  id: 'swarm-workflow',
  name: 'Swarm Workflow',
  reload: {
    hotPrefixes: [
      'plugins.entries.swarm-workflow.config.globalConcurrency',
      'plugins.entries.swarm-workflow.config.maxBatchItems',
      'plugins.entries.swarm-workflow.config.executionTimeoutSeconds',
      'plugins.entries.swarm-workflow.config.maxAttempts',
      'plugins.entries.swarm-workflow.config.snapshotBudgetMiB',
    ],
  },
  register(api: OpenClawPluginApi) {
    const context = createWorkflowContext(api);
    registerWorkflowLifecycle(context);
    registerWorkflowExecutionHooks(context);
    registerWorkflowSubmissionTools(context);
    registerWorkflowPromptHooks(context);
    registerWorkflowGateway(context);
    registerWorkflowResultTools(context);
    registerWorkflowStartTool(context);
  },
};
