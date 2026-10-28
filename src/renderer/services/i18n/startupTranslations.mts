import { initializationTranslations } from './initializationTranslations.mts';

export const startupTranslations = {
  zh: {
    startupBootstrap: '正在启动应用…',
    startupActivity_sessionInspect:
      initializationTranslations.zh.initializationActivity_sessionInspect,
    startupActivity_sessionInspectDescription:
      initializationTranslations.zh.initializationActivity_sessionInspectDescription,
    startupActivity_sessionBackup:
      initializationTranslations.zh.initializationActivity_sessionBackup,
    startupActivity_sessionBackupDescription:
      initializationTranslations.zh.initializationActivity_sessionBackupDescription,
    startupActivity_sessionPrepare:
      initializationTranslations.zh.initializationActivity_sessionPrepare,
    startupActivity_sessionPrepareDescription:
      initializationTranslations.zh.initializationActivity_sessionPrepareDescription,
    startupActivity_sessionVerify:
      initializationTranslations.zh.initializationActivity_sessionVerify,
    startupActivity_sessionVerifyDescription:
      initializationTranslations.zh.initializationActivity_sessionVerifyDescription,
    startupOpenLogs: '打开日志文件夹',
    startupOpenLogsFailed: '无法打开日志文件夹，请查看诊断详情。',
    startupStep_interface: '加载工作界面',
    startupDowngradeTitle: '检测到降级安装',
    startupDowngradeWelcome: '确认启动版本',
    startupDowngradeDescription:
      '当前版本低于上次使用的版本，部分数据或设置可能不兼容。建议安装原版本或更新版本。',
    startupDowngradePrevious: '上次使用',
    startupDowngradeInstalled: '当前安装',
    startupDowngradeContinue: '仍然启动',
    startupDowngradeContinuing: '正在继续启动…',
    startupDowngradeContinueFailed: '无法继续启动，请重新启动后重试。',
    startupDowngradeWaiting: '等待确认',
    startupCompatibilityUnknown: '无法确认版本兼容性',
    startupCompatibilityUnknownDescription:
      '无法识别现有数据的版本。数据已保留，请安装兼容的版本。',
    startupCompatibilitySchema: '此版本不支持现有数据格式',
    startupCompatibilitySchemaDescription:
      '数据已保留，请安装支持现有数据格式的版本。',
    startupActivity_nativeInspect:
      initializationTranslations.zh.initializationActivity_nativeInspect,
    startupActivity_nativeInspectDescription:
      initializationTranslations.zh.initializationActivity_nativeInspectDescription,
    startupActivity_nativeBackup: initializationTranslations.zh.initializationActivity_nativeBackup,
    startupActivity_nativeBackupDescription:
      initializationTranslations.zh.initializationActivity_nativeBackupDescription,
    startupActivity_nativeUpgrade:
      initializationTranslations.zh.initializationActivity_nativeUpgrade,
    startupActivity_nativeUpgradeDescription:
      initializationTranslations.zh.initializationActivity_nativeUpgradeDescription,
    startupActivity_nativeVerify: initializationTranslations.zh.initializationActivity_nativeVerify,
    startupActivity_nativeVerifyDescription:
      initializationTranslations.zh.initializationActivity_nativeVerifyDescription,
    startupActivity_historyBackup:
      initializationTranslations.zh.initializationActivity_historyBackup,
    startupActivity_historyBackupDescription:
      initializationTranslations.zh.initializationActivity_historyBackupDescription,
    startupActivity_historyImport:
      initializationTranslations.zh.initializationActivity_historyImport,
    startupActivity_historyImportDescription:
      initializationTranslations.zh.initializationActivity_historyImportDescription,
    startupActivity_historyMetadata:
      initializationTranslations.zh.initializationActivity_historyMetadata,
    startupActivity_historyMetadataDescription:
      initializationTranslations.zh.initializationActivity_historyMetadataDescription,
    startupRenderer_models: '载入可用模型',
    startupRenderer_modelsDescription: '正在读取已保存的模型设置。',
    startupHistoryUnavailable: '此会话的原始正文已缺失。标题已保留，可以继续发送新的消息。',
    startupHistoryWorkspaceUnavailable:
      '原工作目录已不存在。选择一个本机目录后，即可在此会话继续对话。',
    startupHistoryChooseWorkspace: '选择工作目录',
    startupHistoryWorkspaceFailed: '工作目录选择失败，请重试。',
    startupDiagnosticsDetails: '查看诊断详情',
    startupDiagnosticsEvidence:
      '以下是错误信息和发生位置。分享前请检查是否包含个人信息。',
    startupDiagnosticsCopy: '复制诊断',
    startupDiagnosticsCopied: '已复制诊断',
    startupDiagnosticsCopyFailed: '复制失败，请重试',
    startupDiagnosticsView: '查看诊断',
    startupDiagnosticsLoading: '正在打开诊断…',
    startupEngineFailure: 'AI 引擎启动失败',
    startupFailure_main: '应用初始化',
    startupFailure_renderer: '界面加载',
    startupFailure_preload: '应用连接',
    startupFailure_page: '页面加载',

    startupStep_userData: '打开应用数据',
    startupStep_runtime: '检查运行环境',
    startupStep_configuration: '加载启动配置',
    startupStep_engine: '启动 AI 引擎',
    startupStep_integrations: '连接本机服务',
    startupActivity_userDirectory: '访问应用数据目录',
    startupActivity_userDirectoryDescription: '访问本机已保存的应用数据目录。',
    startupActivity_database: '读取应用数据',
    startupActivity_databaseDescription: '读取已保存的应用设置和任务列表。',
    startupActivity_python: '检查内置工具环境',
    startupActivity_pythonDescription: '检查已安装的内置工具组件是否可用。',
    startupActivity_startupSettings: '读取启动配置',
    startupActivity_startupSettingsDescription: '读取已保存的配置，加载本次启动所需的设置。',
    startupActivity_localServices: '连接本机服务',
    startupActivity_localServicesDescription: '建立浏览器扩展与应用之间的本机连接。',
    startupActivity_network: '恢复网络设置',
    startupActivity_networkDescription: '恢复已保存的网络和代理设置。',
    startupActivity_modelAccess: '加载模型访问配置',
    startupActivity_modelAccessDescription: '加载已配置的模型及其连接设置。',
    startupActivity_integrations: '连接集成服务',
    startupActivity_integrationsDescription: '建立本机集成功能所需的连接。',
    startupActivity_workspace: '检查工作目录',
    startupActivity_workspaceDescription: '确认任务文件的默认保存目录可用。',
    startupActivity_defaultFiles: '应用 AI 设置',
    startupActivity_defaultFilesDescription: '应用已保存的模型、助手和工具设置。',
    startupActivity_engineStart: '启动 AI 引擎',
    startupActivity_engineStartDescription:
      '加载已启用的插件，启动 AI 引擎。',
    startupActivity_finalize: '启用应用后台服务',
    startupActivity_finalizeDescription: '恢复系统托盘和应用后台状态，准备打开工作界面。',
    startupSteps: '启动进度',
    startupStepComplete: '已完成',
    startupStepRunning: '进行中',
    startupStepWaiting: '等待',
    startupStepFailed: '失败',
    startupElapsed: '已用时',
    startupActivityElapsed: '本项',
    startupCurrentActivity: '当前操作',
    startupContinue: '就绪后自动进入工作界面',
    startupLongWait: '启动准备耗时较长，完成后将自动继续。',
    startupExtendedWait: '启动需要更多时间，请稍候。',
    startupFailed: '启动未完成',
    startupFailedDescription: '请查看启动失败的原因，处理后重新启动。',
    startupRestart: '重新启动',
    startupHeading: '正在启动',
    startupOpening: '正在加载启动界面',
    startupDocumentDescription: '正在加载启动界面。',
    startupConnecting: '正在获取启动进度',
    startupConnectingDescription: '正在读取当前启动步骤。',
    startupLoadingLabel: '正在加载',
    startupInterfaceLoading: '正在加载工作界面',
    startupPending: '正在完成启动准备',
    startupPendingDescription: '准备完成后将自动打开工作界面。',
    startupModuleFailed: '界面加载失败，请重新加载窗口；若仍无法打开，请查看应用日志。',
    startupReload: '重新加载窗口',
    startupRenderer_interface: '加载工作界面',
    startupRenderer_interfaceDescription: '加载应用页面和内置编辑器资源。',
    startupRenderer_preferences: '读取应用设置',
    startupRenderer_preferencesDescription: '恢复本机保存的界面偏好与模型列表。',
    startupRenderer_appearance: '应用界面主题',
    startupRenderer_appearanceDescription: '恢复你选择的主题、字体和外观。',
    startupRenderer_language: '准备显示语言',
    startupRenderer_languageDescription: '加载语言设置和界面文案。',
    startupRenderer_conversations: '读取最近对话',
    startupRenderer_conversationsDescription: '读取本机对话列表、分组和工作区设置。',
    startupRenderer_engineStatus: '读取 AI 引擎状态',
    startupRenderer_engineStatusDescription: '检查本机 AI 引擎的当前状态，随后打开工作区。',
  },
  en: {
    startupBootstrap: 'Starting application…',
    startupActivity_sessionInspect:
      initializationTranslations.en.initializationActivity_sessionInspect,
    startupActivity_sessionInspectDescription:
      initializationTranslations.en.initializationActivity_sessionInspectDescription,
    startupActivity_sessionBackup:
      initializationTranslations.en.initializationActivity_sessionBackup,
    startupActivity_sessionBackupDescription:
      initializationTranslations.en.initializationActivity_sessionBackupDescription,
    startupActivity_sessionPrepare:
      initializationTranslations.en.initializationActivity_sessionPrepare,
    startupActivity_sessionPrepareDescription:
      initializationTranslations.en.initializationActivity_sessionPrepareDescription,
    startupActivity_sessionVerify:
      initializationTranslations.en.initializationActivity_sessionVerify,
    startupActivity_sessionVerifyDescription:
      initializationTranslations.en.initializationActivity_sessionVerifyDescription,
    startupOpenLogs: 'Open log folder',
    startupOpenLogsFailed: 'Could not open the log folder. View diagnostic details.',
    startupStep_interface: 'Load the workspace interface',
    startupDowngradeTitle: 'An older version is installed',
    startupDowngradeWelcome: 'Confirm the startup version',
    startupDowngradeDescription:
      'This version is older than the one previously used. Some data or settings may be incompatible. We recommend installing that version or a newer one.',
    startupDowngradePrevious: 'Previously used',
    startupDowngradeInstalled: 'Currently installed',
    startupDowngradeContinue: 'Start anyway',
    startupDowngradeContinuing: 'Continuing startup…',
    startupDowngradeContinueFailed:
      'Startup could not continue. Restart the application and try again.',
    startupDowngradeWaiting: 'Waiting for confirmation',
    startupCompatibilityUnknown: 'Version compatibility could not be confirmed',
    startupCompatibilityUnknownDescription:
      'The saved data version could not be identified. Your data are preserved. Install a compatible version.',
    startupCompatibilitySchema: 'This version does not support the existing data format',
    startupCompatibilitySchemaDescription:
      'Your data are preserved. Install a version that supports the existing data format.',
    startupActivity_nativeInspect:
      initializationTranslations.en.initializationActivity_nativeInspect,
    startupActivity_nativeInspectDescription:
      initializationTranslations.en.initializationActivity_nativeInspectDescription,
    startupActivity_nativeBackup: initializationTranslations.en.initializationActivity_nativeBackup,
    startupActivity_nativeBackupDescription:
      initializationTranslations.en.initializationActivity_nativeBackupDescription,
    startupActivity_nativeUpgrade:
      initializationTranslations.en.initializationActivity_nativeUpgrade,
    startupActivity_nativeUpgradeDescription:
      initializationTranslations.en.initializationActivity_nativeUpgradeDescription,
    startupActivity_nativeVerify: initializationTranslations.en.initializationActivity_nativeVerify,
    startupActivity_nativeVerifyDescription:
      initializationTranslations.en.initializationActivity_nativeVerifyDescription,
    startupActivity_historyBackup:
      initializationTranslations.en.initializationActivity_historyBackup,
    startupActivity_historyBackupDescription:
      initializationTranslations.en.initializationActivity_historyBackupDescription,
    startupActivity_historyImport:
      initializationTranslations.en.initializationActivity_historyImport,
    startupActivity_historyImportDescription:
      initializationTranslations.en.initializationActivity_historyImportDescription,
    startupActivity_historyMetadata:
      initializationTranslations.en.initializationActivity_historyMetadata,
    startupActivity_historyMetadataDescription:
      initializationTranslations.en.initializationActivity_historyMetadataDescription,
    startupRenderer_models: 'Loading available models',
    startupRenderer_modelsDescription: 'Reading saved model settings.',
    startupHistoryUnavailable:
      'The original transcript is unavailable. Its title is retained and you can continue with new messages.',
    startupHistoryWorkspaceUnavailable:
      'The original workspace no longer exists. Select a local folder to continue this conversation.',
    startupHistoryChooseWorkspace: 'Choose workspace',
    startupHistoryWorkspaceFailed: 'Could not select a workspace. Please try again.',
    startupDiagnosticsDetails: 'View diagnostic details',
    startupDiagnosticsEvidence:
      'Error details and location are shown below. Check for personal information before sharing.',
    startupDiagnosticsCopy: 'Copy diagnostics',
    startupDiagnosticsCopied: 'Diagnostics copied',
    startupDiagnosticsCopyFailed: 'Copy failed. Try again.',
    startupDiagnosticsView: 'View diagnostics',
    startupDiagnosticsLoading: 'Opening diagnostics…',
    startupEngineFailure: 'AI engine failed to start',
    startupFailure_main: 'Application initialization',
    startupFailure_renderer: 'Interface loading',
    startupFailure_preload: 'Application connection',
    startupFailure_page: 'Page loading',

    startupStep_userData: 'Open application data',
    startupStep_runtime: 'Check runtime',
    startupStep_configuration: 'Load startup settings',
    startupStep_engine: 'Start the AI engine',
    startupStep_integrations: 'Connect local services',
    startupActivity_userDirectory: 'Accessing the data directory',
    startupActivity_userDirectoryDescription: 'Accessing the existing application data directory.',
    startupActivity_database: 'Loading application data',
    startupActivity_databaseDescription:
      'Loading saved application settings and task lists.',
    startupActivity_python: 'Checking bundled tools',
    startupActivity_pythonDescription: 'Checking that installed tool components are available.',
    startupActivity_startupSettings: 'Reading startup settings',
    startupActivity_startupSettingsDescription:
      'Reading saved configuration for this application launch.',
    startupActivity_localServices: 'Connecting local services',
    startupActivity_localServicesDescription:
      'Establishing the local connection between browser extensions and the app.',
    startupActivity_network: 'Restoring network settings',
    startupActivity_networkDescription: 'Restoring saved network and proxy settings.',
    startupActivity_modelAccess: 'Loading model access settings',
    startupActivity_modelAccessDescription:
      'Loading configured models and their connection settings.',
    startupActivity_integrations: 'Connecting integrations',
    startupActivity_integrationsDescription: 'Establishing connections for local integrations.',
    startupActivity_workspace: 'Checking the workspace',
    startupActivity_workspaceDescription:
      'Checking that the default task-file directory is available.',
    startupActivity_defaultFiles: 'Applying AI settings',
    startupActivity_defaultFilesDescription:
      'Applying saved model, assistant, and tool settings.',
    startupActivity_engineStart: 'Starting the AI engine',
    startupActivity_engineStartDescription:
      'Loading enabled plugins and starting the AI engine.',
    startupActivity_finalize: 'Enabling background services',
    startupActivity_finalizeDescription:
      'Restoring the system tray and background services before opening the workspace.',
    startupSteps: 'Startup progress',
    startupStepComplete: 'Done',
    startupStepRunning: 'In progress',
    startupStepWaiting: 'Waiting',
    startupStepFailed: 'Failed',
    startupElapsed: 'Elapsed',
    startupActivityElapsed: 'This step',
    startupCurrentActivity: 'Current operation',
    startupContinue: 'Your workspace will open when ready',
    startupLongWait:
      'Startup preparation is taking longer. It will continue automatically when ready.',
    startupExtendedWait: 'Startup needs more time. Please wait.',
    startupFailed: 'Startup could not finish',
    startupFailedDescription: 'Review the startup error, resolve it, then restart the application.',
    startupRestart: 'Restart application',
    startupHeading: 'Starting up',
    startupOpening: 'Loading the startup screen',
    startupDocumentDescription: 'Loading the startup screen.',
    startupConnecting: 'Reading startup progress',
    startupConnectingDescription:
      'Reading the current startup step.',
    startupLoadingLabel: 'Loading',
    startupInterfaceLoading: 'Loading the workspace interface',
    startupPending: 'Finishing startup preparation',
    startupPendingDescription: 'The workspace will open automatically when ready.',
    startupModuleFailed:
      'The interface could not load. Reload this window; if it still fails, check the application logs.',
    startupReload: 'Reload window',
    startupRenderer_interface: 'Loading the workspace interface',
    startupRenderer_interfaceDescription: 'Loading application pages and bundled editor resources.',
    startupRenderer_preferences: 'Reading application settings',
    startupRenderer_preferencesDescription:
      'Restoring saved interface preferences and model lists.',
    startupRenderer_appearance: 'Applying your appearance',
    startupRenderer_appearanceDescription:
      'Restoring your theme, fonts, and appearance preferences.',
    startupRenderer_language: 'Preparing the display language',
    startupRenderer_languageDescription: 'Loading language preferences and interface text.',
    startupRenderer_conversations: 'Reading recent conversations',
    startupRenderer_conversationsDescription:
      'Reading local conversation lists, groups, and workspace settings.',
    startupRenderer_engineStatus: 'Reading AI engine status',
    startupRenderer_engineStatusDescription:
      'Checking the local AI engine status before opening your workspace.',
  },
};
