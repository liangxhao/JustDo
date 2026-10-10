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

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    windowMinimize: '最小化',
    windowMaximize: '最大化',
    windowRestore: '还原',
    windowClose: '关闭',
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
    worktreeIdentityMissing: '无法确认待清理的 Worktree 会话。',
    worktreeCancellationRetained:
      '取消任务后的工作目录未能清理，已保留会话入口。请在设置中检查 Worktree。',
    nativeVideoUrlInvalid:
      '视频服务地址无效，请使用不含登录信息、查询参数或片段的 HTTP 或 HTTPS 地址。',
    nativeVideoLegacyUnsupported: '请在设置的视频模型页面配置视频服务，此入口不支持直接写入 OpenAI 视频配置。',
    nativeVideoConfigurationInvalid: '视频模型配置无效，请检查服务商、模型、服务地址和 API Key。',
    decisionModelConfigurationInvalid:
      '决策模型配置未能生效，请检查供应商 URL、API Key、默认模型及凭据文件访问权限。',
    extensionCredentialStoreUnavailable: '无法读取本地扩展凭据文件，请检查文件内容和访问权限。',
    extensionCredentialInherited: '此凭据由系统环境变量提供，请修改该变量并重启应用。',
    extensionConfigurationNumberInvalid: '请输入范围内的有效数值。',
    extensionCredentialStoreWriteFailed: '无法安全保存扩展凭据，请检查本地文件访问权限。',
    memoryWorkspaceUnavailable: '无法确定记忆工作区，请检查服务连接。',
    memoryStatusUnavailable: '无法读取记忆索引状态。',
    memoryRebuildUnverified: '索引未完成重建，或无法验证重建后的状态。',
    memoryRebuildDegraded: '索引命令已完成，但语义检索尚未确认可用，请检查索引状态。',

    sessionDiagnosticsExport: '导出会话诊断',
    selectedModelUnavailable: '所选模型已停用或移除，请重新选择可用模型。',
    selectedModelProviderNotReady: '所选模型的提供商尚未就绪，请检查配置和认证状态。',
    selectedModelRouteChanged: '所选模型的路由已变更，请重新选择模型。',
    extensionConversionNotImplemented: '该扩展需要转换为 OpenClaw 格式，转换功能暂未实现。',
    agentTeamSkillSyncFailed: '扩展开关已保存，但 Agent Team 技能同步未完成。请重试同一开关操作。',
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
    imageMenuSaveAs: '图片另存为…',
    imagePreviewWindowTitle: '图片预览',
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
    managedDirectoryLockedBy:
      '{resource}：\n{path}\n\n占用程序：\n{processes}\n\n请关闭以上程序后重试。',
    managedDirectoryLockedUnknown:
      '{resource}：\n{path}\n\n该目录仍被其他程序占用，但 Windows 未能识别占用者。\n\n请关闭可能正在查看、编辑或扫描该目录的程序后重试。',
    managedDirectoryLockedByApp: `{resource}：\n{path}\n\n${PRODUCT_NAME} 仍在使用该目录，暂时无法完成操作。\n\n请稍后重试；若问题持续出现，请重启 ${PRODUCT_NAME}。`,
    managedDirectoryPermissionDenied:
      '无法访问{resource}：\n{path}\n\n请检查 Windows 所有者和权限后重试。\n\n详细信息：{detail}',
    managedDirectoryRuntimeBusy: 'Gateway 仍有活动任务，无法安全释放目录锁。请等待任务结束后重试。',
    managedDirectoryRuntimeRecoveryFailed: 'Gateway 恢复失败：{detail}',
    browserAgentImportTitle: '导入浏览器资料',
    browserAgentImportMessage: '是否将 {source} 的 Cookie 导入内置浏览器？',
    browserAgentImportDetail: '数据只保存在本机，可能需要使用当前 Windows 账户解密。',
    browserAgentImportConfirm: '导入',
    browserAgentImportCancel: '取消',
    browserExternalProtocolTitle: '打开外部应用',
    browserExternalProtocolMessage: '此网页想要打开外部应用：',
    browserExternalProtocolConfirm: '允许打开',
    browserExternalProtocolCancel: '取消',
    browserExternalProtocolFailed: '无法打开关联应用，请检查是否已安装支持此链接的应用。',
    browserPermissionTitle: '网页权限请求',
    browserPermissionMessage: '{site} 想要使用{permission}',
    browserPermissionAllow: '本页允许',
    browserPermissionDeny: '拒绝',
    browserPermissionCamera: '摄像头',
    browserPermissionMicrophone: '麦克风',
    browserPermissionCameraAndMicrophone: '摄像头和麦克风',
    browserPermissionLocation: '位置信息',
    browserPermissionNotifications: '系统通知',
    browserContextBack: '后退',
    browserContextForward: '前进',
    browserContextReload: '重新加载',
    browserContextOpenLinkNewTab: '在新标签页中打开链接',
    browserContextCopyLink: '复制链接地址',
    browserContextSaveImage: '图片另存为…',
  },
  en: {
    windowMinimize: 'Minimize',
    windowMaximize: 'Maximize',
    windowRestore: 'Restore',
    windowClose: 'Close',
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
    worktreeCreateUnconfirmed:
      'Could not confirm Worktree creation. Check the Worktree list in Settings.',
    worktreeIdentityMissing: 'Could not identify the Worktree conversation to clean up.',
    worktreeCancellationRetained:
      'Could not clean up the cancelled task workspace. Its conversation was retained. Check Worktrees in Settings.',
    extensionCredentialInherited:
      'This credential is supplied by the system environment. Update that variable and restart the app.',
    extensionConfigurationNumberInvalid: 'Enter a valid number within the allowed range.',
    nativeVideoUrlInvalid:
      'Invalid video service URL. Use an HTTP or HTTPS address without credentials, query parameters or fragments.',
    nativeVideoLegacyUnsupported:
      'Configure video services in Settings → Models → Video models. This entry point does not accept direct OpenAI video configuration.',
    nativeVideoConfigurationInvalid:
      'Invalid video configuration. Check the provider, model, service URL and API key.',
    decisionModelConfigurationInvalid:
      'Unable to apply decision model configuration. Check the provider URL, API Key, default model and credential file access.',
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
    extensionConversionNotImplemented:
      'This extension requires conversion to OpenClaw format. Conversion is not implemented yet.',
    agentTeamSkillSyncFailed:
      'The extension setting was saved, but the Agent Team skill could not be synchronized. Retry the same toggle.',
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
    imageMenuSaveAs: 'Save Image As…',
    imagePreviewWindowTitle: 'Image preview',
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
    managedDirectoryLockedBy:
      '{resource}:\n{path}\n\nProcesses using this directory:\n{processes}\n\nClose the programs above and try again.',
    managedDirectoryLockedUnknown:
      '{resource}:\n{path}\n\nThis directory is still in use, but Windows could not identify the process.\n\nClose programs that may be viewing, editing, or scanning it, then try again.',
    managedDirectoryLockedByApp: `${PRODUCT_NAME} is still using the {resource}:\n{path}\n\nTry again shortly. If the problem continues, restart ${PRODUCT_NAME}.`,
    managedDirectoryPermissionDenied:
      'Cannot access the {resource}:\n{path}\n\nCheck its Windows owner and permissions, then try again.\n\nDetails: {detail}',
    managedDirectoryRuntimeBusy:
      'The Gateway still has active work, so its directory lock cannot be released safely. Wait for the work to finish and try again.',
    managedDirectoryRuntimeRecoveryFailed: 'Gateway recovery failed: {detail}',
    browserAgentImportTitle: 'Import browser profile',
    browserAgentImportMessage: 'Import cookies from {source} into the embedded browser?',
    browserAgentImportDetail:
      'The data stays on this device and may require decryption with the current Windows account.',
    browserAgentImportConfirm: 'Import',
    browserAgentImportCancel: 'Cancel',
    browserExternalProtocolTitle: 'Open External Application',
    browserExternalProtocolMessage: 'This page wants to open an external application:',
    browserExternalProtocolConfirm: 'Open',
    browserExternalProtocolCancel: 'Cancel',
    browserExternalProtocolFailed:
      'Unable to open the associated application. Check that an app supporting this link is installed.',
    browserPermissionTitle: 'Website permission request',
    browserPermissionMessage: '{site} wants to use {permission}',
    browserPermissionAllow: 'Allow for this page',
    browserPermissionDeny: 'Deny',
    browserPermissionCamera: 'your camera',
    browserPermissionMicrophone: 'your microphone',
    browserPermissionCameraAndMicrophone: 'your camera and microphone',
    browserPermissionLocation: 'your location',
    browserPermissionNotifications: 'system notifications',
    browserContextBack: 'Back',
    browserContextForward: 'Forward',
    browserContextReload: 'Reload',
    browserContextOpenLinkNewTab: 'Open Link in New Tab',
    browserContextCopyLink: 'Copy Link Address',
    browserContextSaveImage: 'Save Image As…',
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
