export const OpenClawExtensionId = {
  ASK_USER_QUESTION: 'ask-user-question',
  AUTOMATION_PERMISSION: 'automation-permission',
  BROWSER: 'browser',
  CUA_COMPUTER: 'cua-computer',
  RUNTIME_SERVICES: 'runtime-services',
  WORKBOARD: 'workboard',
  MEMORY_CORE: 'memory-core',
  CODE_MODE_QUICKJS: 'code-mode-quickjs',
  OPENAI: 'openai',
  PLAN_MODE: 'plan-mode',
  AGENT_TEAM: 'agent-team',
  INTERACTIVE_UI: 'interactive-ui',
  SWARM_WORKFLOW: 'swarm-workflow',
  TYPESAFE: 'typesafe',
  EMBEDDED_BROWSER: 'embedded-browser',
  ACPX: 'acpx',
  STT_LOCAL_CLI: 'stt-local-cli',
  WINDOWS_NATIVE_SANDBOX: 'mxc',
} as const;

export const OpenClawToolName = {
  ASK_USER_QUESTION: 'AskUserQuestion',
  PRESENT_PLAN: 'PresentPlan',
  BROWSER: 'browser',
  COMPUTER: 'computer',
} as const;

export const NativeWidgetToolIdentity = {
  directName: 'show_widget',
  dispatcherName: 'tool_call',
  catalogId: 'openclaw:core:show_widget',
  catalogSource: 'openclaw',
} as const;
