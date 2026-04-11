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
 *   const label = t('trayShowWindow'); // "Open GucciAI"
 */

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    // Tray menu
    trayShowWindow: '打开 GucciAI',
    trayNewTask: '新建任务',
    traySettings: '设置',
    trayQuit: '退出',

    // Session titles (created by ChannelSessionSync)
    cronSessionPrefix: '定时',
    // IM channel prefixes will be added when integration is implemented

    // Timeout hint
    taskTimedOut: '[任务超时] 任务因超过最大允许时长而被自动停止。你可以继续对话以从中断处继续。',
    // IM session messages will be added when integration is implemented

    // OAuth flow messages
    qwenOAuthRequestingDeviceCode: '正在请求设备授权码...',
    qwenOAuthOpeningBrowser: '正在打开浏览器进行授权...',
    qwenOAuthWaitingForUser: '等待用户授权...',
    qwenOAuthSuccess: 'OAuth 授权成功',
    qwenOAuthFailed: 'OAuth 授权失败',
    qwenOAuthTimeout: 'OAuth 授权超时',
    // Thinking-only hint
    taskThinkingOnly:
      '[模型未输出内容] 模型已完成思考但未生成可见回复。你可以继续对话，让模型重新输出结果。',

    // Cowork error messages (shared with renderer via classifyErrorKey)
    coworkErrorAuthInvalid: 'API 密钥无效或已过期，请检查配置。',
    coworkErrorInsufficientBalance: 'API 余额不足，请充值后重试。',
    coworkErrorInputTooLong: '输入内容过长，超出模型上下文限制。',
    coworkErrorCouldNotProcessPdf: '无法处理 PDF 文件。',
    coworkErrorModelNotFound: '请求的模型不存在或不可用。',
    coworkErrorGatewayDisconnected: 'AI 引擎连接中断，请重试。',
    coworkErrorServiceRestart: 'AI 引擎正在重启，请稍后重试。',
    coworkErrorGatewayDraining: 'AI 引擎正在重启中，请稍等片刻后重试。',
    coworkErrorNetworkError: '网络连接失败，请检查网络设置。',
    coworkErrorRateLimit: '请求过于频繁，请稍后再试。',
    coworkErrorContentFiltered: '内容未通过安全审核，请修改后重试。',
    coworkErrorServerError: '服务端出现错误，请稍后重试。',
    coworkErrorEngineNotReady: 'AI 引擎正在启动中，请稍等几秒后重试。',
    coworkErrorUnknown: '任务执行出错，请重试。如果问题持续出现，请检查模型配置。',
    // IM error messages will be added when integration is implemented

    // Exec approval continuation
    execApprovalApproved: '用户已确认执行该命令，请检查执行结果并继续。',
    execApprovalDenied: '用户已拒绝执行该命令。',

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

    'enterprise.updateBlocked': '版本更新由企业统一管理',
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open GucciAI',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',

    // Session titles
    cronSessionPrefix: 'Cron',
    // IM channel prefixes will be added when integration is implemented

    // Timeout hint
    taskTimedOut:
      '[Task timed out] The task was automatically stopped because it exceeded the maximum allowed duration. You can continue the conversation to pick up where it left off.',
    // IM session messages will be added when integration is implemented

    // OAuth flow messages
    qwenOAuthRequestingDeviceCode: 'Requesting device authorization code...',
    qwenOAuthOpeningBrowser: 'Opening browser for authorization...',
    qwenOAuthWaitingForUser: 'Waiting for user authorization...',
    qwenOAuthSuccess: 'OAuth authorization successful',
    qwenOAuthFailed: 'OAuth authorization failed',
    qwenOAuthTimeout: 'OAuth authorization timeout',
    // Thinking-only hint
    taskThinkingOnly:
      '[No output] The model finished thinking but did not generate a visible reply. You can continue the conversation to ask it to output the result.',
    // IM error messages will be added when integration is implemented

    // Cowork error messages
    coworkErrorAuthInvalid: 'Invalid or expired API key. Please check your configuration.',
    coworkErrorInsufficientBalance: 'Insufficient API balance. Please top up and try again.',
    coworkErrorInputTooLong: 'Input too long, exceeding model context limit.',
    coworkErrorCouldNotProcessPdf: 'Unable to process the PDF file.',
    coworkErrorModelNotFound: 'The requested model does not exist or is unavailable.',
    coworkErrorGatewayDisconnected: 'AI engine connection lost. Please retry.',
    coworkErrorServiceRestart: 'AI engine is restarting. Please try again later.',
    coworkErrorGatewayDraining: 'AI engine is restarting. Please wait a moment and try again.',
    coworkErrorNetworkError: 'Network connection failed. Please check your network settings.',
    coworkErrorRateLimit: 'Too many requests. Please try again later.',
    coworkErrorContentFiltered:
      'Content did not pass the safety review. Please modify and try again.',
    coworkErrorServerError: 'Server error occurred. Please try again later.',
    coworkErrorEngineNotReady: 'AI engine is starting up. Please wait a few seconds and try again.',
    coworkErrorUnknown:
      'Task failed due to an unexpected error. Please retry. If the issue persists, check your model configuration.',

    // Exec approval continuation
    execApprovalApproved:
      'The user approved the command execution. Please check the result and continue.',
    execApprovalDenied: 'The user denied the command execution.',

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

    'enterprise.updateBlocked': 'Updates are managed by enterprise',
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