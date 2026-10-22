export const initializationTranslations = {
  zh: {
    initializationResultTitle: '历史会话已恢复',
    initializationResultDescription:
      '初始化和历史恢复已完成。打开历史会话后，模型和权限沿用当前的新会话默认配置。',
    initializationResultConversations: '已恢复会话',
    initializationResultMissing: '原始正文缺失',
    initializationResultWorkspaces: '需重选目录的会话',
    initializationResultIncomplete:
      '正文缺失的会话会保留标题并单独提示。工作目录不存在不影响迁移；打开会话后可重新选择目录再继续对话。',
    initializationResultBackup: '历史备份已保留在本机',
    initializationResultContinue: '进入应用',
    initializationOpenBackup: '打开备份目录',
    initializationOpenData: '打开数据目录',
    initializationOpenTaskManager: '打开任务管理器',
    initializationSupportFailed: '未能打开，请根据显示的目录或系统入口手动操作。',
    initializationRecovery_space: '磁盘空间不足，历史升级已暂停',
    initializationRecovery_spaceDescription:
      '请先释放应用数据所在磁盘的空间。备份、恢复和数据库临时文件都需要额外空间；处理后点击“重新启动并重试”。历史来源和已保留的备份不会因本次失败而被清空。',
    initializationRecovery_busy: '历史文件正被其他程序占用',
    initializationRecovery_busyDescription:
      '请先退出旧版应用及其后台组件，关闭正在使用历史文件的程序，然后重新启动并重试。',
    initializationRecovery_access: '历史文件被占用，或当前账号无权访问',
    initializationRecovery_accessDescription:
      '请退出使用这些文件的程序，并检查当前账号对数据目录是否有读写权限。若文件仍被占用，处理占用后重新启动并重试。',
    initializationRecovery_changing: '旧版应用仍在写入历史',
    initializationRecovery_changingDescription:
      '请完全退出旧版应用及其后台组件，等待写入停止后重新启动并重试。此次未完成的备份不会被当作成功的备份使用。',
    initializationRecovery_other: '历史升级已暂停，恢复进度已保留',
    initializationRecovery_otherDescription:
      '请先退出旧版应用，检查数据磁盘剩余空间及目录读写权限，再查看下方详细信息中的失败原因。处理后重新启动并重试，无需手动清空数据目录。',
    initializationRecoveryTaskManagerHint:
      '可在任务管理器中手动结束确认属于旧版应用的占用进程。请核对进程名称和位置，避免结束其他程序。',
    initializationUpgradeWelcome: '升级与首次准备',
    initializationUpgradeTitle: '让历史对话继续陪伴你',
    initializationUpgradeDescription:
      '先备份历史，再准备全新环境，最后恢复会话。设置、插件和定时任务将使用新版默认值。',
    initializationBackup: '备份历史',
    initializationHistory: '恢复会话',
    initializationHistoryRecovered: '已恢复会话：',
    initializationHistoryUnavailable: '原历史正文缺失：',
    initializationActivity_historyBackup: '安全保存历史对话',
    initializationActivity_historyBackupDescription:
      '正在备份会话、标题与关联信息，并核验备份。完成前不会替换旧环境。',
    initializationActivity_historyImport: '恢复历史会话',
    initializationActivity_historyImportDescription:
      '正在将历史交给新版会话存储，保留主会话和子任务的关联。大体积历史可能需要几分钟。',
    initializationActivity_historyMetadata: '还原对话标题与关联',
    initializationActivity_historyMetadataDescription:
      '正在恢复对话列表、标题和准确的历史关联，完成后即可继续对话。',
    initializationRenderer_models: '载入可用模型',
    initializationRenderer_modelsDescription: '正在读取当前模型设置，准备工作区。',
    initializationConnecting: '正在获取首次准备进度',
    initializationInterfaceLoading: '本机准备已完成，正在进入首页',
    initializationConnectingDescription: '正在读取本次首次启动的准备状态。',
    firstLaunchFinishing: '正在打开首次使用界面',
    initializationReload: '重新加载引导界面',
    initializationInterfaceFailed: '首次使用界面加载失败，请重新加载引导界面。',
    initializationModeMismatch: '启动状态不一致，请重新加载窗口。',
    initializationRenderer_interface: '加载首次使用界面',
    initializationRenderer_interfaceDescription:
      '正在加载工作界面和内置编辑器，完成后将结束首次引导。',
    initializationRenderer_preferences: '读取首次使用设置',
    initializationRenderer_preferencesDescription: '正在载入刚准备好的应用设置和界面偏好。',
    initializationRenderer_appearance: '应用首次使用外观',
    initializationRenderer_appearanceDescription: '正在应用主题、字体和界面显示设置。',
    initializationRenderer_language: '载入界面语言',
    initializationRenderer_languageDescription: '正在应用语言设置并载入界面文案。',
    initializationRenderer_conversations: '打开首次工作区',
    initializationRenderer_conversationsDescription:
      '正在读取工作区设置和已有对话索引，准备进入首页。',
    initializationRenderer_engineStatus: '读取首次引擎状态',
    initializationRenderer_engineStatusDescription:
      '正在读取 AI 引擎的当前状态，即将结束首次引导。',
    initializationActivity_localServices: '连接本机服务',
    initializationActivity_localServicesDescription: '准备浏览器扩展与应用之间的本机连接。',
    initializationActivity_network: '应用网络设置',
    initializationActivity_networkDescription: '恢复已保存的代理设置和本机请求策略。',
    initializationActivity_modelAccess: '准备模型访问',
    initializationActivity_modelAccessDescription: '检查已配置的模型访问凭据，同步可用模型设置。',
    initializationActivity_integrations: '连接集成功能',
    initializationActivity_integrationsDescription: '连接本机集成服务，完成首次准备。',
    firstLaunchTitle: '正在完成首次准备',
    firstLaunchDescription: '正在准备本机目录、默认文件和启动环境。完成后将自动进入首页。',
    initializationWelcome: '首次启动',
    initializationSetupSteps: '准备进度',
    initializationStepDone: '已完成',
    initializationStepActive: '正在进行',
    initializationStepPending: '等待前序步骤',
    initializationStepFailed: '需要处理',
    initializationElapsed: '已用时',
    initializationActivityElapsed: '本项用时',
    initializationCurrentActivity: '当前操作',
    initializationStoppedAt: '发生问题的操作',
    initializationLongWait: '当前步骤耗时较长，请保持窗口打开。完成后将自动继续。',
    initializationExtendedWait:
      '当前步骤已超过 90 秒，暂未收到新的进展。页面会在状态变化后自动更新。',
    initializationDetails: '查看详细信息',
    initializationDataPath: '本机数据目录',
    initializationActivity_userDirectory: '创建用户目录',
    initializationActivity_userDirectoryDescription: '创建应用用于保存数据和配置的用户目录。',
    initializationActivity_database: '准备本机数据文件',
    initializationActivity_databaseDescription: '准备保存应用设置和任务信息所需的数据文件。',
    initializationActivity_python: '检查运行资源',
    initializationActivity_pythonDescription: '检查本机工具运行所需的内置组件。',
    initializationActivity_startupSettings: '准备本机启动设置',
    initializationActivity_startupSettingsDescription: '准备应用启动和本机功能连接所需的设置。',
    initializationActivity_workspace: '创建默认工作目录',
    initializationActivity_workspaceDescription: '创建用于保存任务文件的默认目录。',
    initializationActivity_defaultFiles: '准备默认文件',
    initializationActivity_defaultFilesDescription:
      '准备用户目录中的默认助手文件，并写入本机启动配置。',
    initializationActivity_engineStart: '启动本机组件',
    initializationActivity_engineStartDescription:
      '加载本机组件并检查启动状态，首次加载可能需要一些时间。',
    initializationActivity_finalize: '准备进入应用',
    initializationActivity_finalizeDescription: '完成最后的启动准备，即将打开首页。',
    initializationUserData: '创建用户目录',
    initializationRuntime: '检查运行资源',
    initializationConfiguration: '准备本机文件',
    initializationEngine: '完成启动检查',
    initializationComplete: '初始化完成',
    initializationFailed: '初始化未完成',
    initializationFailedDescription: '初始化遇到问题，请查看下方原因，处理后重新启动。',
    initializationRetry: '重新启动并重试',
    initializationSteps: '已完成步骤',
    initializationLogPath: '日志位置',
    initializationError: '应用准备未完成，请重新启动后重试。',
  },
  en: {
    initializationResultTitle: 'Your conversations are restored',
    initializationResultDescription:
      'Setup and history restoration are complete. Imported conversations start with the same current model and permission defaults as new conversations.',
    initializationResultConversations: 'Conversations restored',
    initializationResultMissing: 'Original history missing',
    initializationResultWorkspaces: 'Conversations needing a folder',
    initializationResultIncomplete:
      'Conversations with missing history keep their titles and show a notice. Missing workspaces do not block migration; choose an existing folder in the conversation before continuing.',
    initializationResultBackup: 'History backup retained on this computer',
    initializationResultContinue: 'Open the app',
    initializationOpenBackup: 'Open backup folder',
    initializationOpenData: 'Open data folder',
    initializationOpenTaskManager: 'Open Task Manager',
    initializationSupportFailed:
      'Could not open this location. Use the displayed folder or the system entry to open it manually.',
    initializationRecovery_space: 'History upgrade paused: the disk is full',
    initializationRecovery_spaceDescription:
      'Free space on the disk containing application data. Backup, restoration and temporary database files all need additional space. Then choose Restart and retry. This failure does not clear the history source or retained backups.',
    initializationRecovery_busy: 'Another program is using the history files',
    initializationRecovery_busyDescription:
      'Quit the previous application and its background components, close programs using these files, then restart and retry.',
    initializationRecovery_access: 'History files are in use or access was denied',
    initializationRecovery_accessDescription:
      'Close programs using these files and check that your account can read and write the data folder. Resolve any file locks, then restart and retry.',
    initializationRecovery_changing: 'The previous application is still writing history',
    initializationRecovery_changingDescription:
      'Quit the previous application and its background components. Once writes have stopped, restart and retry. The incomplete snapshot will not be treated as a successful backup.',
    initializationRecovery_other: 'History upgrade paused; recovery progress retained',
    initializationRecovery_otherDescription:
      'Quit the previous application, check free disk space and folder access, then review the failure details below. Resolve the cause and restart to retry. You do not need to clear the data folder manually.',
    initializationRecoveryTaskManagerHint:
      'You can manually end a confirmed process belonging to the previous application in Task Manager. Check its name and location before ending it.',
    initializationUpgradeWelcome: 'Upgrade and setup',
    initializationUpgradeTitle: 'Keep your conversations going',
    initializationUpgradeDescription:
      'Back up history, prepare a fresh environment, then restore conversations. Settings, plugins and scheduled tasks use current defaults.',
    initializationBackup: 'Back up history',
    initializationHistory: 'Restore conversations',
    initializationHistoryRecovered: 'Conversations restored:',
    initializationHistoryUnavailable: 'Original history unavailable:',
    initializationActivity_historyBackup: 'Safely saving conversation history',
    initializationActivity_historyBackupDescription:
      'Backing up conversations, titles and associations, then verifying the backup before replacing the old environment.',
    initializationActivity_historyImport: 'Restoring conversation history',
    initializationActivity_historyImportDescription:
      'Importing history into native storage while retaining parent and subtask associations. Large histories may take a few minutes.',
    initializationActivity_historyMetadata: 'Restoring titles and associations',
    initializationActivity_historyMetadataDescription:
      'Restoring the conversation list and exact history associations so conversations can continue.',
    initializationRenderer_models: 'Loading available models',
    initializationRenderer_modelsDescription:
      'Reading current model settings and preparing the workspace.',
    initializationConnecting: 'Reading first-launch progress',
    initializationInterfaceLoading: 'Local setup complete; opening the home page',
    initializationConnectingDescription: 'Reading preparation status for this first launch.',
    firstLaunchFinishing: 'Opening your first workspace',
    initializationReload: 'Reload setup screen',
    initializationInterfaceFailed:
      'The first-use interface could not load. Reload this setup screen.',
    initializationModeMismatch: 'Startup state does not match this window. Reload the window.',
    initializationRenderer_interface: 'Loading the first-use interface',
    initializationRenderer_interfaceDescription:
      'Loading the workspace and bundled editor before completing first-launch setup.',
    initializationRenderer_preferences: 'Reading first-use settings',
    initializationRenderer_preferencesDescription:
      'Loading the application settings and interface preferences prepared for this launch.',
    initializationRenderer_appearance: 'Applying first-use appearance',
    initializationRenderer_appearanceDescription:
      'Applying the theme, fonts, and display settings.',
    initializationRenderer_language: 'Loading the interface language',
    initializationRenderer_languageDescription:
      'Applying language preferences and loading interface text.',
    initializationRenderer_conversations: 'Opening your first workspace',
    initializationRenderer_conversationsDescription:
      'Reading workspace settings and existing conversation indexes before opening the home page.',
    initializationRenderer_engineStatus: 'Reading initial engine status',
    initializationRenderer_engineStatusDescription:
      'Reading the current AI engine status before completing first-launch setup.',
    initializationActivity_localServices: 'Connecting local services',
    initializationActivity_localServicesDescription:
      'Preparing the local connection between browser extensions and the app.',
    initializationActivity_network: 'Applying network settings',
    initializationActivity_networkDescription:
      'Restoring saved proxy settings and local request policies.',
    initializationActivity_modelAccess: 'Preparing model access',
    initializationActivity_modelAccessDescription:
      'Checking configured model credentials and synchronizing available models.',
    initializationActivity_integrations: 'Connecting integrations',
    initializationActivity_integrationsDescription:
      'Connecting local integration services and completing first-launch preparation.',
    firstLaunchTitle: 'Preparing your first launch',
    firstLaunchDescription:
      'Preparing local folders, default files, and the startup environment. The home page will open automatically when ready.',
    initializationWelcome: 'First launch',
    initializationSetupSteps: 'Setup progress',
    initializationStepDone: 'Completed',
    initializationStepActive: 'In progress',
    initializationStepPending: 'Waiting for earlier steps',
    initializationStepFailed: 'Needs attention',
    initializationElapsed: 'Elapsed',
    initializationActivityElapsed: 'This operation',
    initializationCurrentActivity: 'Current operation',
    initializationStoppedAt: 'Operation that needs attention',
    initializationLongWait:
      'This step is taking longer. Keep this window open; setup will continue automatically when it finishes.',
    initializationExtendedWait:
      'This step has taken over 90 seconds without a new progress update. This page will update automatically when the status changes.',
    initializationDetails: 'View details',
    initializationDataPath: 'Local data directory',
    initializationActivity_userDirectory: 'Creating the user directory',
    initializationActivity_userDirectoryDescription:
      'Creating the user directory for application data and settings.',
    initializationActivity_database: 'Preparing local data files',
    initializationActivity_databaseDescription:
      'Preparing the data files used to store application settings and task information.',
    initializationActivity_python: 'Checking runtime resources',
    initializationActivity_pythonDescription:
      'Checking the bundled components needed to run local tools.',
    initializationActivity_startupSettings: 'Preparing local startup settings',
    initializationActivity_startupSettingsDescription:
      'Preparing settings for application startup and connections between local features.',
    initializationActivity_workspace: 'Creating the default workspace',
    initializationActivity_workspaceDescription: 'Creating the default directory for task files.',
    initializationActivity_defaultFiles: 'Preparing default files',
    initializationActivity_defaultFilesDescription:
      'Preparing default assistant files in the user directory and writing local startup configuration.',
    initializationActivity_engineStart: 'Starting local components',
    initializationActivity_engineStartDescription:
      'Loading local components and checking their startup status. The first load may take some time.',
    initializationActivity_finalize: 'Getting ready to open the app',
    initializationActivity_finalizeDescription:
      'Finishing startup preparations. The home page will open shortly.',
    initializationUserData: 'Create the user directory',
    initializationRuntime: 'Check runtime resources',
    initializationConfiguration: 'Prepare local files',
    initializationEngine: 'Complete startup checks',
    initializationComplete: 'Initialization complete',
    initializationFailed: 'Initialization could not finish',
    initializationFailedDescription:
      'Review the issue below, resolve it, then restart the application.',
    initializationRetry: 'Restart and retry',
    initializationSteps: 'Steps completed',
    initializationLogPath: 'Log location',
    initializationError:
      'Application setup could not finish. Restart the application to try again.',
  },
};
