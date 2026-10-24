import { initializationTranslations } from './initializationTranslations';

export const startupTranslations = {
  zh: {
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
      '当前安装的版本低于此数据上次使用的版本，部分数据或设置可能不兼容。建议使用原版本或较新版本。你也可以选择“仍然启动”，继续正常启动流程；如检查或加载失败，会显示具体错误。',
    startupDowngradePrevious: '上次使用',
    startupDowngradeInstalled: '当前安装',
    startupDowngradeContinue: '仍然启动',
    startupDowngradeContinuing: '正在继续启动…',
    startupDowngradeContinueFailed: '无法继续启动，请重新启动后重试。',
    startupDowngradeWaiting: '等待确认',
    startupCompatibilityUnknown: '无法确认版本兼容性',
    startupCompatibilityUnknownDescription:
      '无法可靠比较此数据的版本与当前安装版本，已停止启动并保留数据。请使用版本信息完整、支持现有数据格式的安装包。',
    startupCompatibilitySchema: '此版本不支持现有数据格式',
    startupCompatibilitySchemaDescription:
      '现有数据库不在此版本声明的支持范围内，已停止启动并保留数据。请使用支持此数据格式的版本；跨版本升级也需要通过目标版本的兼容性检查。',
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
      '以下是实际捕获的错误与发生位置，原因尚未确认。复制分享前请检查路径等信息。',
    startupDiagnosticsCopy: '复制诊断',
    startupDiagnosticsCopied: '已复制诊断',
    startupDiagnosticsCopyFailed: '复制失败，请重试',
    startupDiagnosticsView: '查看诊断',
    startupDiagnosticsLoading: '正在打开诊断…',
    startupEngineFailure: 'AI 引擎启动失败',
    startupFailure_main: '应用初始化',
    startupFailure_renderer: '界面加载',
    startupFailure_preload: '界面桥接',
    startupFailure_page: '页面加载',

    startupStep_userData: '打开应用数据',
    startupStep_runtime: '检查运行环境',
    startupStep_configuration: '加载启动配置',
    startupStep_engine: '启动 AI 引擎',
    startupActivity_userDirectory: '访问应用数据目录',
    startupActivity_userDirectoryDescription: '访问本机已保存的应用数据目录。',
    startupActivity_database: '打开本机数据库',
    startupActivity_databaseDescription: '打开已有数据库，载入保存的应用设置和任务索引。',
    startupActivity_python: '检查内置工具环境',
    startupActivity_pythonDescription: '检查已安装的内置工具组件是否可用。',
    startupActivity_startupSettings: '读取启动配置',
    startupActivity_startupSettingsDescription: '读取已保存的配置，加载本次启动所需的设置。',
    startupActivity_localServices: '连接本机服务',
    startupActivity_localServicesDescription: '建立浏览器扩展与应用之间的本机连接。',
    startupActivity_network: '恢复网络设置',
    startupActivity_networkDescription: '应用已保存的代理设置与本机请求策略。',
    startupActivity_modelAccess: '加载模型访问配置',
    startupActivity_modelAccessDescription: '检查模型访问凭据，同步已配置的模型。',
    startupActivity_integrations: '连接集成服务',
    startupActivity_integrationsDescription: '建立本机集成功能所需的连接。',
    startupActivity_workspace: '检查工作目录',
    startupActivity_workspaceDescription: '确认任务文件的默认保存目录可用。',
    startupActivity_defaultFiles: '同步 AI 运行配置',
    startupActivity_defaultFilesDescription: '将当前模型、助手和工具设置同步到本机 AI 运行配置。',
    startupActivity_engineStart: '发起 AI 引擎启动',
    startupActivity_engineStartDescription:
      '使用已保存的配置加载已启用的插件并启动 AI 引擎，连接结果以引擎反馈为准。',
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
    startupLongWait: '当前操作耗时较长，仍在等待结果。完成后将自动继续。',
    startupExtendedWait: '当前操作已超过 90 秒，尚未收到完成结果。',
    startupFailed: '启动未完成',
    startupFailedDescription: '请查看启动失败的原因，处理后重新启动。',
    startupRestart: '重新启动',
    startupHeading: '正在启动',
    startupOpening: '正在加载启动界面',
    startupDocumentDescription: '加载本机界面资源，随后读取启动进度。',
    startupConnecting: '正在获取启动进度',
    startupConnectingDescription: '连接本机应用，读取当前操作和已完成的步骤。',
    startupLoadingLabel: '正在加载',
    startupInterfaceLoading: '后台准备已完成，正在加载界面',
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
      'This installation is older than the version last used with these data. Some data or settings may be incompatible. We recommend using that version or a newer one. You can also choose “Start anyway” to continue normal startup; any check or loading failure will display its error.',
    startupDowngradePrevious: 'Previously used',
    startupDowngradeInstalled: 'Currently installed',
    startupDowngradeContinue: 'Start anyway',
    startupDowngradeContinuing: 'Continuing startup…',
    startupDowngradeContinueFailed:
      'Startup could not continue. Restart the application and try again.',
    startupDowngradeWaiting: 'Waiting for confirmation',
    startupCompatibilityUnknown: 'Version compatibility could not be confirmed',
    startupCompatibilityUnknownDescription:
      'The saved and installed versions cannot be compared reliably. Startup has stopped and your data have been preserved. Use an installation with complete version information and support for the existing data format.',
    startupCompatibilitySchema: 'This version does not support the existing data format',
    startupCompatibilitySchemaDescription:
      'The existing database is outside this version’s declared support range. Startup has stopped and your data have been preserved. Use a version that supports these data; upgrades that skip releases also require the target version’s compatibility checks.',
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
      'These are the captured error and its location. The root cause is not yet confirmed. Check paths and other details before sharing.',
    startupDiagnosticsCopy: 'Copy diagnostics',
    startupDiagnosticsCopied: 'Diagnostics copied',
    startupDiagnosticsCopyFailed: 'Copy failed. Try again.',
    startupDiagnosticsView: 'View diagnostics',
    startupDiagnosticsLoading: 'Opening diagnostics…',
    startupEngineFailure: 'AI engine failed to start',
    startupFailure_main: 'Application initialization',
    startupFailure_renderer: 'Interface loading',
    startupFailure_preload: 'Interface bridge',
    startupFailure_page: 'Page loading',

    startupStep_userData: 'Open application data',
    startupStep_runtime: 'Check runtime',
    startupStep_configuration: 'Load startup settings',
    startupStep_engine: 'Start the AI engine',
    startupActivity_userDirectory: 'Accessing the data directory',
    startupActivity_userDirectoryDescription: 'Accessing the existing application data directory.',
    startupActivity_database: 'Opening the local database',
    startupActivity_databaseDescription:
      'Opening the existing database and loading saved settings and task indexes.',
    startupActivity_python: 'Checking bundled tools',
    startupActivity_pythonDescription: 'Checking that installed tool components are available.',
    startupActivity_startupSettings: 'Reading startup settings',
    startupActivity_startupSettingsDescription:
      'Reading saved configuration for this application launch.',
    startupActivity_localServices: 'Connecting local services',
    startupActivity_localServicesDescription:
      'Establishing the local connection between browser extensions and the app.',
    startupActivity_network: 'Restoring network settings',
    startupActivity_networkDescription: 'Applying saved proxy settings and local request policies.',
    startupActivity_modelAccess: 'Loading model access settings',
    startupActivity_modelAccessDescription:
      'Checking model credentials and synchronizing configured models.',
    startupActivity_integrations: 'Connecting integrations',
    startupActivity_integrationsDescription: 'Establishing connections for local integrations.',
    startupActivity_workspace: 'Checking the workspace',
    startupActivity_workspaceDescription:
      'Checking that the default task-file directory is available.',
    startupActivity_defaultFiles: 'Synchronizing AI runtime settings',
    startupActivity_defaultFilesDescription:
      'Applying current model, assistant, and tool settings to the local AI runtime.',
    startupActivity_engineStart: 'Requesting AI engine startup',
    startupActivity_engineStartDescription:
      'Loading enabled plugins and starting the AI engine with saved settings; its status confirms the connection result.',
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
      'This operation is taking longer and is still awaiting a result. Startup will continue when it finishes.',
    startupExtendedWait: 'This operation has taken over 90 seconds without a completion result.',
    startupFailed: 'Startup could not finish',
    startupFailedDescription: 'Review the startup error, resolve it, then restart the application.',
    startupRestart: 'Restart application',
    startupHeading: 'Starting up',
    startupOpening: 'Loading the startup screen',
    startupDocumentDescription: 'Loading local interface resources, then reading startup progress.',
    startupConnecting: 'Reading startup progress',
    startupConnectingDescription:
      'Connecting to the app to read the current operation and completed steps.',
    startupLoadingLabel: 'Loading',
    startupInterfaceLoading: 'Background preparation complete; loading the interface',
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
