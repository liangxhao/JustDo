import { withAppNative } from '@app-plugin/sdk/native';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';

import { createWorkflowContext } from './service/context';
import { registerWorkflowGateway } from './service/gateway';
import { registerWorkflowExecutionHooks, registerWorkflowPromptHooks } from './service/hooks';
import { registerWorkflowLifecycle } from './service/lifecycle';
import {
  registerWorkflowResultTools,
  registerWorkflowStartTool,
  registerWorkflowSubmissionTools,
} from './service/tools';

const plugin = {
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
export default withAppNative(plugin, dispatchGatewayMethod);
