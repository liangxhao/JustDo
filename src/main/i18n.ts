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

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    // Tray menu
    trayShowWindow: '打开 JustDo',
    trayNewTask: '新建任务',
    traySettings: '设置',
    trayQuit: '退出',
    attachmentMenuOpen: '打开',
    attachmentMenuOpenWithSystem: '使用系统工具打开',
    attachmentMenuShowInFolder: '打开所在的文件夹',
    // Exec approval continuation
    execApprovalApproved: '用户已确认执行该命令，请检查执行结果并继续。',
    execApprovalDenied: '用户已拒绝执行该命令。',
    askUserApprovedMessage: '我已确认。',
    askUserDeniedMessage: '我拒绝了请求。',
    askUserAnswerLabel: '用户选择',
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open JustDo',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',
    attachmentMenuOpen: 'Open',
    attachmentMenuOpenWithSystem: 'Open with System Tool',
    attachmentMenuShowInFolder: 'Show in Folder',
    // Exec approval continuation
    execApprovalApproved:
      'The user approved the command execution. Please check the result and continue.',
    execApprovalDenied: 'The user denied the command execution.',
    askUserApprovedMessage: 'I approved.',
    askUserDeniedMessage: 'I denied the request.',
    askUserAnswerLabel: 'User answer',
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
