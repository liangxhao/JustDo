export const browserInterventionTranslations = {
  zh: {
    browserInterventionFloatTitle: '浏览器任务',
    browserInterventionMove: '拖动移动悬浮框，也可用方向键移动',
    browserInterventionChecking: '正在核对浏览器操作状态…',
    browserInterventionReady: '可停止当前任务后手动操作网页',
    browserInterventionStopping: '等待任务停止和网页动作结束…',
    browserInterventionManual: '人工操作中 · 自动浏览器操作已阻止',
    browserInterventionUncertain: '继续请求待核实；请先停止并核对，勿重复发送',
    browserInterventionStop: '停止任务并人工操作',
    browserInterventionRetryStop: '重新停止并核对',
    browserInterventionContinue: '我已完成，继续任务',
    browserInterventionTargetChanged: '网页已切换或关闭。继续时会重新核对当前打开的网页。',
    browserInterventionNote: '补充说明（可选，例如：已登录）',
    browserInterventionStopPending:
      '仍在自动核对停止状态。连接恢复后会继续核对；任务不会自动继续。',
    browserInterventionError: '尚未确认完成。请检查任务连接后重新停止并核对；不会自动继续。',
    browserInterventionNoNote: '无补充说明',
    browserInterventionPrompt:
      '我已在内置浏览器中完成人工操作，请继续之前的任务。人工操作开始时的目标：{target}。补充说明：{note}。先重新列出当前打开的标签页，再观察相关网页，核实导航、登录和表单状态；不要复用人工操作前的元素引用，也不要未经核实重放可能已提交的操作。',
  },
  en: {
    browserInterventionFloatTitle: 'Browser task',
    browserInterventionMove: 'Drag to move this panel, or use arrow keys',
    browserInterventionChecking: 'Checking browser operation state…',
    browserInterventionReady: 'Stop this task before interacting manually',
    browserInterventionStopping: 'Waiting for the task and browser actions to stop…',
    browserInterventionManual: 'Manual operation · Automated browser actions blocked',
    browserInterventionUncertain:
      'Continue outcome unconfirmed. Stop and check before sending again.',
    browserInterventionStop: 'Stop task and interact manually',
    browserInterventionRetryStop: 'Stop and check again',
    browserInterventionContinue: 'Done, continue task',
    browserInterventionTargetChanged:
      'The page has changed or closed. Continuing will recheck the currently open pages.',
    browserInterventionNote: 'Optional note, e.g. signed in',
    browserInterventionStopPending:
      'Still checking whether the task has stopped. Checks resume when the connection recovers; the task will not resume automatically.',
    browserInterventionError:
      'Completion is unconfirmed. Check the connection, then stop and check again. The task will not resume automatically.',
    browserInterventionNoNote: 'No additional note',
    browserInterventionPrompt:
      'I have finished interacting manually in the embedded browser. Continue the previous task. Target when manual operation began: {target}. Note: {note}. List the currently open tabs, then observe the relevant page again and verify navigation, login and form state. Do not reuse old element references or replay potentially submitted actions without checking.',
  },
};
