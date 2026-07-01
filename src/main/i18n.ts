/**
 * Lightweight i18n module for the Electron main process.
 *
 * Mirrors the renderer's i18nService pattern but runs in Node (no DOM/window).
 * Keeps only the small subset of keys needed by main-process code
 * (tray menu, session titles, etc.).
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
    subagents: 'Subagent',
    subagentEmpty: '当前会话暂无 Subagent',
    subagentStatusRunning: '运行中',
    subagentStatusDone: '已完成',
    subagentStatusFailed: '已失败',
    subagentStatusKilled: '已终止',
    subagentStatusTimeout: '已超时',
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

    // Session titles (created by ChannelSessionSync)
    cronSessionPrefix: '定时',
    // IM channel prefixes will be added when integration is implemented

    // Thinking-only hint
    taskThinkingOnly:
      '[模型未输出内容] 模型已完成思考但未生成可见回复。你可以继续对话，让模型重新输出结果。',

    // IM error messages will be added when integration is implemented

    // Exec approval continuation
    execApprovalApproved: '用户已确认执行该命令，请检查执行结果并继续。',
    execApprovalDenied: '用户已拒绝执行该命令。',
    askUserApprovedMessage: '我已确认。',
    askUserDeniedMessage: '我拒绝了请求。',
    askUserAnswerLabel: '用户选择',

    // Skill manager errors
    skillErrNoSkillMd: '来源中未找到 SKILL.md',
    skillErrInvalidSource:
      '无效的技能来源。支持 owner/repo、仓库链接、npm 包名、ClawHub 链接或 GitHub tree/blob 链接。',
    skillErrClawhubNotFound: '在 ClawHub 上未找到该技能，请检查链接是否正确。',
    skillErrClawhubDownloadFailed: '从 ClawHub 下载技能失败，请稍后重试。',

    // Auth quota
    authPlanFree: '免费',
    authPlanStandard: '标准',

    // IM connectivity test messages will be added when integration is implemented
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open JustDo',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',
    subagents: 'Subagents',
    subagentEmpty: 'No subagents in this session',
    subagentStatusRunning: 'Running',
    subagentStatusDone: 'Completed',
    subagentStatusFailed: 'Failed',
    subagentStatusKilled: 'Killed',
    subagentStatusTimeout: 'Timed out',
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

    // Session titles
    cronSessionPrefix: 'Cron',
    // IM channel prefixes will be added when integration is implemented

    // Thinking-only hint
    taskThinkingOnly:
      '[No output] The model finished thinking but did not generate a visible reply. You can continue the conversation to ask it to output the result.',
    // IM error messages will be added when integration is implemented


    // Exec approval continuation
    execApprovalApproved:
      'The user approved the command execution. Please check the result and continue.',
    execApprovalDenied: 'The user denied the command execution.',
    askUserApprovedMessage: 'I approved.',
    askUserDeniedMessage: 'I denied the request.',
    askUserAnswerLabel: 'User answer',

    // Skill manager errors
    skillErrNoSkillMd: 'No SKILL.md found in source',
    skillErrInvalidSource:
      'Invalid skill source. Use owner/repo, repo URL, npm package spec, ClawHub URL, or a GitHub tree/blob URL.',
    skillErrClawhubNotFound: 'Skill not found on ClawHub. Please check the URL.',
    skillErrClawhubDownloadFailed: 'Failed to download skill from ClawHub. Please try again later.',

    // Auth quota
    authPlanFree: 'Free',
    authPlanStandard: 'Standard',

    // IM connectivity test messages will be added when integration is implemented
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
