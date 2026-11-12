import { appPluginTranslations } from '../../shared/plugins/app/appPluginTranslations';
/**
 * Lightweight i18n module for the Electron main process.
 *
 * Mirrors the renderer's i18nService pattern but runs in Node (no DOM/window).
 * Keeps only the small subset of keys needed by main-process code.
 *
 * Usage:
 *   import { t, setLanguage } from './i18n';
 *   setLanguage('en');
 *   const label = t('trayStartConversation'); // "Start Conversation"
 */
import { PRODUCT_NAME } from '../../shared/productMetadata';
import { browserTranslations } from '../browser/browserTranslations';
import { startupWindowTranslations } from './window/startupWindowTranslations';

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    coworkReservedSession: '此会话仅用于内部存储，无法作为聊天打开。',
    ...startupWindowTranslations.zh,
    runtimeNodeUnavailable: '运行时尚未准备就绪，请重新准备或修复应用。',
    enginePreparationPending: 'AI 引擎正在启动，暂时无法发送。请在就绪后重新发送，草稿已保留。',
    enginePreparationFailed: 'AI 引擎未能完成启动准备，请查看原因或重试。',
    enginePreparationShuttingDown: '应用正在退出，无法确认本次 AI 引擎准备结果。请在下次打开应用后核对状态。',
    enginePreparationInitializationUnavailable: '应用初始化已失败，无法继续确认 AI 引擎准备结果。请查看当前启动错误，处理后重新打开应用。',
    enginePreparationSuperseded: '本次 AI 引擎准备已被新的准备操作替代，恢复结果尚未确认。请核对标题栏中的 AI 引擎状态，确认前不要重复提交原操作。',
    enginePreparationLifecycleChanged: '准备期间 AI 引擎的进程或运行代次发生变化，本次恢复结果尚未确认。请核对标题栏中的 AI 引擎状态，确认前不要重复提交原操作。',
    enginePreparationStopped: 'AI 引擎当前未运行，本次启动准备未完成。请核对标题栏中的 AI 引擎状态；若显示启动失败，点击“查看原因”。确认前不要重复提交原操作。',
    enginePreparationStillStarting: 'AI 引擎仍在启动或重启，本次准备结果尚未确认。请等待标题栏中的 AI 引擎状态更新；若显示启动失败，点击“查看原因”。确认前不要重复提交原操作。',
    enginePreparationUnconfirmed: '尚未确认 AI 引擎准备完成。请核对标题栏中的 AI 引擎状态；若显示启动失败，点击“查看原因”。确认前不要重复提交原操作。',
    gatewayShutdownUnconfirmed: '引擎未能正常关闭，请退出并重新启动应用。',
    gatewayStartupUnconfirmed: 'AI 引擎未能在时限内完成启动，请查看引擎状态与启动原因。',
    legacyWorkspaceSetupCleanupFailed: '无法清理工作区的历史初始化文件：{path}。请检查该路径及文件权限后重试。',
    externalAgentModel: '模型',
    externalAgentNewSession: '新对话',
    externalAgentImageSession: '图片对话',
    externalAgentAllowOnce: '允许一次',
    externalAgentReject: '拒绝',
    externalAgentToolPermission: '工具权限',
    appServerAllowApp: '始终允许此 App',
    appServerAllowAppDescription: '持久授予此 App 当前申请的权限，后续匹配调用将使用该授权。可在 App 权限设置中管理。',
    appServerImageModelUnsupported: '当前模型未声明图片输入能力，请选择支持图片的模型后重试。',
    appServerImageModelChanged: '图片准备期间会话或模型发生变化，本次消息尚未发送，请重新确认模型后重试。',
    externalAgentTool: '工具',
    externalAgentTaskCancelled: '任务已取消。',
    mcpAppsContextPrepareFailed: '图表内容暂时无法同步，请检查应用状态后重新发送。画布修改已保留。',
    localSpeechModelServerNotConfigured: '尚未配置内网语音模型服务，请联系管理员配置后再安装模型。',
    localSpeechModelRangeIgnored: '模型服务未按请求返回文件分段，请联系管理员检查分段下载支持。',
    localSpeechModelRangeInvalid: '模型服务返回的文件分段与请求不符，请联系管理员检查模型服务。',
    coworkBranchCreationPending:
      '该副本或分支尚未完成创建。请在会话列表中检查或删除，暂时无法继续发送。',
    sessionWorkspaceChanged: '会话工作目录已发生变化，请核对后重新发送。草稿已保留。',
    ...appPluginTranslations.zh,
    computerOverlayActive: '正在操作电脑',
    computerOverlayWaiting: '电脑操作待续',
    windowMinimize: '最小化',
    windowMaximize: '最大化',
    windowRestore: '还原',
    windowClose: '关闭',
    coworkInitialDispatchUnavailable: '当前聊天窗口已失效，无法提交首条消息。',
    coworkInitialDispatchInvalid: '首条消息的提交身份无效。',
    coworkInitialDispatchUncertain: '首条消息的提交结果尚未确认，正在恢复原生状态。',
    coworkInitialDispatchFailed: '无法提交首条消息。',
    windowsSandboxSystemDriveInvalid: 'Windows 系统盘路径无效。',
    windowsSandboxPrepResultInvalid: '系统盘准备程序未返回有效结果。',
    windowsSandboxPrepExitCodeMissing: '提权后的系统盘准备程序未返回退出码。',
    windowsSandboxPrepHashReadFailed: '提权后无法读取沙盒准备工具以验证完整性。',
    windowsSandboxPrepHashMismatch: '提权后检测到沙盒准备工具的文件校验值不匹配。',
    windowsSandboxPrepSignatureReadFailed: '提权后无法验证沙盒准备工具的数字签名。',
    windowsSandboxPrepSignatureInvalid: '提权后检测到沙盒准备工具的数字签名无效。',
    windowsSandboxPrepSignerMismatch: '提权后检测到沙盒准备工具的签名证书不匹配。',
    windowsSandboxPrepHelperLaunchFailed: '提权后无法启动沙盒准备工具。',
    windowsSandboxPrepHelperFailed: '沙盒准备工具执行失败（退出码 {code}）。',
    windowsSandboxPrepUacCancelled: '已取消 Windows 权限确认，系统盘准备未执行。',
    windowsSandboxPrepFailed: '系统盘准备失败：{detail}',
    windowsSandboxPrepMetadataUnavailable:
      '准备工具已完成，但沙盒仍无法读取系统盘目录属性。请刷新沙盒状态重新检查。',
    worktreeSelectionInvalid: 'Worktree 选择无效。',
    worktreeCopyUnavailable:
      'Worktree 会话暂不支持复制或分叉。请在源项目中创建新的 Worktree 会话。',
    worktreeSharedWorkspaceDeleteBlocked:
      '其他会话仍在使用这个 Worktree，请先删除这些会话后再移除其所属会话。',
    worktreePermissionIdentityChanged: '权限同步时无法确认原 Worktree 会话，操作已停止。',
    worktreeCreateUnavailable: 'Worktree 创建服务暂不可用。',
    worktreeCreateUnconfirmed: '未能确认 Worktree 创建结果，请检查设置中的 Worktree 列表。',
    worktreeCleanupUnconfirmed:
      '上次 Worktree 清理结果尚未确认。再次检查只会查询原任务，不会重新提交清理。',
    worktreeCleanupUnavailable: '引擎尚未就绪，暂时无法清理 Worktree。',
    worktreeCleanupFailed: 'Worktree 清理未能完成。',
    worktreeIdentityMissing: '无法确认待清理的 Worktree 会话。',
    worktreeCancellationRetained:
      '取消任务后的工作目录未能清理，已保留会话入口。请在设置中检查 Worktree。',
    nativeVideoUrlInvalid:
      '视频服务地址无效，请使用不含登录信息、查询参数或片段的 HTTP 或 HTTPS 地址。',
    nativeVideoLegacyUnsupported:
      '请在设置的视频模型页面配置视频服务，此入口不支持直接写入 OpenAI 视频配置。',
    nativeVideoConfigurationInvalid: '视频模型配置无效，请检查服务商、模型、服务地址和 API Key。',
    decisionModelConfigurationInvalid:
      '决策模型配置未能生效，请检查供应商 URL、API Key、默认模型及凭据文件访问权限。',
    extensionCredentialStoreUnavailable: '无法读取本地扩展凭据文件，请检查文件内容和访问权限。',
    extensionPackageRecoveryFailed: '此外，运行环境恢复未完成。若标题栏（最小化、最大化按钮旁）的 AI 引擎状态显示失败，请点击“查看原因”按提示处理。',
    extensionInstallSavedRecoveryFailed: '插件安装已保存，但运行环境恢复失败。请核对插件状态，无需重复安装。',
    extensionAppCodeApprovalFailed: '插件已安装，但应用代码校验与信任登记未完成，暂不可用。请根据具体原因核对安装包；不要重复安装或手动启用。',
    extensionAppCodeIdentityMismatch: '已安装扩展的目录、身份或代码内容与本次安装不一致，已停止信任登记。请核对安装包是否被替换或修改。',
    extensionAppCodeTrustUnavailable: '无法写入应用扩展的代码信任记录，请检查应用数据目录的访问权限并联系管理员。',
    extensionInstallRecoveryPending: '插件已安装；AI 引擎恢复状态尚未确认。',
    extensionRemovalRecoveryPending: '插件已卸载；AI 引擎恢复状态尚未确认。',
    extensionRemovalSavedRecoveryFailed: '插件已卸载，但 AI 引擎未能恢复就绪。无需重复卸载。请查看标题栏（最小化、最大化按钮旁）的 AI 引擎状态；启动中请等待，失败时点击“查看原因”。',
    extensionRemovalPolicyCleanupFailed: '插件已卸载，但出站请求头策略未能同步。无需重复卸载。',
    extensionRemovalAllowlistCleanupFailed: '插件已卸载，但允许加载列表未能清理。无需重复卸载。',
    extensionRemovalConfirmationFailed: '卸载后的运行状态核对未完成，服务没有返回具体原因。',
    extensionUninstallReceiptInvalid: '卸载请求已发出，但 AI 引擎没有返回有效的卸载成功回执，无法确认最终结果。请在引擎就绪后核对插件清单，确认前不要重复卸载。',
    extensionCommandTimedOutUnconfirmed: '插件命令等待超时，未取得完整结果。若刚执行了安装、卸载或启停，请先核对插件状态，确认前不要重复提交。',
    extensionInstallMutationUnavailable: '安装尚未开始：未能取得插件文件变更保护。请等待当前插件操作完成后重试。',
    extensionFollowupFailureReasonUnavailable: '后续核对或恢复未能完成，服务没有返回具体原因。',
    extensionRemovalCommandCleanupFailed: '插件已卸载，但卸载命令未能正常结束。无需重复卸载。',
    extensionDataInspectionFailed: '无法读取插件数据大小。',
    extensionDataRemovalUnavailable: '当前无法安全清理插件数据，尚未开始卸载。请保留数据后卸载，或先检查数据目录。',
    extensionDataRemovalFailed: '插件已卸载，但插件数据未能全部清理。无需重复卸载。',
    networkPolicyInspectionFailed: '{location}中的网络策略校验失败：{reason}',
    networkPolicySource: '安装源',
    networkPolicyPreparedSource: '准备后的安装副本',
    networkPolicyInstalled: '已安装的扩展目录',
    networkPolicyFileInvalid: '{file}（{check}）：{reason}',
    networkPolicyFileBeforeOpen: '打开文件前检查',
    networkPolicyFileOpened: '打开文件后检查',
    networkPolicyFilePathRecheck: '文件路径复核',
    networkPolicyFileContent: '读取文件内容',
    networkPolicyFileSymbolicLink: '该文件是符号链接，不允许使用。',
    networkPolicyFileNotRegular: '该路径不是普通文件，可能是目录或其他文件类型。',
    networkPolicyFileTooLarge: '实际大小为 {bytes} 字节，超过 {limit} 字节（64 KiB）的上限。',
    networkPolicyFileIdentityMismatch: '文件标识与前一次检查不一致，无法确认读取的是同一个文件。',
    networkPolicyFileOutsideRoot: '文件的实际位置不在扩展根目录内。',
    networkPolicyInspectionReasonUnavailable: '未取得具体失败原因。',
    networkPolicyManifestJsonInvalid: '{file} 必须是有效的 JSON 文件。',
    networkPolicyManifestShapeInvalid: '策略文件必须包含 schemaVersion: 1 和 groups 数组。',
    networkPolicyGroupShapeInvalid: '策略文件第 {group} 组必须包含 baseUrlWhitelist 和 headerNames 数组。',
    networkPolicyHeaderInvalid: '{file} 第 {group} 组第 {header} 个请求头：{reason}',
    networkPolicyHeaderShapeInvalid: '请填写有效的请求头名称，或在对象中填写有效的 name，并在 from 和 value 中选择一项填写有效字符串。',
    networkPolicyHeaderForbidden: '扩展网络策略不允许设置此请求头。',
    networkPolicyUrlInvalid: '{file} 第 {group} 组第 {url} 个 URL：{reason} 请联系插件提供方核对并修正安装包中的这条地址声明。',
    networkPolicyUrlType: '地址必须是字符串。',
    networkPolicyUrlAbsolute: '地址必须是有效的绝对 URL。',
    networkPolicyUrlProtocol: '仅支持 HTTP 或 HTTPS 协议。',
    networkPolicyUrlCredentials: '地址不能包含用户名或密码。',
    networkPolicyUrlQuery: '地址不能包含查询部分（?）。',
    networkPolicyUrlFragment: '地址不能包含片段部分（#）。',
    networkPolicyUrlLocal: '不允许 localhost、本机回环、链路本地或未指定目标地址。',
    extensionEnableSavedFollowupFailed: '启用设置已保存，但后续状态确认失败。请刷新核对插件是否可用。',
    extensionDisableSavedFollowupFailed: '关闭设置已保存，但后续状态确认失败。请刷新核对插件状态。',
    extensionStateFollowupFailed: '此外，插件后续状态确认失败。',
    extensionCredentialInherited: '此凭据由系统环境变量提供，请修改该变量并重启应用。',
    extensionConfigurationNumberInvalid: '请输入范围内的有效数值。',
    extensionConfigurationTextInvalid: '配置文本不符合扩展要求，请检查必填项、长度和格式。',
    extensionCredentialStoreWriteFailed: '无法安全保存扩展凭据，请检查本地文件访问权限。',
    memoryWorkspaceUnavailable: '无法确定记忆工作区，请检查服务连接。',
    memoryStatusUnavailable: '无法读取记忆索引状态。',
    memoryRebuildUnverified: '索引未完成重建，或无法验证重建后的状态。',
    memoryRebuildDegraded: '索引命令已完成，但语义检索尚未确认可用，请检查索引状态。',

    sessionDiagnosticsExport: '导出会话诊断',
    selectedModelUnavailable: '所选模型已停用或移除，请重新选择可用模型。',
    selectedModelProviderNotReady: '所选模型的提供商尚未就绪，请检查配置和认证状态。',
    selectedModelRouteChanged: '所选模型的路由已变更，请重新选择模型。',
    sessionModelPreparationChanged: '模型准备期间连接或配置发生变化，请重试。',
    sessionModelConfigurationUnavailable: '无法读取模型配置，请稍后重试。',
    sessionModelIdentityChanged: '模型准备期间会话身份发生变化，操作已停止。',
    sessionModelPreparationUnconfirmed: '未能确认会话模型已生效，请重新选择模型后重试。',
    sessionStoragePreparationTimeout: '新会话仍在准备中，请稍后重新发送。',
    sessionStoragePreparationChanged: '准备期间会话或连接已变更，请重新发送。',
    extensionConversionNotImplemented: `该扩展不满足 ${PRODUCT_NAME} 的扩展格式。请使用包含 openclaw.plugin.json 和已编译运行入口的原生扩展包；其他插件格式不能直接导入。`,
    extensionImportSourceChanged: '安装源在准备期间发生变化，请重新选择安装包后重试。',
    extensionImportSourceUnsafe: '扩展安装源包含不受支持的链接或文件，无法安全准备安装副本。请联系插件提供方检查安装包。',
    extensionImportArchiveLayoutInvalid: '扩展压缩包的目录结构无法识别。请联系插件提供方检查安装包的根目录结构。',
    engineRestartUnconfirmed: '重启请求的结果尚未确认，未追加重启。请稍后查看引擎状态。',
    engineRestartReadyUnconfirmed: '引擎已接受重启，但尚未确认就绪。未追加重启，请稍后查看状态。',
    engineConfigApplicationUnconfirmed:
      '设置已保存，但重启请求的结果尚未确认。未追加重启，设置是否生效仍待确认。',
    modelDefaultConfigSyncFailed: '默认模型配置同步失败，请重试。',
    extensionCredentialRefreshUnconfirmed: '扩展凭据已保存，但尚未确认运行时刷新成功。',
    extensionRuntimeServiceFailed: '扩展服务启动失败，请查看运行时诊断。',
    extensionOperationBusy: '另一个插件或配置操作仍在处理中，请等待完成后再试。',
    extensionUninstallUnconfirmed: '扩展卸载结果尚未确认，请稍后刷新状态；未重复执行卸载。',
    extensionToggleUnconfirmed: '扩展开关结果尚未确认，请稍后刷新状态；未重复执行启停。',
    extensionHotToggleUnavailable: '暂时无法连接插件热更新服务，请恢复 Gateway 连接后再操作。',
    extensionCatalogUnavailable: 'Gateway 连接暂时不可用，插件列表将在连接恢复后刷新。',
    extensionHotToggleRestartRequired: '原生运行时未完成插件热更新；已保留配置，但未重启 Gateway。',
    extensionToggleRecoveryFailed: '扩展开关已保存，但 Gateway 恢复失败。',
    extensionNetworkPolicyRecoveryPending: '扩展开关已保存。请求头注入路由将在 Gateway 可安全重启时更新。',
    extensionInstallUnconfirmed: '原生运行时未确认扩展安装结果，请稍后刷新状态。',
    extensionInstallReceiptIncomplete:
      '扩展安装已保存，但 Gateway 运行态回执不完整，请刷新扩展状态。',
    extensionPackageOwnershipUnconfirmed: '暂时无法确认扩展包与原生条目的归属，请稍后刷新状态。',
    extensionSkillSyncFailed: '扩展开关已保存，但 插件技能同步未完成。请重试同一开关操作。',
    skillSettingApplyUnconfirmed: '技能设置已保存，暂时无法同步状态。',
    builtinModelAuthenticationUnavailable: '内置模型认证已失效，请等待登录凭据刷新。',
    credentialStorageUnavailable: '操作系统安全凭据存储不可用，无法安全保存内置凭据。',
    credentialDecryptionFailed: '无法使用当前操作系统账户解密应用凭据。',
    builtinCredentialTargetMismatch: '内置模型凭据只能用于指定的模型请求地址。',
    // Tray menu
    trayStartConversation: '发起对话',
    traySettings: '设置',
    trayRestart: '重启软件',
    trayQuit: '退出',
    attachmentMenuOpen: '打开',
    attachmentMenuOpenWithSystem: '使用系统工具打开',
    attachmentMenuShowInFolder: '打开所在的文件夹',
    filePreviewOpenWithFailed: '无法打开系统应用选择器，请重试。',
    imageMenuSaveAs: '图片另存为…',
    imagePreviewWindowTitle: '图片预览',
    imagePreviewUnavailable: '图片预览暂不可用，请重新打开主窗口后重试。',
    filePreviewConflictTitle: '文件已在外部修改',
    filePreviewConflictMessage: 'Agent 或其他程序在你编辑期间修改了此文件。',
    filePreviewConflictOverwrite: '覆盖文件',
    filePreviewConflictReload: '重新加载',
    filePreviewConflictCancel: '取消',
    skillInvalidName:
      'SKILL.md 的“name”必须为 1–64 个字符，可包含英文字母、数字、空格、连字符、下划线、圆括号和句点；不能以空格或句点开头或结尾。',
    skillWindowsReservedName: 'SKILL.md 的“name”不能使用 Windows 保留目录名“{name}”。',
    skillInvalidFrontmatter: 'SKILL.md 必须包含有效的 YAML frontmatter。',
    skillInvalidFrontmatterName: 'SKILL.md 必须包含有效的 YAML frontmatter 和“name”字段。',
    skillDirectoryResource: '技能目录',
    extensionDirectoryResource: '扩展目录',
    hookImportValidationFailed: 'Hook 文件在导入过程中发生变化，未能完成安装。请重新导入。',
    hookAlreadyInstalled: 'Hook "{hookId}" 已安装。请先删除，再导入替代版本。',
    managedDirectoryLockedBy:
      '{resource}：\n{path}\n\n占用程序：\n{processes}\n\n请关闭以上程序后重试。',
    managedDirectoryLockedUnknown:
      '{resource}：\n{path}\n\n目录操作失败，暂时无法确认是否存在程序占用。请稍后重试。\n\n错误详情：{detail}',
    managedDirectoryLockedByApp: `{resource}：\n{path}\n\n${PRODUCT_NAME} 仍在使用该目录，暂时无法完成操作。\n\n请稍后重试；若问题持续出现，请重启 ${PRODUCT_NAME}。`,
    managedDirectoryPermissionDenied:
      '无法访问{resource}：\n{path}\n\n请检查 Windows 所有者和权限后重试。\n\n详细信息：{detail}',
    managedDirectoryRuntimeBusy: 'Gateway 仍有活动任务，无法安全释放目录锁。请等待任务结束后重试。',
    managedDirectoryRuntimeRecoveryFailed: 'Gateway 恢复失败：{detail}',
    ...browserTranslations.zh,
  },
  en: {
    coworkReservedSession: 'This session is reserved for internal storage and cannot be opened as a chat.',
    enginePreparationPending: 'The AI engine is starting. Please send again when it is ready; your draft is preserved.',
    enginePreparationFailed: 'The AI engine could not finish preparing. View the reason or retry.',
    enginePreparationShuttingDown: 'The application is closing, so this AI engine preparation result could not be confirmed. Check its status after opening the application again.',
    enginePreparationInitializationUnavailable: 'Application initialization failed, so AI engine preparation cannot be confirmed. Review the current startup error and resolve it before reopening the application.',
    enginePreparationSuperseded: 'A newer preparation replaced this AI engine preparation, so its recovery result is unconfirmed. Check the AI engine status in the title bar before submitting the original operation again.',
    enginePreparationLifecycleChanged: 'The AI engine process or lifecycle changed during preparation, so this recovery result is unconfirmed. Check the AI engine status in the title bar before submitting the original operation again.',
    enginePreparationStopped: 'The AI engine is not running, and startup preparation did not complete. Check its status in the title bar; if startup failed, click “View reason”. Confirm the result before submitting the original operation again.',
    enginePreparationStillStarting: 'The AI engine is still starting or restarting, so this preparation result is unconfirmed. Wait for its title-bar status to update; if startup failed, click “View reason”. Confirm the result before submitting the original operation again.',
    enginePreparationUnconfirmed: 'AI engine preparation has not been confirmed. Check its status in the title bar; if startup failed, click “View reason”. Confirm the result before submitting the original operation again.',
    ...startupWindowTranslations.en,
    runtimeNodeUnavailable:
      'The execution runtime is unavailable. Prepare the runtime or repair the application.',
    gatewayShutdownUnconfirmed: 'The engine did not close cleanly. Quit and restart the application.',
    gatewayStartupUnconfirmed: 'The AI engine did not finish starting within the time limit. Check its status and startup reason.',
    legacyWorkspaceSetupCleanupFailed: 'Could not remove the legacy workspace setup file: {path}. Check the path and file permissions, then retry.',
    externalAgentModel: 'Model',
    externalAgentNewSession: 'New conversation',
    externalAgentImageSession: 'Image conversation',
    externalAgentAllowOnce: 'Allow once',
    externalAgentReject: 'Reject',
    externalAgentToolPermission: 'Tool permission',
    appServerAllowApp: 'Always allow this App',
    appServerAllowAppDescription: 'Persistently grant this App the requested permissions for later matching calls. Manage this grant in App permissions.',
    appServerImageModelUnsupported: 'The selected model does not advertise image input. Select a model that supports images and try again.',
    appServerImageModelChanged: 'The conversation or model changed while preparing the image. This message was not sent; check the selected model and try again.',
    externalAgentTool: 'Tool',
    externalAgentTaskCancelled: 'Task cancelled.',
    mcpAppsContextPrepareFailed:
      'Could not sync the diagram. Check the app and send again. Your edits are preserved.',
    localSpeechModelRangeIgnored:
      'The model server ignored the requested download range. Contact your administrator to check range support.',
    localSpeechModelRangeInvalid:
      'The model server returned an unexpected download range. Contact your administrator to check the model service.',
    localSpeechModelServerNotConfigured:
      'The internal speech model server is not configured. Contact your administrator before installing models.',
    coworkBranchCreationPending:
      'This copy or branch is unfinished. Inspect or delete it in the session list before continuing.',
    sessionWorkspaceChanged: 'The session’s working directory changed. Check it before sending again. Your draft was kept.',
    ...appPluginTranslations.en,
    computerOverlayActive: 'Operating your computer',
    computerOverlayWaiting: 'Between computer actions',
    windowMinimize: 'Minimize',
    windowMaximize: 'Maximize',
    windowRestore: 'Restore',
    windowClose: 'Close',
    coworkInitialDispatchUnavailable:
      'The chat window is no longer current. The first message was not submitted.',
    coworkInitialDispatchInvalid: 'The initial message has an invalid submission identity.',
    coworkInitialDispatchUncertain:
      'The first message submission is still unconfirmed. Recovering native state.',
    coworkInitialDispatchFailed: 'The first message could not be submitted.',
    windowsSandboxSystemDriveInvalid: 'The Windows system drive is invalid.',
    windowsSandboxPrepResultInvalid:
      'The MXC host preparation launcher did not return a valid result.',
    windowsSandboxPrepExitCodeMissing:
      'The elevated MXC host preparation process did not return an exit code.',
    windowsSandboxPrepHashReadFailed: 'The elevated process could not read the MXC helper hash.',
    windowsSandboxPrepHashMismatch: 'The elevated MXC helper hash does not match.',
    windowsSandboxPrepSignatureReadFailed:
      'The elevated process could not verify the MXC helper signature.',
    windowsSandboxPrepSignatureInvalid: 'The elevated MXC helper signature is not valid.',
    windowsSandboxPrepSignerMismatch: 'The elevated MXC helper signer certificate does not match.',
    windowsSandboxPrepHelperLaunchFailed:
      'The elevated process could not launch the MXC host preparation helper.',
    windowsSandboxPrepHelperFailed: 'MXC host preparation helper failed (exit code {code}).',
    windowsSandboxPrepUacCancelled:
      'Windows UAC approval was cancelled. System-drive preparation did not run.',
    windowsSandboxPrepFailed: 'MXC host preparation failed: {detail}',
    windowsSandboxPrepMetadataUnavailable:
      'The MXC helper completed, but the sandbox still cannot read system-drive metadata. Refresh the sandbox status to retry the check.',
    worktreeSelectionInvalid: 'Invalid Worktree selection.',
    worktreeCopyUnavailable:
      'Copying or forking Worktree conversations is not supported yet. Create a new Worktree conversation from the source project.',
    worktreeSharedWorkspaceDeleteBlocked:
      'Other conversations still use this Worktree. Delete those conversations before deleting its owning conversation.',
    worktreePermissionIdentityChanged:
      'Could not confirm the original Worktree conversation during permission synchronization. The operation was stopped.',
    worktreeCreateUnavailable: 'Worktree creation is currently unavailable.',
    worktreeCleanupUnconfirmed:
      'The previous Worktree cleanup is unconfirmed. Checking again only queries that task; it does not submit another cleanup.',
    worktreeCleanupUnavailable: 'The engine is not ready to clean up Worktrees.',
    worktreeCleanupFailed: 'Worktree cleanup could not finish.',
    worktreeCreateUnconfirmed:
      'Could not confirm Worktree creation. Check the Worktree list in Settings.',
    worktreeIdentityMissing: 'Could not identify the Worktree conversation to clean up.',
    worktreeCancellationRetained:
      'Could not clean up the cancelled task workspace. Its conversation was retained. Check Worktrees in Settings.',
    extensionCredentialInherited:
      'This credential is supplied by the system environment. Update that variable and restart the app.',
    extensionConfigurationNumberInvalid: 'Enter a valid number within the allowed range.',
    extensionConfigurationTextInvalid:
      'Check required text fields, length and format against the extension requirements.',
    nativeVideoUrlInvalid:
      'Invalid video service URL. Use an HTTP or HTTPS address without credentials, query parameters or fragments.',
    nativeVideoLegacyUnsupported:
      'Configure video services in Settings → Models → Video models. This entry point does not accept direct OpenAI video configuration.',
    nativeVideoConfigurationInvalid:
      'Invalid video configuration. Check the provider, model, service URL and API key.',
    decisionModelConfigurationInvalid:
      'Unable to apply decision model configuration. Check the provider URL, API Key, default model and credential file access.',
    extensionPackageRecoveryFailed: 'Runtime recovery also did not complete. If the AI engine status in the title bar, beside the minimize and maximize buttons, shows a failure, select “View reason” and follow its instructions.',
    extensionInstallSavedRecoveryFailed: 'Plugin installation was saved, but the runtime environment failed to recover. Check the plugin status; do not repeat installation.',
    extensionAppCodeApprovalFailed: 'The plugin was installed, but app code validation and trust registration did not complete, so it is not available yet. Check the package using the specific reason; do not reinstall or enable it manually.',
    extensionAppCodeIdentityMismatch: 'The installed extension path, identity, or code differs from this installation, so trust registration stopped. Check whether the package was replaced or modified.',
    extensionAppCodeTrustUnavailable: 'Unable to write the app extension code trust receipt. Check access to the application data directory and contact your administrator.',
    extensionInstallRecoveryPending: 'The plugin was installed; AI engine recovery is not yet confirmed.',
    extensionRemovalRecoveryPending: 'The plugin was uninstalled; AI engine recovery is not yet confirmed.',
    extensionRemovalSavedRecoveryFailed: 'The plugin was uninstalled, but the AI engine did not become ready again. Do not repeat removal. Check its title-bar status beside the minimize and maximize buttons; wait while it starts, or select “View reason” if it failed.',
    extensionRemovalPolicyCleanupFailed: 'The plugin was uninstalled, but the outbound request-header policy could not be synchronized. Do not repeat removal.',
    extensionRemovalAllowlistCleanupFailed: 'The plugin was uninstalled, but its allowlist entry could not be removed. Do not repeat removal.',
    extensionRemovalConfirmationFailed: 'The runtime state could not be verified after removal, and the service did not return a specific reason.',
    extensionUninstallReceiptInvalid: 'The uninstall request was sent, but the AI engine did not return a valid removal acknowledgement. The outcome is unconfirmed. Check the plugin inventory once the engine is ready; do not repeat removal before confirming it.',
    extensionCommandTimedOutUnconfirmed: 'The plugin command timed out without a complete result. If it changed an installation or enabled state, check the plugin status before submitting that operation again.',
    extensionInstallMutationUnavailable: 'Installation has not started because exclusive package access is unavailable. Wait for the current plugin operation to finish, then try again.',
    extensionFollowupFailureReasonUnavailable: 'Follow-up verification or recovery did not complete, and the service did not return a specific reason.',
    extensionRemovalCommandCleanupFailed: 'The plugin was uninstalled, but the uninstall command did not finish normally. Do not repeat removal.',
    extensionDataInspectionFailed: 'The plugin data size could not be read.',
    extensionDataRemovalUnavailable: 'Plugin data cannot be safely removed, so uninstall has not started. Keep the data when uninstalling, or check its data directory first.',
    extensionDataRemovalFailed: 'The plugin was uninstalled, but its data could not be fully removed. Do not repeat removal.',
    networkPolicyInspectionFailed: 'Network policy validation failed in the {location}: {reason}',
    networkPolicySource: 'installation source',
    networkPolicyPreparedSource: 'prepared installation copy',
    networkPolicyInstalled: 'installed extension directory',
    networkPolicyFileInvalid: '{file} ({check}): {reason}',
    networkPolicyFileBeforeOpen: 'before opening the file',
    networkPolicyFileOpened: 'after opening the file',
    networkPolicyFilePathRecheck: 'rechecking the file path',
    networkPolicyFileContent: 'reading file contents',
    networkPolicyFileSymbolicLink: 'The file is a symbolic link, which is not allowed.',
    networkPolicyFileNotRegular: 'The path is not a regular file; it may be a directory or another file type.',
    networkPolicyFileTooLarge: 'The file is {bytes} bytes, exceeding the {limit}-byte (64 KiB) limit.',
    networkPolicyFileIdentityMismatch: 'The file identifiers differ from the preceding check; the same file could not be verified.',
    networkPolicyFileOutsideRoot: 'The resolved file is outside the extension root directory.',
    networkPolicyInspectionReasonUnavailable: 'No specific failure reason was returned.',
    networkPolicyManifestJsonInvalid: '{file} must contain valid JSON.',
    networkPolicyManifestShapeInvalid: 'The network policy must contain schemaVersion: 1 and a groups array.',
    networkPolicyGroupShapeInvalid: 'Network policy group {group} must contain baseUrlWhitelist and headerNames arrays.',
    networkPolicyHeaderInvalid: '{file}, group {group}, header {header}: {reason}',
    networkPolicyHeaderShapeInvalid: 'Use a valid header name, or an object with a valid name and exactly one valid string in from or value.',
    networkPolicyHeaderForbidden: 'Extension network policies cannot set this header.',
    networkPolicyUrlInvalid: '{file}, group {group}, URL {url}: {reason} Ask the plugin provider to check and correct this address declaration in the package.',
    networkPolicyUrlType: 'The address must be a string.',
    networkPolicyUrlAbsolute: 'The address must be a valid absolute URL.',
    networkPolicyUrlProtocol: 'Only HTTP and HTTPS protocols are supported.',
    networkPolicyUrlCredentials: 'The address must not contain a username or password.',
    networkPolicyUrlQuery: 'The address must not contain a query component (?).',
    networkPolicyUrlFragment: 'The address must not contain a fragment component (#).',
    networkPolicyUrlLocal: 'localhost, loopback, link-local and unspecified target addresses are not allowed.',
    extensionEnableSavedFollowupFailed: 'The enable setting was saved, but follow-up status confirmation failed. Refresh to check whether the plugin is available.',
    extensionDisableSavedFollowupFailed: 'The disable setting was saved, but follow-up status confirmation failed. Refresh to check the plugin status.',
    extensionStateFollowupFailed: 'Follow-up plugin status confirmation also failed.',
    extensionCredentialStoreUnavailable:
      'Unable to read the local extension credential file. Check its contents and access permissions.',
    extensionCredentialStoreWriteFailed:
      'Unable to securely save extension credentials. Check local file access permissions.',
    memoryWorkspaceUnavailable:
      'The memory workspace could not be resolved. Check the service connection.',
    memoryStatusUnavailable: 'Memory index status is unavailable.',
    memoryRebuildUnverified:
      'The index was not rebuilt or its resulting status could not be verified.',
    memoryRebuildDegraded:
      'The indexing command completed, but semantic retrieval is not confirmed. Check index status.',

    sessionDiagnosticsExport: 'Export session diagnostics',
    selectedModelUnavailable:
      'The selected model is no longer enabled. Please select an available model.',
    selectedModelProviderNotReady:
      'The selected provider is not ready. Please check its configuration and authentication.',
    selectedModelRouteChanged:
      'The selected model route has changed. Please select the model again.',
    sessionModelPreparationChanged:
      'The connection or configuration changed while preparing the model. Try again.',
    sessionModelConfigurationUnavailable:
      'The model configuration could not be read. Try again later.',
    sessionModelIdentityChanged:
      'The session identity changed while preparing the model. The operation has stopped.',
    sessionModelPreparationUnconfirmed:
      'The session model could not be confirmed. Select the model again and retry.',
    sessionStoragePreparationTimeout: 'The new conversation is still being prepared. Please send again later.',
    sessionStoragePreparationChanged: 'The conversation or connection changed during preparation. Please send again.',
    extensionConversionNotImplemented: `This extension does not meet ${PRODUCT_NAME}'s extension format requirements. Use a native extension package containing openclaw.plugin.json and a compiled runtime entry. Other plugin formats cannot be imported directly.`,
    extensionImportSourceChanged: 'The installation source changed during preparation. Select the installation source again and retry.',
    extensionImportSourceUnsafe: 'The extension source contains unsupported links or files and cannot be prepared for installation. Ask the plugin provider to check the package.',
    extensionImportArchiveLayoutInvalid: 'The extension archive directory layout is not supported. Ask the plugin provider to check the package root layout.',
    engineRestartUnconfirmed:
      'The restart request outcome is unconfirmed. No additional restart was requested. Check the engine status later.',
    engineRestartReadyUnconfirmed:
      'The engine accepted the restart, but readiness is unconfirmed. No additional restart was requested. Check its status later.',
    engineConfigApplicationUnconfirmed:
      'Settings were saved, but the restart request outcome is unconfirmed. No additional restart was requested; application is still unconfirmed.',
    modelDefaultConfigSyncFailed: 'Could not synchronize the default model configuration. Please retry.',
    extensionCredentialRefreshUnconfirmed:
      'Extension credentials were saved, but runtime refresh is unconfirmed.',
    extensionRuntimeServiceFailed:
      'An extension service failed to start. Check the runtime diagnostics.',
    extensionOperationBusy:
      'Another plugin or configuration operation is still in progress. Wait for it to finish, then try again.',
    extensionUninstallUnconfirmed:
      'The extension uninstall result is not confirmed. Refresh its status later; uninstall was not repeated.',
    extensionToggleUnconfirmed:
      'The extension toggle result is not confirmed. Refresh its status later; the toggle was not repeated.',
    extensionCatalogUnavailable:
      'The Gateway connection is unavailable. The plugin list will refresh when it reconnects.',
    extensionHotToggleUnavailable:
      'Plugin hot reload is unavailable. Restore the Gateway connection before trying again.',
    extensionHotToggleRestartRequired:
      'The native runtime did not complete plugin hot reload. Configuration was retained and the Gateway was not restarted.',
    extensionToggleRecoveryFailed: 'The extension toggle was saved, but Gateway recovery failed.',
    extensionNetworkPolicyRecoveryPending:
      'The extension toggle was saved. The header injection route will update when the Gateway can safely restart.',
    extensionInstallUnconfirmed:
      'The native runtime did not confirm the extension installation. Refresh its status later.',
    extensionInstallReceiptIncomplete:
      'The extension installation was saved, but its Gateway runtime receipt is incomplete. Refresh its status.',
    extensionPackageOwnershipUnconfirmed:
      'The extension package ownership could not be confirmed. Refresh its status later.',
    extensionSkillSyncFailed:
      'The extension setting was saved, but the extension skills could not be synchronized. Retry the same toggle.',
    skillSettingApplyUnconfirmed:
      'The skill setting was saved, but its status could not be synchronized.',
    builtinModelAuthenticationUnavailable:
      'Built-in model authentication is unavailable. Wait for login credentials to refresh.',
    credentialStorageUnavailable: 'Secure operating-system credential storage is unavailable.',
    credentialDecryptionFailed:
      'Failed to unlock the application credential with this operating-system account.',
    builtinCredentialTargetMismatch:
      'Built-in model credentials can only be used with the designated model request URL.',
    // Tray menu
    trayStartConversation: 'Start Conversation',
    traySettings: 'Settings',
    trayRestart: 'Restart',
    trayQuit: 'Quit',
    attachmentMenuOpen: 'Open',
    attachmentMenuOpenWithSystem: 'Open with System Tool',
    attachmentMenuShowInFolder: 'Show in Folder',
    filePreviewOpenWithFailed: 'Unable to open the system app chooser. Please try again.',
    imageMenuSaveAs: 'Save Image As…',
    imagePreviewWindowTitle: 'Image preview',
    imagePreviewUnavailable: 'Image preview is unavailable. Reopen the main window and try again.',
    filePreviewConflictTitle: 'File changed externally',
    filePreviewConflictMessage:
      'An agent or another program changed this file while you were editing.',
    filePreviewConflictOverwrite: 'Overwrite File',
    filePreviewConflictReload: 'Reload',
    filePreviewConflictCancel: 'Cancel',
    skillInvalidName:
      'SKILL.md "name" must be 1-64 characters and may contain letters, numbers, spaces, hyphens, underscores, parentheses, and periods; it cannot start or end with a space or period.',
    skillWindowsReservedName:
      'SKILL.md "name" cannot be the Windows reserved directory name "{name}".',
    skillInvalidFrontmatter: 'SKILL.md must have a valid YAML frontmatter block.',
    skillInvalidFrontmatterName:
      'SKILL.md must have valid YAML frontmatter and a valid "name" field.',
    skillDirectoryResource: 'skill directory',
    extensionDirectoryResource: 'extension directory',
    hookImportValidationFailed:
      'The Hook files changed during import. Installation could not complete. Import the package again.',
    hookAlreadyInstalled:
      'Hook "{hookId}" is already installed. Delete it before importing a replacement.',
    managedDirectoryLockedBy:
      '{resource}:\n{path}\n\nProcesses using this directory:\n{processes}\n\nClose the programs above and try again.',
    managedDirectoryLockedUnknown:
      '{resource}:\n{path}\n\nThe directory operation failed. A process lock could not be confirmed. Try again shortly.\n\nDetails: {detail}',
    managedDirectoryLockedByApp: `${PRODUCT_NAME} is still using the {resource}:\n{path}\n\nTry again shortly. If the problem continues, restart ${PRODUCT_NAME}.`,
    managedDirectoryPermissionDenied:
      'Cannot access the {resource}:\n{path}\n\nCheck its Windows owner and permissions, then try again.\n\nDetails: {detail}',
    managedDirectoryRuntimeBusy:
      'The Gateway still has active work, so its directory lock cannot be released safely. Wait for the work to finish and try again.',
    managedDirectoryRuntimeRecoveryFailed: 'Gateway recovery failed: {detail}',
    ...browserTranslations.en,
  },
};

let currentLanguage: LanguageType = 'zh';

/** Set the active language. Call this when app_config.language changes. */
export function setLanguage(language: LanguageType): void {
  currentLanguage = language;
}

export function getLanguage(): LanguageType {
  return currentLanguage;
}

/** Recognize persisted labels even when the application language has changed. */
export function matchesTranslation(key: string, value: string): boolean {
  return Object.values(translations).some(dictionary => dictionary[key] === value);
}

/**
 * Look up a translation key and optionally interpolate `{param}` placeholders.
 * Returns the key itself if no translation exists.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text =
    translations[currentLanguage][key] ??
    translations[currentLanguage === 'zh' ? 'en' : 'zh'][key] ??
    key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
