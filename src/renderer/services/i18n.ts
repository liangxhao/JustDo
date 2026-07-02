import { configService } from './config';

// 支持的语言类型
export type LanguageType = 'zh' | 'en';

// 语言文本映射
const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    // 通用
    save: '保存',
    cancel: '取消',
    saving: '保存中...',
    delete: '删除',
    create: '创建',
    clear: '清除',
    show: '显示',
    hide: '隐藏',
    add: '添加',
    user: '用户',

    // 设置
    settings: '设置',
    resizePanels: '拖动调整左右区域大小',
    resizeSettingsWindow: '拖动调整设置窗口宽度',
    general: '通用',
    model: '模型',
    shortcuts: '快捷键',
    help: '帮助',
    about: '关于',
    appName: '软件名称',
    appVersion: '软件版本',
    openclawVersion: 'OpenClaw 版本',
    theme: '主题',
    appearance: '外观',
    language: '语言',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    themeColor: '主题色',
    chinese: '中文',
    english: 'English',

    // API设置
    apiKey: 'API Key',
    apiKeyPlaceholder: '输入你的 API Key',
    getApiKey: '获取 API Key',
    visitOfficialSite: '访问官网',
    baseUrl: 'API Base URL',
    baseUrlPlaceholder: '输入 API 基础 URL',
    baseUrlHint2: 'OpenAI 兼容（以硅基流动为例）：',
    baseUrlHintExample2: 'https://api.siliconflow.cn/v1',
    currentModel: '当前模型',
    availableModels: '可用模型列表',

    // 模型提供商设置
    enabled: '已启用',
    disabled: '已禁用',
    providerStatusOn: '已开启',
    providerStatusOff: '未开启',
    providerSettings: '提供商设置',
    modelProviders: '模型提供商',
    addModel: '添加模型',
    editModel: '编辑模型',
    addNewModel: '添加新模型',
    modelName: '模型名称',
    modelId: '模型ID',
    modelNameAndIdRequired: '请填写模型名称和模型ID',
    modelIdExists: '模型ID已存在，请使用不同的ID',
    ollamaModelName: '模型名称',
    ollamaModelNameHint: '输入 Ollama 中已安装的模型名称，如 qwen3:8b、lfm2:latest',
    ollamaModelNamePlaceholder: 'qwen3:8b',
    ollamaDisplayName: '显示名称（可选）',
    ollamaDisplayNameHint: '自定义在列表中显示的名称，留空则使用模型名称',
    ollamaDisplayNamePlaceholder: '我的 Qwen3 模型',
    ollamaModelNameRequired: '请填写模型名称',
    supportsImageInput: '支持图像输入',
    contextLength: '上下文长度',
    contextLengthHint: '模型支持的上下文窗口长度（token 数量），默认 200k',
    maxTokens: '最大输出长度',
    maxTokensHint: '模型最大输出 token 数量，默认 32k',
    imageInput: '图像',
    modelSuffixSecure: '（安全）',
    inputFileLabel: '输入文件',
    imageVisionHint:
      '当前模型未启用图片输入，图片将以文件路径形式发送。若该模型本身支持图片理解，可在模型配置中开启图片输入选项。',
    noModelsAvailable: '暂无可用模型',
    addFirstModel: '添加第一个模型',
    testConnection: '测试连接',
    connectionTestResult: '连接测试结果',
    testing: '测试中...',
    connectionSuccess: '连接成功',
    connectionFailed: '连接失败',
    testRequestUrl: '请求地址',
    testModel: '测试模型',
    testStatus: '状态码',
    testResponse: '响应内容',
    testError: '错误日志',
    noModelsConfigured: '请先添加模型',
    addCustomProvider: '+ 添加自定义',
    customBadge: '自定义',
    customDisplayName: '显示名称',
    customDisplayNamePlaceholder: '输入自定义名称...',
    deleteCustomProvider: '删除',
    confirmDeleteCustomProvider: '确定删除此自定义模型配置？',
    import: '导入',
    export: '导出',
    importProvidersFailed: '导入失败',
    exportProvidersFailed: '导出失败',
    invalidProvidersFile: '导入文件格式不正确',
    decryptProvidersFailed: '密钥解密失败，请确认文件由当前设备导出',
    decryptProvidersPartial: '部分密钥无法解密，已保留本地密钥或留空，请手动检查',

    // 密码相关
    password: '密码',

    // 快捷键
    keyboardShortcuts: '键盘快捷键',
    shortcutNotSet: '未设置',
    newChat: '新对话',
    search: '搜索任务',
    openSettings: '打开设置',
    sendMessageShortcut: '发送消息',
    shortcutConflict: '快捷键 "{0}" 已被 "{1}" 使用',
    close: '关闭',
    previous: '上一个',
    next: '下一个',
    ignoreCase: '忽略大小写',
    collapse: '收起',
    expand: '展开',

    // 错误信息

    // 加载状态
    loading: '加载中...',

    // 侧边栏
    conversations: '对话',
    renameConversation: '重命名',
    confirmDelete: '确认删除',
    searchConversations: '搜索任务...',
    searchNoResults: '未找到匹配任务',
    project: '项目',

    // 聊天窗口
    sendMessage: '发送消息',
    copyToClipboard: '复制到剪贴板',
    showCode: '显示 Mermaid 源码',
    renderDiagram: '渲染 Mermaid 图表',
    mermaidRenderFailed: 'Mermaid 图表渲染失败',
    copied: '已复制',
    yesterday: '昨天',
    daysAgo: '天前',
    justNow: '刚刚',
    minutesAgo: '分钟前',
    hoursAgo: '小时前',
    thinking: '思考中...',
    showToolCalls: '显示工具调用',
    coworkSearchInSession: '搜索当前会话',
    coworkSearchInSessionPlaceholder: '搜索当前会话...',
    coworkSearchMatchCount: '{current}/{total}，共 {total} 个',
    reasoning: '思考过程',

    // 模型选择

    // 错误提示
    apiKeyRequired: '需要设置API密钥',
    configureApiKey: '请在设置中配置您的API密钥',

    // 初始化
    initializationError: '初始化应用程序失败。请检查您的配置。',

    // JustDo
    cowork: 'JustDo',
    coworkHistory: '最近对话',
    groupedSessions: '对话分组',
    coworkNoSessions: '暂无最近对话',

    // 会话分组
    rename: '重命名',
    createGroup: '新建分组',
    groupName: '分组名称',
    groupNamePlaceholder: '输入分组名称',
    groupColor: '分组颜色',
    moveToGroup: '移动到分组',
    ungrouped: '未分组',
    deleteGroup: '删除分组',
    deleteGroupConfirm: '确定删除该分组吗？',
    deleteGroupNote: '分组内的会话将变为未分组状态',
    changeColor: '更改颜色',
    moveUp: '上移',
    moveDown: '下移',

    refresh: '刷新',
    coworkPlaceholder: '分配一个任务或提问任何问题',
    coworkModelSettingsRequired: '请先在模型设置中配置可用模型与 API Key。',
    modelGroupServer: '套餐模型',
    modelGroupUser: '自定义模型',
    modelSelectorNoModels: '请先在设置中配置模型',
    coworkAgentEngine: 'Agent 引擎',
    coworkAgentEngineOpenClaw: 'OpenClaw（默认）',
    coworkAgentEngineOpenClawHint: '个人 AI 助理',
    coworkAgentEngineClaudeLegacy: 'Cowork',
    coworkAgentEngineClaudeLegacyHint: '内置引擎，开箱即用，推荐作为日常任务主引擎。',
    coworkOpenClawInstall: '启动 OpenClaw',
    coworkOpenClawStart: '启动 OpenClaw',
    coworkOpenClawInstalling: '正在启动 OpenClaw...',
    coworkOpenClawInstallHint: 'OpenClaw 运行时已内置。切换到该引擎或启动任务时会自动拉起网关。',
    coworkOpenClawRestartGateway: '重新启动网关',
    coworkOpenClawNotInstalledNotice:
      '未检测到内置 OpenClaw runtime（cfmind），请先执行打包前构建脚本。',
    coworkOpenClawReadyNotice: 'OpenClaw runtime 已就绪。开始任务时会自动启动网关。',
    coworkOpenClawStarting: 'AI 引擎正在启动网关...',
    coworkOpenClawRunning: 'AI 引擎已就绪。',
    coworkOpenClawError: 'OpenClaw 网关未能在规定时间内启动成功。',
    openclawGatewayPortTitle: '网关端口',
    openclawGatewayPortHint:
      '内置 OpenClaw 的网关服务端口。如果与其他 OpenClaw 冲突，可修改此端口。',
    coworkConfigSaveFailed: '保存 JustDo 配置失败，请稍后重试。',
    coworkStatusIdle: '已停止',
    coworkStatusRunning: '运行中',
    coworkStatusCompleted: '已完成',
    coworkStatusError: '错误',
    coworkPermissionRequired: '需要权限确认',
    coworkPermissionDescription: 'JustDo 请求执行以下操作',
    coworkSelectionRequired: '请选择',
    coworkSelectionDescription: 'JustDo 需要你做出选择',
    coworkToolName: '工具名称',
    coworkToolInput: '工具参数',
    coworkToolResult: '执行结果',
    coworkToolRunning: '执行中',
    coworkToolTimelineSummaryLabel: 'tools',
    coworkDestructiveOperation: '高危操作：此命令可能导致不可逆的数据丢失，请务必确认。',
    coworkCautionOperation: '注意：此命令可能会修改文件或系统状态，请仔细检查。',
    dangerReasonRecursiveDelete: '递归删除文件',
    dangerReasonGitForcePush: 'Git 强制推送',
    dangerReasonGitResetHard: 'Git 硬重置',
    dangerReasonDiskOverwrite: '磁盘写入操作',
    dangerReasonDiskFormat: '磁盘格式化',
    dangerReasonFileDelete: '文件删除操作',
    dangerReasonGitPush: 'Git 推送',
    dangerReasonProcessKill: '终止进程',
    dangerReasonPermissionChange: '修改文件权限',
    coworkApprove: '允许',
    coworkDeny: '拒绝',
    coworkConfirmSelection: '提交当前选择',
    coworkDenyRequest: '直接拒绝请求',
    coworkQuestionWizardTitle: '需要您的确认',
    coworkQuestionWizardSkip: '跳过',
    coworkQuestionWizardPrevious: '上一个',
    coworkQuestionWizardNext: '下一个',
    coworkQuestionWizardSubmit: '提交',
    coworkQuestionWizardOther: '其他',
    coworkQuestionWizardOtherPlaceholder: '请输入自定义答案...',
    coworkQuestionWizardAnswerRequired: '请选择或输入答案',
    coworkContextUsageFullLabel: '已使用上下文/总上下文',
    coworkWelcome: '开始协作',
    coworkDescription: '7×24 小时帮你干活的硬件场景个人助理 Agent',
    openChatWeb: '打开 ChatWeb',
    chatWebTokenError: '无法获取访问令牌，请尝试重启 AI 引擎',
    chatWebPortError: '无法获取服务端口',

    // Multi-Agent 管理
    createAgent: '创建 Agent',
    myAgents: 'Agent 管理',
    agentSettings: 'Agent 设置',
    agentName: '名称',
    agentNamePlaceholder: 'Agent 名称',
    emojiPickerTitle: '选择图标',
    emojiCustomInput: '或者直接输入 Emoji',
    agentDescription: '描述',
    agentDescriptionPlaceholder: '简短描述',
    agentIdentity: '身份',
    agentIdentityPlaceholder: '身份描述（IDENTITY.md）...',
    agentDefaultModel: 'Agent 默认模型',
    agentModelOpenClawOnly: '仅 OpenClaw 引擎使用此设置',
    agentModelInvalidHint: '当前 Agent 绑定的模型已不可用，请先为该 Agent 重新选择有效模型',
    agentSkills: '技能',
    agentSkillsHint: '选择该 Agent 可使用的技能。不选则使用所有已启用技能。',
    agentSkillsSearch: '搜索技能...',
    agentsSubtitle: '为您的智能体提供专属人设与技能组合',
    presetAgents: '预设 Agent',
    myCustomAgents: '我创建的 Agent',
    createNewAgent: '新建 Agent',
    addAgent: '添加',
    agentTabBasic: '基础信息',
    agentTabSkills: '技能',
    agentIMBoundToOther: '→ {agent}',
    agentCreateFailed: '创建 Agent 失败',
    agentSaveFailed: '保存 Agent 设置失败',
    agentDeleteConfirmTitle: '确认删除 Agent',
    agentDeleteConfirmMessage: '确定要删除 Agent「{name}」吗？此操作不可撤销。',
    agentUnsavedTitle: '未保存的更改',
    agentUnsavedMessage: '有未保存的更改，确定要放弃吗？',
    discard: '放弃',
    creating: '创建中...',

    coworkNewSession: '新会话',
    coworkContinuePlaceholder: '继续对话...',
    aiGeneratedDisclaimer: '内容由AI生成，仅供参考',
    coworkAddFile: '添加文件',
    slashCommandButton: 'Slash commands',
    slashCommandShowMore: 'Show {count} more commands',
    slashCommandOptionsCount: '{count} options',
    coworkDropFileHint: '拖拽文件到此处，或直接粘贴文件',
    coworkAttachmentRemove: '移除',
    coworkOpenAttachment: '打开附件',
    // Context menu
    contextMenuCut: '剪切',
    contextMenuCopy: '复制',
    contextMenuPaste: '粘贴',
    contextMenuSelectAll: '全选',
    deleteSession: '删除对话',
    subagents: 'Subagent',
    subagentEmpty: '当前会话暂无 Subagent',
    subagentShowInfo: '查看详情',
    subagentInfoStatus: '状态',
    subagentInfoTask: '任务描述',
    subagentInfoModel: '模型',
    subagentInfoRuntime: '运行时长',
    subagentInfoStarted: '开始时间',
    subagentInfoEnded: '结束时间',
    subagentInfoTokens: 'Token 用量',
    subagentInfoSession: '会话标识',
    subagentInfoUnavailable: '暂无',
    subagentDrawerTitle: 'Subagent: {title}',
    subagentDrawerResize: '调整 Subagent 面板宽度',
    subagentMessages: 'Subagent 消息',
    subagentMessagesEmpty: '暂无 Subagent 消息',
    subagentMessagesLoadFailed: '加载 Subagent 消息失败',
    deleteTaskConfirmTitle: '确认删除对话',
    deleteTaskConfirmMessage: '此操作无法撤销，对话的所有消息记录将被永久删除。',
    batchOperations: '批量操作',
    batchSelectAll: '全选',
    batchDelete: '删除',
    batchCancel: '取消',
    batchDeleteConfirmTitle: '确认批量删除',
    batchDeleteConfirmMessage: '确定要删除选中的 {count} 个任务吗？此操作不可撤销。',
    back: '返回',
    browse: '浏览',
    addFolder: '选择工作空间',
    recentFolders: '最近使用',
    noFolderSelected: '未选择文件夹',
    coworkSelectFolderFirst: '请选择任务目录后再提交',
    noRecentFolders: '暂无最近文件夹',
    folderDriveRootNotAllowed:
      '不支持使用磁盘根目录作为工作目录，请选择一个子文件夹（例如 D:\\Projects）。',
    coworkOpenFolder: '打开文件夹',
    coworkOpenFolderFailed: '打开文件夹失败',

    // Cowork 错误消息
    coworkErrorSessionStartFailed: '会话启动失败：{error}',
    coworkErrorSessionContinueFailed: '发送消息失败：{error}',
    coworkErrorEngineNotReady: 'AI 引擎正在启动中，请稍等几秒后重试。',

    // Skills
    skills: '技能',
    searchSkills: '搜索技能',
    manageSkills: '管理技能',
    addSkill: '添加',
    noSkillsAvailable: '暂无可用技能',
    skillsDescription: '为您的智能体提供预封装且可重复的最佳实践与工具',
    skillsDescriptionGateway: '管理智能体可使用的技能与工具',
    skillInstalled: '已安装',
    skillGroupPriority: '优先级 {priority}',
    'skillGroup.workspace.label': '工作区技能',
    'skillGroup.workspace.description': '仅用于当前任务目录，可覆盖其他位置的同名技能',
    'skillGroup.agents-project.label': '项目 Agent 技能',
    'skillGroup.agents-project.description': '用于当前项目，可供项目中的智能体共同使用',
    'skillGroup.agents-personal.label': '个人 Agent 技能',
    'skillGroup.agents-personal.description': '属于当前用户，可在不同项目中使用',
    'skillGroup.managed.label': '托管技能',
    'skillGroup.managed.description': '由您安装或导入，可在所有任务中使用',
    'skillGroup.openclaw-bundled.label': '内置技能',
    'skillGroup.openclaw-bundled.description': '应用预装的通用技能，无需额外安装',
    'skillGroup.extra-dir.label': '扩展目录技能',
    'skillGroup.extra-dir.description': '由扩展或第三方组件提供的技能',
    'skillGroup.unknown.label': '其他技能',
    'skillGroup.unknown.description': '来源层级暂未识别的技能',
    skillMarketplace: '技能市场',
    skillMarketplaceComingSoon: '即将上线，敬请期待',
    skillMarketplaceComingSoonDesc: '技能市场功能正在开发中，您将能够从 ClawHub 搜索和安装更多技能',
    skillInstall: '安装',
    // Offline skill import
    importSkill: '导入',
    importSkillProgress: '导入中',
    importSkillTooltip: '从本地压缩包导入技能（支持 ZIP、TGZ 格式）',
    importSkillFolder: '导入文件夹',
    importSkillFolderProgress: '导入中',
    importSkillFolderTooltip: '从本地文件夹导入技能（每个文件夹包含一个 SKILL.md）',
    selectSkillArchive: '选择技能压缩包',
    selectSkillFolder: '选择技能文件夹',
    skillImportSuccess: '技能 {skillId} 导入成功',
    skillImportFailed: '技能导入失败',
    // Gateway offline
    gatewayOffline: 'Gateway 离线',
    gatewayOfflineSkillsUnavailable: 'Gateway 离线，技能功能暂时不可用',
    // Skill status
    missing: '缺失',
    missingBins: '缺失工具',
    missingEnv: '缺失环境变量',
    skillMissingRequirements: '技能缺少必要依赖',

    // Security scan
    securityIssuesFound: '{name} 技能的以下行为请悉知：',
    skillDetailVersion: '版本',
    deleteSkill: '删除技能',
    skillDeleteConfirm: '确定删除技能”{name}”吗？',
    skillDeleteFailed: '删除技能失败',
    skillDeleteSuccess: '技能”{name}”已删除',
    skillBuiltInDeleteHint: '系统内置技能无法通过应用删除。请手动删除文件夹。',
    skillDeleteManualHint: '此技能无法通过应用删除，请在打开的文件夹中手动删除。',
    skillUpdateFailed: '更新技能失败',
    activeSkill: '当前技能',
    clearSkill: '清除技能',
    clearAll: '全部清除',
    clearAllSkills: '清除所有已选技能',

    // MCP 服务
    mcpServers: 'MCP',
    mcpDescription: '配置和管理 MCP（Model Context Protocol）服务器，为您的智能体扩展工具能力',
    searchMcpServers: '搜索 MCP 服务',
    addMcpServer: '自定义',
    editMcpServer: '编辑 MCP 服务',
    deleteMcpServer: '删除 MCP 服务',
    mcpServerName: '服务名称',
    mcpServerNamePlaceholder: '输入服务名称',
    mcpServerDescription: '描述',
    mcpServerDescriptionPlaceholder: '描述此 MCP 服务的用途',
    mcpTransportType: '传输类型',
    mcpCommand: '命令',
    mcpCommandPlaceholder: '例如: node, npx, uvx, python',
    mcpArgs: '参数',
    mcpArgsPlaceholder: '每行一个参数',
    mcpEnvVars: '环境变量',
    mcpUrl: 'URL',
    mcpUrlPlaceholder: '例如: http://localhost:3000/mcp',
    mcpHeaders: 'HTTP 请求头',
    mcpHeaderKey: '键',
    mcpHeaderValue: '值',
    mcpDeleteConfirm: '确定删除 MCP 服务"{name}"吗？',
    mcpDeleteFailed: '删除 MCP 服务失败',
    mcpCreateFailed: '创建 MCP 服务失败',
    mcpUpdateFailed: '更新 MCP 服务失败',
    mcpBridgeSyncing: '正在同步 MCP 工具...',
    mcpBridgeSyncDone: 'MCP 工具同步完成',
    mcpBridgeSyncError: '同步失败',
    mcpNameRequired: '请填写服务名称',
    mcpCommandRequired: 'stdio 类型需要填写命令',
    mcpUrlRequired: 'SSE/HTTP 类型需要填写 URL',
    mcpNameExists: '服务名称已存在',
    mcpTransportStdio: '标准输入输出 (stdio)',
    mcpTransportSse: '服务器推送事件 (SSE)',
    mcpTransportHttp: 'HTTP 流式传输',
    addKeyValue: '添加',
    saveMcpServer: '保存',
    // MCP 市场 & 注册表
    mcpInstalled: '已安装',
    mcpMarketplace: '市场',
    mcpMarketplaceComingSoon: '即将上线，敬请期待',
    mcpCustom: '自定义',
    mcpInstall: '安装',
    mcpRequiredConfig: '必填配置',
    mcpEnvRequired: '此字段为必填项',
    mcpNoInstalledServers: '尚未安装任何 MCP 服务',
    mcpCategoryAll: '全部',
    mcpCategorySearch: '搜索',
    mcpCategoryBrowser: '浏览器',
    mcpCategoryDeveloper: '开发工具',
    mcpCategoryProductivity: '效率工具',
    mcpCategoryDesign: '设计',
    mcpCategoryDataApi: '数据 & API',
    mcpDesc_tavily: '实时网页搜索、智能数据提取和网站爬取',
    mcpDesc_github: 'GitHub 平台集成：仓库、Issues、PR、Actions 管理',
    mcpDesc_gitlab: 'GitLab API 集成：项目管理、合并请求、流水线',
    mcpDesc_context7: '为 AI 编程提供最新的库文档和代码示例',
    mcpDesc_google_drive: 'Google Drive 文件访问和搜索，自动导出 Workspace 文件',
    mcpDesc_gmail: 'Gmail 邮件管理：读取、发送、搜索邮件，支持自动认证',
    mcpDesc_google_calendar: 'Google Calendar 日程管理：创建、查询、更新日历事件',
    mcpDesc_notion: 'Notion API：搜索、创建/更新页面、管理数据库',
    mcpDesc_slack: 'Slack 工作区：频道管理、消息发送、用户查询',
    mcpDesc_todoist: '任务管理：创建、更新、完成和组织待办事项',
    mcpDesc_playwright: '高级浏览器自动化，支持 Chromium/Firefox/WebKit',
    mcpDesc_canva: 'Canva 设计平台：创建和管理设计、模板操作',
    mcpDesc_firecrawl: '网页抓取与数据提取：支持批处理、结构化提取和内容分析',

    // 文件操作
    openFolder: '打开文件夹',
    showInFolder: '在文件夹中显示',
    showInFolderFailed: '打开文件所在目录失败',

    // IM Bot
    imBot: 'IM 机器人',
    imComingSoon: 'Coming Soon',
    imComingSoonDesc: 'IM 机器人功能正在开发中，敬请期待。',

    // 通用设置
    autoLaunch: '开机自启动',
    autoLaunchDescription: '系统启动时自动运行应用',
    useSystemProxy: '使用系统代理',
    useSystemProxyDescription: '开启后网络请求将跟随系统代理（保存后生效）',
    preventSleep: '防止休眠',
    preventSleepDescription: '防止系统在应用运行时进入睡眠模式',

    // 定时任务
    scheduledTasks: '定时任务',
    plugins: '插件',
    extensions: '扩展',
    extensionsComingSoon: '扩展功能即将推出',
    scheduledTasksFormScheduleModeAt: '指定时间',
    scheduledTasksFormWeekSun: '周日',
    scheduledTasksFormWeekMon: '周一',
    scheduledTasksFormWeekTue: '周二',
    scheduledTasksFormWeekWed: '周三',
    scheduledTasksFormWeekThu: '周四',
    scheduledTasksFormWeekFri: '周五',
    scheduledTasksFormWeekSat: '周六',
    scheduledTasksFormInterval: '间隔时间',
    scheduledTasksFormIntervalMinutes: '分钟',
    scheduledTasksFormIntervalHours: '小时',
    scheduledTasksFormIntervalDays: '天',
    scheduledTasksFormPayloadKind: '任务载荷',
    scheduledTasksFormPayloadKindSystemEvent: '系统事件',
    scheduledTasksFormPayloadKindAgentTurn: 'Agent 对话',
    scheduledTasksDelete: '删除',
    scheduledTasksDeleteConfirm: '确定要删除任务「{name}」吗？此操作不可撤销。',
    scheduledTasksSchedule: '计划',
    scheduledTasksStatus: '运行状态',
    scheduledTasksNoRuns: '暂无运行记录',
    scheduledTasksLoadMore: '加载更多',
    scheduledTasksViewSession: '查看会话',
    scheduledTasksSessionNotSynced: '会话记录同步失败，请稍后重试',
    scheduledTasksSessionSyncing: '正在同步会话记录...',
    scheduledTasksSessionRetry: '重试',
    scheduledTasksStatusSuccess: '成功',
    scheduledTasksStatusError: '失败',
    scheduledTasksStatusSkipped: '跳过',
    scheduledTasksStatusRunning: '运行中',
    scheduledTasksStatusIdle: '空闲',
    scheduledTasksScheduleEvery: '每',
    scheduledTasksCronEveryDay: '每天',
    scheduledTasksCronEveryNMinutes: '每 {n} 分钟',
    scheduledTasksCronEveryMinute: '每分钟',
    scheduledTasksCronEveryNHours: '每 {n} 小时',
    scheduledTasksCronEveryHour: '每小时',
    scheduledTasksCronWeekdays: '工作日',
    scheduledTasksCronWeekends: '周末',
    scheduledTasksCronEveryWeek: '每周',
    scheduledTasksCronEveryMonth: '每月',
    scheduledTasksCronAtTime: '{schedule} {time}',
    scheduledTasksCronAtMonthDay: '{schedule} {day}日 {time}',
    scheduledTasksCronEveryHourAtMinute: '每小时第 {min} 分钟',
    // IM 平台通知选项将在集成后添加
    scheduledTasksFormDeliveryMode: '投递方式',
    scheduledTasksFormDeliveryModeNone: '不投递',
    scheduledTasksFormDeliveryModeAnnounce: '播报摘要',
    scheduledTasksFormDeliveryModeWebhook: 'Webhook',
    scheduledTasksDataAnomalyWarning:
      '定时任务「{name}」存在异常数据，已自动修正显示，建议重新编辑该任务',

    copy: '复制',

    // TaskForm unsaved changes confirmation
    // Cron UI (new card-based design)
    cronTitle: '定时任务',
    cronSubtitle: '通过定时任务自动化 AI 工作流',
    cronNewTask: '新建任务',
    cronRefresh: '刷新',
    cronStatsTotal: '任务总数',
    cronStatsActive: '运行中',
    cronStatsPaused: '已暂停',
    cronStatsFailed: '失败',
    cronEmptyTitle: '暂无定时任务',
    cronEmptyDescription:
      '创建定时任务以自动化 AI 工作流。任务可以在指定时间发送消息、运行查询或执行操作。',
    cronEmptyCreate: '创建第一个任务',
    cronCardRunNow: '立即运行',
    cronCardLast: '上次运行',
    cronCardNext: '下次运行',
    cronCardHistory: '运行历史',
    cronDialogCreateTitle: '创建任务',
    cronDialogEditTitle: '编辑任务',
    cronDialogTaskName: '任务名称',
    cronDialogTaskNamePlaceholder: '例如：早间简报',
    cronDialogMessage: '消息 / 提示词',
    cronDialogMessagePlaceholder: 'AI 应该做什么？例如：给我一份今天的新闻和天气摘要',
    cronDialogAgent: '智能体',
    cronDialogSchedule: '调度计划',
    cronDialogScheduleModeRecurring: '周期',
    cronDialogScheduleModeOnce: '单次',
    cronDialogRecurrenceHourly: '每小时',
    cronDialogRecurrenceDaily: '每天',
    cronDialogRecurrenceWeekdays: '工作日',
    cronDialogRecurrenceWeekly: '每周',
    cronDialogRecurrenceCustom: '自定义',
    cronDialogTimeLabel: '时间',
    cronDialogDateLabel: '日期',
    cronDialogWeekdayLabel: '星期',
    cronDialogMinuteLabel: '每小时的第几分钟',
    cronDialogCronPlaceholder: 'Cron 表达式 (例如：0 9 * * *)',
    cronDialogEnableImmediately: '立即启用',
    cronDialogEnableImmediatelyDesc: '创建后立即开始运行此任务',
    cronDialogSaveChanges: '保存更改',
    cronDialogDeliveryTitle: '投递设置',
    cronDialogDeliveryDescription: '选择仅在应用内保留结果，或推送到外部通道。',
    cronDialogDeliveryModeNone: '仅在应用内',
    cronDialogDeliveryModeNoneDesc: '任务照常运行，结果只保留在应用内。',
    cronDialogDeliveryModeAnnounce: '发送到外部通道',
    cronDialogDeliveryModeAnnounceDesc: '将最终结果投递到已配置的消息通道。',
    cronDialogSelectChannel: '选择通道',
    cronToastCreated: '任务已创建',
    cronToastUpdated: '任务已更新',
    cronToastEnabled: '任务已启用',
    cronToastPaused: '任务已暂停',
    cronToastDeleted: '任务已删除',
    cronToastTriggered: '任务已成功触发',
    cronToastFailedTrigger: '触发任务失败',
    cronToastFailedUpdate: '更新任务失败',
    cronToastFailedDelete: '删除任务失败',
    cronToastNameRequired: '请输入任务名称',
    cronToastMessageRequired: '请输入消息',
    cronToastScheduleRequired: '请选择或输入调度计划',
    cronToastSchedulePast: '所选时间已过期，请选择一个未来的时间。',
  },
  en: {
    // Common
    save: 'Save',
    cancel: 'Cancel',
    saving: 'Saving...',
    delete: 'Delete',
    create: 'Create',
    clear: 'Clear',
    show: 'Show',
    hide: 'Hide',
    add: 'Add',
    user: 'User',

    // Settings
    settings: 'Settings',
    resizePanels: 'Drag to resize panels',
    resizeSettingsWindow: 'Drag to resize the settings window',
    general: 'General',
    model: 'Model',
    shortcuts: 'Shortcuts',
    help: 'Help',
    about: 'About',
    appName: 'App Name',
    appVersion: 'App Version',
    openclawVersion: 'OpenClaw Version',
    theme: 'Theme',
    appearance: 'Appearance',
    language: 'Language',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    themeColor: 'Color Themes',
    chinese: 'Chinese',
    english: 'English',

    // API Settings
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Enter your API Key',
    getApiKey: 'Get API Key',
    visitOfficialSite: 'Visit official site',
    baseUrl: 'API Base URL',
    baseUrlPlaceholder: 'Enter API Base URL',
    baseUrlHint2: 'OpenAI compatible (e.g. SiliconFlow):',
    baseUrlHintExample2: 'https://api.siliconflow.cn/v1',
    currentModel: 'Current Model',
    availableModels: 'Available Models',

    // Model Provider Settings
    enabled: 'Enabled',
    disabled: 'Disabled',
    providerStatusOn: 'on',
    providerStatusOff: 'off',
    providerSettings: 'Provider Settings',
    modelProviders: 'Model Providers',
    addModel: 'Add Model',
    editModel: 'Edit Model',
    addNewModel: 'Add New Model',
    modelName: 'Model Name',
    modelId: 'Model ID',
    modelNameAndIdRequired: 'Model name and model ID are required',
    modelIdExists: 'Model ID already exists. Use a different one',
    ollamaModelName: 'Model Name',
    ollamaModelNameHint:
      'Enter the name of a model installed in Ollama, e.g. qwen3:8b, lfm2:latest',
    ollamaModelNamePlaceholder: 'qwen3:8b',
    ollamaDisplayName: 'Display Name (optional)',
    ollamaDisplayNameHint:
      'Custom name shown in the model list. Leave empty to use the model name.',
    ollamaDisplayNamePlaceholder: 'My Qwen3 Model',
    ollamaModelNameRequired: 'Model name is required',
    supportsImageInput: 'Supports image input',
    contextLength: 'Context Length',
    contextLengthHint: 'Context window size in tokens. Default is 200k.',
    maxTokens: 'Max Output Length',
    maxTokensHint: 'Maximum output tokens. Default is 32k.',
    imageInput: 'Image',
    modelSuffixSecure: '(Secure)',
    inputFileLabel: 'Input Files',
    imageVisionHint:
      'Image input is not enabled for the current model. Images will be sent as file paths. If the model supports vision, you can enable image input in the model configuration.',
    noModelsAvailable: 'No models available',
    addFirstModel: 'Add First Model',
    testConnection: 'Test Connection',
    connectionTestResult: 'Connection Test Result',
    testing: 'Testing...',
    connectionSuccess: 'Connection successful',
    connectionFailed: 'Connection failed',
    testRequestUrl: 'Request URL',
    testModel: 'Test model',
    testStatus: 'Status',
    testResponse: 'Response',
    testError: 'Error log',
    noModelsConfigured: 'Please add a model first',
    addCustomProvider: '+ Add Custom',
    customBadge: 'Custom',
    customDisplayName: 'Display Name',
    customDisplayNamePlaceholder: 'Enter custom name...',
    deleteCustomProvider: 'Delete',
    confirmDeleteCustomProvider: 'Delete this custom model configuration?',
    import: 'Import',
    export: 'Export',
    importProvidersFailed: 'Failed to import providers',
    exportProvidersFailed: 'Failed to export providers',
    invalidProvidersFile: 'Invalid providers file',
    decryptProvidersFailed:
      'Failed to decrypt API key. Make sure the file was exported on this device.',
    decryptProvidersPartial:
      'Some keys could not be decrypted. Existing keys were kept or left blank.',

    // Password related
    password: 'Password',

    // Shortcuts
    keyboardShortcuts: 'Keyboard Shortcuts',
    shortcutNotSet: 'Not set',
    newChat: 'New Chat',
    search: 'Search Tasks',
    openSettings: 'Open Settings',
    sendMessageShortcut: 'Send Message',
    shortcutConflict: 'Shortcut "{0}" is already used by "{1}"',
    close: 'Close',
    previous: 'Previous',
    next: 'Next',
    ignoreCase: 'Ignore case',
    collapse: 'Collapse',
    expand: 'Expand',

    // Error Messages

    // Loading State
    loading: 'Loading...',

    // Sidebar
    conversations: 'Conversations',
    renameConversation: 'Rename',
    confirmDelete: 'Confirm Delete',
    searchConversations: 'Search tasks...',
    searchNoResults: 'No matching tasks',
    project: 'Project',

    // Chat Window
    sendMessage: 'Send Message',
    copyToClipboard: 'Copy to Clipboard',
    showCode: 'Show Mermaid source',
    renderDiagram: 'Render Mermaid diagram',
    mermaidRenderFailed: 'Failed to render Mermaid diagram',
    copied: 'Copied',
    yesterday: 'Yesterday',
    daysAgo: 'days ago',
    justNow: 'Just now',
    minutesAgo: 'minutes ago',
    hoursAgo: 'hours ago',
    thinking: 'Thinking...',
    showToolCalls: 'Show tool calls',
    coworkSearchInSession: 'Search current session',
    coworkSearchInSessionPlaceholder: 'Search current session...',
    coworkSearchMatchCount: '{current}/{total}, {total} total',
    reasoning: 'Reasoning',

    // Model Selection

    // Error Messages
    apiKeyRequired: 'API Key Required',
    configureApiKey: 'Please configure your API key in settings',

    // Initialization
    initializationError: 'Failed to initialize application. Please check your configuration.',

    // JustDo
    cowork: 'JustDo',
    coworkHistory: 'Recent Chats',
    groupedSessions: 'Groups',
    coworkNoSessions: 'No chats yet',

    // Session Groups
    rename: 'Rename',
    createGroup: 'New Group',
    groupName: 'Group Name',
    groupNamePlaceholder: 'Enter group name',
    groupColor: 'Group Color',
    moveToGroup: 'Move to Group',
    ungrouped: 'Ungrouped',
    deleteGroup: 'Delete Group',
    deleteGroupConfirm: 'Are you sure you want to delete this group?',
    deleteGroupNote: 'Sessions in this group will become ungrouped',
    changeColor: 'Change Color',
    moveUp: 'Move Up',
    moveDown: 'Move Down',

    refresh: 'Refresh',
    coworkPlaceholder: 'Assign a task or ask any question',
    coworkModelSettingsRequired: 'Please configure models and API keys in Model Settings first.',
    modelGroupServer: 'Plan Models',
    modelGroupUser: 'Custom Models',
    modelSelectorNoModels: 'Please configure models in settings first',
    coworkAgentEngine: 'Agent Engine',
    coworkAgentEngineOpenClaw: 'OpenClaw (Default)',
    coworkAgentEngineOpenClawHint: 'Personal AI assistant',
    coworkAgentEngineClaudeLegacy: 'Cowork',
    coworkAgentEngineClaudeLegacyHint:
      'Built-in engine, ready out of the box, recommended for daily tasks.',
    coworkOpenClawInstall: 'Start OpenClaw',
    coworkOpenClawStart: 'Start OpenClaw',
    coworkOpenClawInstalling: 'Starting OpenClaw...',
    coworkOpenClawInstallHint:
      'OpenClaw runtime is bundled. Switching to this engine or starting a task will auto-start the gateway.',
    coworkOpenClawRestartGateway: 'Restart Gateway',
    coworkOpenClawNotInstalledNotice:
      'Bundled OpenClaw runtime (cfmind) was not found. Build the runtime before packaging.',
    coworkOpenClawReadyNotice:
      'OpenClaw runtime is ready. The gateway will auto-start when you run a task.',
    coworkOpenClawStarting: 'AI engine is starting the gateway...',
    coworkOpenClawRunning: 'AI engine is ready.',
    coworkOpenClawError: 'OpenClaw gateway failed to become healthy in time.',
    openclawGatewayPortTitle: 'Gateway Port',
    openclawGatewayPortHint:
      'Gateway service port for the built-in OpenClaw. Modify if it conflicts with other OpenClaw installations.',
    coworkConfigSaveFailed: 'Failed to save JustDo settings. Please try again.',
    coworkStatusIdle: 'Idle',
    coworkStatusRunning: 'Running',
    coworkStatusCompleted: 'Completed',
    coworkStatusError: 'Error',
    coworkPermissionRequired: 'Permission Required',
    coworkPermissionDescription: 'JustDo is requesting to perform the following action',
    coworkSelectionRequired: 'Please Choose',
    coworkSelectionDescription: 'JustDo needs your input',
    coworkToolName: 'Tool Name',
    coworkToolInput: 'Tool Input',
    coworkToolResult: 'Result',
    coworkToolRunning: 'Running...',
    coworkToolTimelineSummaryLabel: 'tools',
    coworkDestructiveOperation:
      'Destructive operation: This command may cause irreversible data loss. Please confirm carefully.',
    coworkCautionOperation:
      'Caution: This command may modify files or system state. Please review carefully.',
    dangerReasonRecursiveDelete: 'Recursive file deletion',
    dangerReasonGitForcePush: 'Git force push',
    dangerReasonGitResetHard: 'Git hard reset',
    dangerReasonDiskOverwrite: 'Disk write operation',
    dangerReasonDiskFormat: 'Disk format',
    dangerReasonFileDelete: 'File deletion',
    dangerReasonGitPush: 'Git push',
    dangerReasonProcessKill: 'Process termination',
    dangerReasonPermissionChange: 'File permission change',
    coworkApprove: 'Approve',
    coworkDeny: 'Deny',
    coworkConfirmSelection: 'Submit selection',
    coworkDenyRequest: 'Deny request',
    coworkQuestionWizardTitle: 'Confirmation Needed',
    coworkQuestionWizardSkip: 'Skip',
    coworkQuestionWizardPrevious: 'Previous',
    coworkQuestionWizardNext: 'Next',
    coworkQuestionWizardSubmit: 'Submit',
    coworkQuestionWizardOther: 'Other',
    coworkQuestionWizardOtherPlaceholder: 'Enter custom answer...',
    coworkQuestionWizardAnswerRequired: 'Please select or enter an answer',
    coworkContextUsageFullLabel: 'Context used / total context',
    coworkWelcome: 'Start Collaborating',
    coworkDescription: 'A 24/7 hardware-focused personal assistant agent',
    openChatWeb: 'Open ChatWeb',
    chatWebTokenError: 'Unable to get access token, please try restarting the AI engine',
    chatWebPortError: 'Unable to get service port',

    // Multi-Agent management
    createAgent: 'Create Agent',
    myAgents: 'Agent Management',
    agentSettings: 'Agent Settings',
    agentName: 'Name',
    agentNamePlaceholder: 'Agent name',
    emojiPickerTitle: 'Choose icon',
    emojiCustomInput: 'Or type an emoji',
    agentDescription: 'Description',
    agentDescriptionPlaceholder: 'Brief description',
    agentIdentity: 'Identity',
    agentIdentityPlaceholder: 'Identity description (IDENTITY.md)...',
    agentDefaultModel: 'Agent Default Model',
    agentModelOpenClawOnly: 'This setting only applies to the OpenClaw engine',
    agentModelInvalidHint:
      'The model bound to this Agent is no longer available. Please choose a valid model for this Agent first',
    agentSkills: 'Skills',
    agentSkillsHint:
      'Select skills available to this Agent. Leave empty to use all enabled skills.',
    agentSkillsSearch: 'Search skills...',
    agentsSubtitle: 'Custom personas and skill sets for your AI agents',
    presetAgents: 'Preset Agents',
    myCustomAgents: 'My Custom Agents',
    createNewAgent: 'New Agent',
    addAgent: 'Add',
    agentTabBasic: 'Basic Info',
    agentTabSkills: 'Skills',
    agentIMBoundToOther: '→ {agent}',
    agentCreateFailed: 'Failed to create Agent',
    agentSaveFailed: 'Failed to save Agent settings',
    agentDeleteConfirmTitle: 'Confirm Delete Agent',
    agentDeleteConfirmMessage:
      'Are you sure you want to delete Agent "{name}"? This action cannot be undone.',
    agentUnsavedTitle: 'Unsaved Changes',
    agentUnsavedMessage: 'You have unsaved changes. Are you sure you want to discard them?',
    discard: 'Discard',
    creating: 'Creating...',

    coworkNewSession: 'New Session',
    coworkContinuePlaceholder: 'Continue the conversation...',
    aiGeneratedDisclaimer: 'Content generated by AI, for reference only.',
    coworkAddFile: 'Add File',
    slashCommandButton: 'Slash commands',
    slashCommandShowMore: 'Show {count} more commands',
    slashCommandOptionsCount: '{count} options',
    coworkDropFileHint: 'Drop files here, or paste files directly',
    coworkAttachmentRemove: 'Remove',
    coworkOpenAttachment: 'Open attachment',
    // Context menu
    contextMenuCut: 'Cut',
    contextMenuCopy: 'Copy',
    contextMenuPaste: 'Paste',
    contextMenuSelectAll: 'Select All',
    deleteSession: 'Delete Conversation',
    subagents: 'Subagents',
    subagentEmpty: 'No subagents in this session',
    subagentShowInfo: 'View details',
    subagentInfoStatus: 'Status',
    subagentInfoTask: 'Task',
    subagentInfoModel: 'Model',
    subagentInfoRuntime: 'Runtime',
    subagentInfoStarted: 'Started',
    subagentInfoEnded: 'Ended',
    subagentInfoTokens: 'Token usage',
    subagentInfoSession: 'Session',
    subagentInfoUnavailable: 'Unavailable',
    subagentDrawerTitle: 'Subagent: {title}',
    subagentDrawerResize: 'Resize subagent panel',
    subagentMessages: 'Subagent messages',
    subagentMessagesEmpty: 'No subagent messages yet',
    subagentMessagesLoadFailed: 'Failed to load subagent messages',
    deleteTaskConfirmTitle: 'Confirm Deletion',
    deleteTaskConfirmMessage:
      'This action cannot be undone. All messages in this conversation will be permanently deleted.',
    batchOperations: 'Batch Operations',
    batchSelectAll: 'Select All',
    batchDelete: 'Delete',
    batchCancel: 'Cancel',
    batchDeleteConfirmTitle: 'Confirm Batch Deletion',
    batchDeleteConfirmMessage:
      'Are you sure you want to delete {count} selected tasks? This action cannot be undone.',
    back: 'Back',
    browse: 'Browse',
    addFolder: 'Select Workspace',
    recentFolders: 'Recent Folders',
    noFolderSelected: 'No folder selected',
    coworkSelectFolderFirst: 'Please select a task folder before submitting',
    noRecentFolders: 'No recent folders',
    folderDriveRootNotAllowed:
      'Drive root directories are not supported as working directories. Please select a subfolder (e.g. D:\\Projects).',
    coworkOpenFolder: 'Open folder',
    coworkOpenFolderFailed: 'Failed to open folder',

    // Cowork error messages
    coworkErrorSessionStartFailed: 'Failed to start session: {error}',
    coworkErrorSessionContinueFailed: 'Failed to send message: {error}',
    coworkErrorEngineNotReady: 'AI engine is starting up. Please wait a few seconds and try again.',

    // Skills
    skills: 'Skills',
    searchSkills: 'Search skills',
    manageSkills: 'Manage Skills',
    addSkill: 'Add',
    noSkillsAvailable: 'No skills available',
    skillsDescription: 'Pre-packaged best practices and tools for your AI agent',
    skillsDescriptionGateway: 'Manage the skills and tools available to your agents',
    skillInstalled: 'Installed',
    skillGroupPriority: 'Priority {priority}',
    'skillGroup.workspace.label': 'Workspace skills',
    'skillGroup.workspace.description':
      'Used only in the current task folder and can override skills with the same name',
    'skillGroup.agents-project.label': 'Project agent skills',
    'skillGroup.agents-project.description': 'Shared by agents working within the current project',
    'skillGroup.agents-personal.label': 'Personal agent skills',
    'skillGroup.agents-personal.description':
      'Available to the current user across different projects',
    'skillGroup.managed.label': 'Managed skills',
    'skillGroup.managed.description': 'Installed or imported by you and available in every task',
    'skillGroup.openclaw-bundled.label': 'Bundled skills',
    'skillGroup.openclaw-bundled.description':
      'General-purpose skills included with the app; no installation required',
    'skillGroup.extra-dir.label': 'Extra directory skills',
    'skillGroup.extra-dir.description': 'Provided by extensions or third-party components',
    'skillGroup.unknown.label': 'Other skills',
    'skillGroup.unknown.description': 'Skills whose source layer is not recognized',
    skillMarketplace: 'Marketplace',
    skillMarketplaceComingSoon: 'Coming Soon',
    skillMarketplaceComingSoonDesc:
      'Skill marketplace is under development. You will be able to search and install more skills from ClawHub',
    skillInstall: 'Install',
    // Offline skill import
    importSkill: 'Import',
    importSkillProgress: 'Importing',
    importSkillTooltip: 'Import skill from local archive (ZIP, TGZ formats supported)',
    importSkillFolder: 'Import Folder',
    importSkillFolderProgress: 'Importing',
    importSkillFolderTooltip: 'Import skill from local folder (each folder contains a SKILL.md)',
    selectSkillArchive: 'Select skill archive',
    selectSkillFolder: 'Select skill folder',
    skillImportSuccess: 'Skill {skillId} imported successfully',
    skillImportFailed: 'Skill import failed',
    // Gateway offline
    gatewayOffline: 'Gateway Offline',
    gatewayOfflineSkillsUnavailable: 'Gateway is offline. Skills are temporarily unavailable',
    // Skill status
    missing: 'missing',
    missingBins: 'Missing tools',
    missingEnv: 'Missing env vars',
    skillMissingRequirements: 'Skill missing required dependencies',

    // Security scan
    securityIssuesFound: 'Please be aware of the following behaviors in {name}:',
    skillDetailVersion: 'Version',
    deleteSkill: 'Delete Skill',
    skillDeleteConfirm: 'Delete skill "{name}"?',
    skillDeleteFailed: 'Failed to delete skill',
    skillDeleteSuccess: 'Skill "{name}" deleted',
    skillBuiltInDeleteHint:
      'Built-in skills cannot be deleted via the app. Please delete the folder manually.',
    skillDeleteManualHint:
      'This skill cannot be deleted via the app. Please delete it manually in the opened folder.',
    skillUpdateFailed: 'Failed to update skill',
    activeSkill: 'Active Skill',
    clearSkill: 'Clear Skill',
    clearAll: 'Clear All',
    clearAllSkills: 'Clear all selected skills',

    // MCP Servers
    mcpServers: 'MCP',
    mcpDescription:
      "Configure and manage MCP (Model Context Protocol) servers to extend your agent's tool capabilities",
    searchMcpServers: 'Search MCP servers',
    addMcpServer: 'Custom',
    editMcpServer: 'Edit MCP Server',
    deleteMcpServer: 'Delete MCP Server',
    mcpServerName: 'Server Name',
    mcpServerNamePlaceholder: 'Enter server name',
    mcpServerDescription: 'Description',
    mcpServerDescriptionPlaceholder: 'Describe what this MCP server does',
    mcpTransportType: 'Transport Type',
    mcpCommand: 'Command',
    mcpCommandPlaceholder: 'e.g. node, npx, uvx, python',
    mcpArgs: 'Arguments',
    mcpArgsPlaceholder: 'One argument per line',
    mcpEnvVars: 'Environment Variables',
    mcpUrl: 'URL',
    mcpUrlPlaceholder: 'e.g. http://localhost:3000/mcp',
    mcpHeaders: 'HTTP Headers',
    mcpHeaderKey: 'Key',
    mcpHeaderValue: 'Value',
    mcpDeleteConfirm: 'Delete MCP server "{name}"?',
    mcpDeleteFailed: 'Failed to delete MCP server',
    mcpCreateFailed: 'Failed to create MCP server',
    mcpUpdateFailed: 'Failed to update MCP server',
    mcpBridgeSyncing: 'Syncing MCP tools...',
    mcpBridgeSyncDone: 'MCP tools synced',
    mcpBridgeSyncError: 'Sync failed',
    mcpNameRequired: 'Server name is required',
    mcpCommandRequired: 'Command is required for stdio transport',
    mcpUrlRequired: 'URL is required for SSE/HTTP transport',
    mcpNameExists: 'Server name already exists',
    mcpTransportStdio: 'Standard I/O (stdio)',
    mcpTransportSse: 'Server-Sent Events (SSE)',
    mcpTransportHttp: 'Streamable HTTP',
    addKeyValue: 'Add',
    saveMcpServer: 'Save',
    // MCP Marketplace & Registry
    mcpInstalled: 'Installed',
    mcpMarketplace: 'Marketplace',
    mcpMarketplaceComingSoon: 'Coming Soon',
    mcpCustom: 'Custom',
    mcpInstall: 'Install',
    mcpRequiredConfig: 'Required Configuration',
    mcpEnvRequired: 'This field is required',
    mcpNoInstalledServers: 'No MCP servers installed yet',
    mcpCategoryAll: 'All',
    mcpCategorySearch: 'Search',
    mcpCategoryBrowser: 'Browser',
    mcpCategoryDeveloper: 'Dev Tools',
    mcpCategoryProductivity: 'Productivity',
    mcpCategoryDesign: 'Design',
    mcpCategoryDataApi: 'Data & API',
    mcpDesc_tavily: 'Real-time web search, intelligent data extraction and web crawling',
    mcpDesc_github: 'GitHub platform integration: repos, issues, PRs, Actions management',
    mcpDesc_gitlab: 'GitLab API integration: project management, merge requests, pipelines',
    mcpDesc_context7: 'Up-to-date library documentation and code examples for AI coding',
    mcpDesc_google_drive:
      'Google Drive file access and search with auto-export for Workspace files',
    mcpDesc_gmail: 'Gmail management: read, send, search emails with auto authentication',
    mcpDesc_google_calendar: 'Google Calendar management: create, query, update calendar events',
    mcpDesc_notion: 'Notion API: search, create/update pages, manage databases',
    mcpDesc_slack: 'Slack workspace: channel management, messaging, user queries',
    mcpDesc_todoist: 'Task management: create, update, complete and organize to-do items',
    mcpDesc_playwright: 'Advanced browser automation supporting Chromium/Firefox/WebKit',
    mcpDesc_canva: 'Canva design platform: create and manage designs, template operations',
    mcpDesc_firecrawl:
      'Web scraping and data extraction: batch processing, structured extraction and content analysis',

    // File operations
    openFolder: 'Open Folder',
    showInFolder: 'Show in Folder',
    showInFolderFailed: 'Failed to show file in folder',

    // IM Bot
    imBot: 'IM Bot',
    imComingSoon: 'Coming Soon',
    imComingSoonDesc: 'IM Bot feature is under development. Stay tuned.',
    connected: 'Connected',
    disconnected: 'Disconnected',
    imAgentBinding: 'Responding Agent',
    imAgentBindingDefault: 'Default (main)',
    imAgentBindingHint:
      'Select the Agent that responds to messages on this platform. Different Agents have different personas and skill configurations.',
    kickedByOtherClient: 'Account logged in elsewhere',
    starting: 'Starting',
    start: 'Start',
    stop: 'Stop',
    messageType: 'Message Type',
    domain: 'Domain',
    // IM 平台域名选项将在集成后添加
    renderMode: 'Render Mode',
    textMode: 'Text',
    cardMode: 'Card',
    chatSettings: 'Chat Settings',
    enableSkills: 'Enable Skills',
    systemPrompt: 'System Prompt',
    systemPromptPlaceholder: 'Set custom instructions for IM bot...',
    saveConfig: 'Save Config',
    imConnectivitySectionTitle: 'Connectivity Diagnostics',
    imConnectivityTest: 'Test Connectivity',
    imConnectivityRetest: 'Retest',
    imConnectivityTesting: 'Testing...',
    imConnectivityNoResult: 'No diagnostics yet. Test after enabling the gateway.',
    imConnectivityLastChecked: 'Last checked',
    imConnectivitySuggestion: 'Suggestion',
    imConnectivityVerdict_pass: 'Ready',
    imConnectivityVerdict_warn: 'Attention Needed',
    imConnectivityVerdict_fail: 'Unavailable',
    imConnectivityCheckTitle_missing_credentials: 'Missing Credentials',
    imConnectivityCheckTitle_auth_check: 'Credential Authentication',
    imConnectivityCheckTitle_gateway_running: 'IM Channel Enablement',
    imConnectivityCheckTitle_inbound_activity: 'Inbound Message Activity',
    imConnectivityCheckTitle_outbound_activity: 'Outbound Message Activity',
    imConnectivityCheckTitle_platform_last_error: 'Recent Platform Error',
    // IM 平台特定检查项将在集成后添加
    imConnectivityCheckSuggestion_missing_credentials: 'Fill required credentials and test again.',
    imConnectivityCheckSuggestion_auth_check:
      'Verify credentials, permissions, and app release status.',
    imConnectivityCheckSuggestion_gateway_running:
      'If disabled, click the IM channel pill to enable it, then verify platform endpoints are reachable.',
    imConnectivityCheckSuggestion_inbound_activity:
      'Send a test message to the bot; mention it in group chats.',
    imConnectivityCheckSuggestion_outbound_activity:
      'Check bot send permissions and conversation reply scope.',
    imConnectivityCheckSuggestion_platform_last_error:
      'Fix the reported error and run diagnostics again.',
    // IM 平台特定建议将在集成后添加
    // IM 平台配置指南将在集成后添加

    // IM settings page i18n
    imAdvancedSettings: 'Advanced Settings',
    imPairingApproval: 'Pairing Code Approval',
    imPairingCodePlaceholder: 'Enter pairing code',
    imPairingApprove: 'Approve',
    imPairingCodeApproved: 'Pairing code {code} approved',
    imPairingCodeInvalid: 'Invalid or expired pairing code',
    imDebugMode: 'Debug Mode',
    imSessionTimeout: 'Session Timeout (min, deprecated)',
    imSeparateSessionByConversation: 'Separate Session by Conversation',
    imSeparateSessionByConversationDesc:
      'Maintain independent sessions for DMs, groups, and different groups',
    imGroupSessionScope: 'Group Session Scope',
    imGroupSessionScopeGroup: 'Shared in group',
    imGroupSessionScopeGroupSender: 'Per user in group',
    imSharedMemoryAcrossConversations: 'Share Memory Across Conversations',
    imSharedMemoryAcrossConversationsDesc:
      'Share memory across different conversations (isolated by default)',
    imGatewayBaseUrl: 'Custom Gateway URL',
    imGatewayBaseUrlPlaceholder: 'e.g. https://proxy.example.com',
    imSendThinkingMessage: 'Send "thinking" message',
    imDmPolicyOpen: 'Open',
    imDmPolicyPairing: 'Pairing',
    imDmPolicyAllowlist: 'Allowlist',
    imDmPolicyDisabled: 'Disabled',
    imGroupPolicyOpen: 'Open',
    imGroupPolicyAllowlist: 'Allowlist',
    imGroupPolicyDisabled: 'Disabled',
    // IM 平台域名和配置选项将在集成后添加
    imReplyModeAuto: 'Auto',
    imReplyModeStatic: 'Static',
    imReplyModeStreaming: 'Streaming',
    // IM 平台特定流式输出配置将在集成后添加
    // IM 平台特定用户ID占位符将在集成后添加
    imInstanceFillCredentials: 'Please fill in required credentials first',
    // IM 平台多实例管理将在集成后添加
    imViewGuide: 'Setup Manual',
    // IM 平台配置指南将在集成后添加

    // General Settings
    autoLaunch: 'Launch at Login',
    autoLaunchDescription: 'Automatically start the app when you log in',
    useSystemProxy: 'Use System Proxy',
    useSystemProxyDescription:
      'When enabled, network requests follow system proxy settings (applies after Save)',
    preventSleep: 'Prevent Sleep',
    preventSleepDescription: 'Prevent the system from sleeping while the app is running',

    // Scheduled Tasks
    scheduledTasks: 'Scheduled Tasks',
    plugins: 'Plugins',
    extensions: 'Extensions',
    extensionsComingSoon: 'Extensions are coming soon',
    scheduledTasksFormScheduleModeAt: 'At',
    scheduledTasksFormWeekSun: 'Sunday',
    scheduledTasksFormWeekMon: 'Monday',
    scheduledTasksFormWeekTue: 'Tuesday',
    scheduledTasksFormWeekWed: 'Wednesday',
    scheduledTasksFormWeekThu: 'Thursday',
    scheduledTasksFormWeekFri: 'Friday',
    scheduledTasksFormWeekSat: 'Saturday',
    scheduledTasksFormInterval: 'Interval',
    scheduledTasksFormIntervalMinutes: 'minutes',
    scheduledTasksFormIntervalHours: 'hours',
    scheduledTasksFormIntervalDays: 'days',
    scheduledTasksFormPayloadKind: 'Payload',
    scheduledTasksFormPayloadKindSystemEvent: 'System event',
    scheduledTasksFormPayloadKindAgentTurn: 'Agent turn',
    scheduledTasksDelete: 'Delete',
    scheduledTasksDeleteConfirm:
      'Are you sure you want to delete task "{name}"? This cannot be undone.',
    scheduledTasksSchedule: 'Plan',
    scheduledTasksStatus: 'Status',
    scheduledTasksNoRuns: 'No runs yet',
    scheduledTasksLoadMore: 'Load More',
    scheduledTasksViewSession: 'View Session',
    scheduledTasksSessionNotSynced: 'Failed to sync session. Please try again later.',
    scheduledTasksSessionSyncing: 'Syncing session...',
    scheduledTasksSessionRetry: 'Retry',
    scheduledTasksStatusSuccess: 'Success',
    scheduledTasksStatusError: 'Failed',
    scheduledTasksStatusSkipped: 'Skipped',
    scheduledTasksStatusRunning: 'Running',
    scheduledTasksStatusIdle: 'Idle',
    scheduledTasksScheduleEvery: 'Every',
    scheduledTasksCronEveryDay: 'Every day',
    scheduledTasksCronEveryNMinutes: 'Every {n} minutes',
    scheduledTasksCronEveryMinute: 'Every minute',
    scheduledTasksCronEveryNHours: 'Every {n} hours',
    scheduledTasksCronEveryHour: 'Every hour',
    scheduledTasksCronWeekdays: 'Weekdays',
    scheduledTasksCronWeekends: 'Weekends',
    scheduledTasksCronEveryWeek: 'Every',
    scheduledTasksCronEveryMonth: 'Monthly',
    scheduledTasksCronAtTime: '{schedule} at {time}',
    scheduledTasksCronAtMonthDay: '{schedule} on the {day}th at {time}',
    scheduledTasksCronEveryHourAtMinute: 'Every hour at minute {min}',
    // IM 平台通知选项将在集成后添加
    scheduledTasksFormDeliveryMode: 'Delivery',
    scheduledTasksFormDeliveryModeNone: 'None',
    scheduledTasksFormDeliveryModeAnnounce: 'Announce summary',
    scheduledTasksFormDeliveryModeWebhook: 'Webhook',
    scheduledTasksDataAnomalyWarning:
      'Scheduled task "{name}" has abnormal data. Display has been auto-corrected. Consider re-editing this task',

    copy: 'Copy',

    // TaskForm unsaved changes confirmation
    // Cron UI (new card-based design)
    cronTitle: 'Scheduled Tasks',
    cronSubtitle: 'Automate AI workflows with scheduled tasks',
    cronNewTask: 'New Task',
    cronRefresh: 'Refresh',
    cronStatsTotal: 'Total Tasks',
    cronStatsActive: 'Active',
    cronStatsPaused: 'Paused',
    cronStatsFailed: 'Failed',
    cronEmptyTitle: 'No scheduled tasks',
    cronEmptyDescription:
      'Create scheduled tasks to automate AI workflows. Tasks can send messages, run queries, or perform actions at specified times.',
    cronEmptyCreate: 'Create Your First Task',
    cronCardRunNow: 'Run Now',
    cronCardLast: 'Last',
    cronCardNext: 'Next',
    cronCardHistory: 'Run History',
    cronDialogCreateTitle: 'Create Task',
    cronDialogEditTitle: 'Edit Task',
    cronDialogTaskName: 'Task Name',
    cronDialogTaskNamePlaceholder: 'e.g., Morning briefing',
    cronDialogMessage: 'Message / Prompt',
    cronDialogMessagePlaceholder:
      "What should the AI do? e.g., Give me a summary of today's news and weather",
    cronDialogAgent: 'Agent',
    cronDialogSchedule: 'Schedule',
    cronDialogScheduleModeRecurring: 'Recurring',
    cronDialogScheduleModeOnce: 'Once',
    cronDialogRecurrenceHourly: 'Hourly',
    cronDialogRecurrenceDaily: 'Daily',
    cronDialogRecurrenceWeekdays: 'Weekdays',
    cronDialogRecurrenceWeekly: 'Weekly',
    cronDialogRecurrenceCustom: 'Custom',
    cronDialogTimeLabel: 'Time',
    cronDialogDateLabel: 'Date',
    cronDialogWeekdayLabel: 'Day of week',
    cronDialogMinuteLabel: 'Minute of each hour',
    cronDialogCronPlaceholder: 'Cron expression (e.g., 0 9 * * *)',
    cronDialogEnableImmediately: 'Enable immediately',
    cronDialogEnableImmediatelyDesc: 'Start running this task after creation',
    cronDialogSaveChanges: 'Save Changes',
    cronDialogDeliveryTitle: 'Delivery',
    cronDialogDeliveryDescription:
      'Choose whether this task stays in-app or is pushed to an external channel.',
    cronDialogDeliveryModeNone: 'In-app only',
    cronDialogDeliveryModeNoneDesc: 'Run the task and keep the result in the app.',
    cronDialogDeliveryModeAnnounce: 'External channel',
    cronDialogDeliveryModeAnnounceDesc: 'Send the final result through a configured channel.',
    cronDialogSelectChannel: 'Select a channel',
    cronToastCreated: 'Task created',
    cronToastUpdated: 'Task updated',
    cronToastEnabled: 'Task enabled',
    cronToastPaused: 'Task paused',
    cronToastDeleted: 'Task deleted',
    cronToastTriggered: 'Task triggered successfully',
    cronToastFailedTrigger: 'Failed to trigger task',
    cronToastFailedUpdate: 'Failed to update task',
    cronToastFailedDelete: 'Failed to delete task',
    cronToastNameRequired: 'Please enter a task name',
    cronToastMessageRequired: 'Please enter a message',
    cronToastScheduleRequired: 'Please select or enter a schedule',
    cronToastSchedulePast: 'The selected time is in the past. Please choose a future time.',
  },
};

class I18nService {
  private currentLanguage: LanguageType = 'zh';
  private listeners = new Set<() => void>();

  constructor() {
    // 默认使用中文
    this.currentLanguage = 'zh';
  }

  // 初始化语言设置
  async initialize(): Promise<void> {
    try {
      const config = configService.getConfig();

      // 检查是否已经初始化过语言设置
      const languageInitialized = config.language_initialized;

      if (languageInitialized !== true) {
        // 可能是首次启动或旧版本用户升级
        // 为了保护旧用户的语言设置,检查是否有非默认的语言配置
        const hasCustomLanguage = config.language && config.language !== 'zh';

        if (hasCustomLanguage) {
          // 旧用户已手动设置过语言(非默认值),保留他们的设置
          console.log(`[i18n] Legacy user detected with custom language: ${config.language}`);
          this.currentLanguage = config.language;
          configService.updateConfig({
            ...config,
            language_initialized: true,
          });
        } else {
          // 新用户或使用默认中文的旧用户:检测系统语言
          try {
            const systemLocale = await window.electron.appInfo.getSystemLocale();
            const defaultLanguage = this.inferLanguageFromLocale(systemLocale);

            console.log(
              `[i18n] First run detected. System locale: ${systemLocale}, default language: ${defaultLanguage}`,
            );

            this.currentLanguage = defaultLanguage;

            // 保存语言配置和初始化标记
            configService.updateConfig({
              ...config,
              language: defaultLanguage,
              language_initialized: true,
            });
          } catch (error) {
            console.error('Failed to get system locale:', error);
            // 如果获取系统语言失败,默认使用英文
            this.currentLanguage = 'en';
            configService.updateConfig({
              ...config,
              language: 'en',
              language_initialized: true,
            });
          }
        }
      } else {
        // 非首次启动:使用已保存的语言配置
        if (config.language && (config.language === 'zh' || config.language === 'en')) {
          this.currentLanguage = config.language;
        } else {
          // 如果配置无效,fallback 到英文
          this.currentLanguage = 'en';
          configService.updateConfig({
            ...config,
            language: 'en',
          });
        }
      }
    } catch (error) {
      console.error('Failed to initialize language:', error);
      // 默认使用英文
      this.currentLanguage = 'en';
    }
  }

  // 根据系统语言推断应用语言
  private inferLanguageFromLocale(systemLocale: string): LanguageType {
    // 只有 zh-CN (简体中文) 才使用中文,其他所有情况都使用英文
    if (systemLocale === 'zh-CN') {
      return 'zh';
    }
    return 'en'; // 默认英文 (包括 zh-TW, zh-HK, en-*, 以及其他所有语言)
  }

  // 设置语言
  setLanguage(language: LanguageType, options: { persist?: boolean } = {}): void {
    const { persist = true } = options;
    const hasChanged = this.currentLanguage !== language;
    this.currentLanguage = language;

    if (hasChanged) {
      this.listeners.forEach(listener => listener());
    }

    if (!persist) {
      return;
    }

    // 更新配置
    try {
      const config = configService.getConfig();
      configService.updateConfig({
        ...config,
        language,
      });
    } catch (error) {
      console.error('Failed to save language setting:', error);
    }
  }

  // 获取当前语言
  getLanguage(): LanguageType {
    return this.currentLanguage;
  }

  // 获取翻译文本
  t(key: string): string {
    const translation = translations[this.currentLanguage][key];
    if (!translation) {
      console.warn(`Translation missing for key: ${key} in language: ${this.currentLanguage}`);
      // 尝试从另一种语言获取
      const fallbackTranslation = translations[this.currentLanguage === 'zh' ? 'en' : 'zh'][key];
      return fallbackTranslation || key;
    }
    return translation;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const i18nService = new I18nService();
