/**
 * Lightweight i18n module for the Electron main process.
 *
 * Mirrors the renderer's i18nService pattern but runs in Node (no DOM/window).
 * Keeps only the small subset of keys needed by main-process code.
 *
 * Usage:
 *   import { t, setLanguage } from './i18n';
 *   setLanguage('en');
 *   const label = t('trayShowWindow'); // "Open JustDo"
 */

import { PRODUCT_NAME } from '../../shared/productMetadata';

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    // Tray menu
    trayShowWindow: `打开 ${PRODUCT_NAME}`,
    trayNewTask: '新建任务',
    traySettings: '设置',
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
    askUserSubmittedMessage: '我已提交。',
    askUserCanceledMessage: '我取消了请求。',
    askUserAnswerLabel: '用户选择',
    askUserSkippedAnswer: '已跳过',
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
  },
  en: {
    // Tray menu
    trayShowWindow: `Open ${PRODUCT_NAME}`,
    trayNewTask: 'New Task',
    traySettings: 'Settings',
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
    askUserSubmittedMessage: 'I submitted.',
    askUserCanceledMessage: 'I canceled the request.',
    askUserAnswerLabel: 'User answer',
    askUserSkippedAnswer: 'Skipped',
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
