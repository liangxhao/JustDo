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
    askUserSubmittedMessage: '我已提交。',
    askUserCanceledMessage: '我取消了请求。',
    askUserAnswerLabel: '用户选择',
    skillInvalidName:
      'SKILL.md 的“name”必须为 1–64 个字符，且只能包含小写字母、数字和单个连字符。',
    skillWindowsReservedName: 'SKILL.md 的“name”不能使用 Windows 保留目录名“{name}”。',
    skillInvalidFrontmatter: 'SKILL.md 必须包含有效的 YAML frontmatter。',
    skillInvalidFrontmatterName: 'SKILL.md 必须包含有效的 YAML frontmatter 和“name”字段。',
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
    askUserSubmittedMessage: 'I submitted.',
    askUserCanceledMessage: 'I canceled the request.',
    askUserAnswerLabel: 'User answer',
    skillInvalidName:
      'SKILL.md "name" must be 1-64 characters and contain only lowercase letters, numbers, and single hyphens.',
    skillWindowsReservedName:
      'SKILL.md "name" cannot be the Windows reserved directory name "{name}".',
    skillInvalidFrontmatter: 'SKILL.md must have a valid YAML frontmatter block.',
    skillInvalidFrontmatterName:
      'SKILL.md must have valid YAML frontmatter and a valid "name" field.',
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
