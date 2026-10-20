export const appPluginTranslations = {
  zh: {
    sessionExportMain: '导出对话',
    nativePeerIncomingMessage: '来自其他助手',
    extensionDiscussionReference: '讨论引用',
    extensionCollaborationReference: '任务引用',
    extensionBatchReferenceDisplay: '协作引用 · {member} · 原批次',
    extensionCollaborationReferenceDisplay: '协作引用 · {member}',

    appPluginReview: '审查应用扩展',
    appPluginSubmitUnavailable: '当前插件模式无法提交，请检查插件状态和会话状态。',
    appPluginRemoveMode: '取消本次插件模式',
    appPluginTrustDescription:
      '这个扩展将在应用内运行，并能访问本机资源。请确认你信任这份代码。批准后会在后台重新加载连接服务，无需退出应用。',
    appPluginApprove: '信任这份代码',
    appPluginApproved: '代码已批准。',
    appPluginApprovalRequired: '请先审查并信任当前插件代码，再启用插件。',
    appPluginReviewChanged: '扩展内容或审查已变化，请重新打开审查。',
    appPluginRestartRequired: '插件正在等待后台连接服务重新加载，无需退出应用。',
    appPluginCleanupUnresolved: '插件任务的停止或清理尚未确认，请检查任务状态。',
    appPluginSkillSyncFailed: '插件的技能状态未能同步，请重新设置插件状态。',
    appPluginUnavailable: '插件当前不可用，请检查插件状态。',
    appPluginRetired: '插件状态已变化，请重新打开入口。',
    appPluginInvalidRequest: '插件请求无效。',
    appPluginIncompatible: '插件与当前应用接口不兼容。',
    appPluginResourceConflict: '多个插件声明了相同资源，暂时无法删除。',
  },
  en: {
    sessionExportMain: 'Export conversation',
    nativePeerIncomingMessage: 'From another assistant',
    extensionDiscussionReference: 'Discussion reference',
    extensionCollaborationReference: 'Task reference',
    extensionBatchReferenceDisplay: 'Collaboration reference · {member} · Prior batch',
    extensionCollaborationReferenceDisplay: 'Collaboration reference · {member}',

    appPluginReview: 'Review app extension',
    appPluginSubmitUnavailable:
      'The plugin mode cannot submit in the current plugin or conversation state.',
    appPluginRemoveMode: 'Remove this plugin mode',
    appPluginTrustDescription:
      'This extension runs inside the application and can access local resources. Approve only code you trust. Approval reloads the connection service in the background without closing the application.',
    appPluginApprove: 'Trust this code',
    appPluginApproved: 'Code approved.',
    appPluginApprovalRequired: 'Review and trust the current plugin code before enabling it.',
    appPluginReviewChanged: 'The extension or review changed. Open a new review.',
    appPluginRestartRequired:
      'The plugin is waiting for the background connection service to reload. Keep the application open.',
    appPluginCleanupUnresolved: 'Plugin execution cleanup is not confirmed. Check the task status.',
    appPluginSkillSyncFailed:
      'Plugin skill state could not be synchronized. Set the plugin state again.',
    appPluginUnavailable: 'The plugin is unavailable. Check its status.',
    appPluginRetired: 'The plugin state changed. Open the entry again.',
    appPluginInvalidRequest: 'The plugin request is invalid.',
    appPluginIncompatible: 'The plugin is incompatible with this application interface.',
    appPluginResourceConflict: 'Multiple plugins claim this resource. Deletion is blocked.',
  },
};
