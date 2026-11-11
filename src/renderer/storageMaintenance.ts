import './storageMaintenance.css';

import { StorageMaintenancePhase, type StorageMaintenanceStatus } from '../shared/storage/storageRelocation';

const copy = {
  zh: {
    title: '数据目录迁移',
    recovery: '数据目录恢复',
    dataPath: '数据路径',
    sourcePath: '原位置',
    targetPath: '迁移目标',
    failurePath: '出错位置',
    unknownPath: '暂无法确认',
    cause: '原因',
    moving: '正在迁移数据…',
    progressLabel: '迁移进度',
    progress: {
      [StorageMaintenancePhase.RetiringProcesses]: ['等待退出', '正在等待应用和后台进程退出。'],
      [StorageMaintenancePhase.PreparingData]: ['准备数据', '正在准备迁移所需的数据和数据库快照。'],
      [StorageMaintenancePhase.CopyingData]: ['复制数据', '正在将数据复制到目标文件夹。'],
      [StorageMaintenancePhase.PreparingDestination]: ['准备新位置', '正在检查复制结果并准备新位置。'],
      [StorageMaintenancePhase.SwitchingLocation]: ['切换与清理', '正在启用新位置并清理旧副本，完成后会自动重启。'],
    },
    failed: '迁移尚未完成',
    targetNotEmpty: '目标目录已有文件。返回原位置后，可在设置中重新迁移。',
    unavailable: '数据目录暂不可用',
    retry: '重试',
    cancel: '取消迁移',
    returnToSource: '返回原位置',
    retryFromSettings: '返回原位置后，可在设置中重新迁移。目标目录中可能留有已复制的文件。',
    error: '请检查相关磁盘的可用空间、目录权限和文件占用情况。',
    blockingFile: '占用该位置的进程',
    blockingCheck: '文件占用检查',
    blockingRetirement: '尚未退出的进程',
    blockingChecking: '正在查找相关进程…',
    blockingUnknown: '暂无法确认相关进程。仅关闭能确认的其他程序。',
    processUnknown: '未知进程',
    processOwned: '应用相关进程',
    processExternal: '其他程序',
    waitForOwned: '请等待列出的应用相关进程退出，再重试。',
    waitAndReopen: '相关进程退出后，请关闭迁移窗口并重新打开应用。',
    keepMaintenance: '请保留迁移窗口及其进程。',
    closeExternal: '请确认列出的程序与迁移无关，再在这些程序中关闭相关文件或正常退出。',
    closeAndKeep: '请确认其他程序与迁移无关，再正常关闭相关文件或程序。保留迁移窗口及其进程。',
  },
  en: {
    title: 'Move the data folder',
    recovery: 'Data folder recovery',
    dataPath: 'Data folder',
    sourcePath: 'Original folder',
    targetPath: 'Destination',
    failurePath: 'Failed location',
    unknownPath: 'Could not determine',
    cause: 'Cause',
    moving: 'Moving data…',
    progressLabel: 'Migration progress',
    progress: {
      [StorageMaintenancePhase.RetiringProcesses]: ['Wait for exit', 'Waiting for the app and its background processes to exit.'],
      [StorageMaintenancePhase.PreparingData]: ['Prepare data', 'Preparing data and database snapshots for the move.'],
      [StorageMaintenancePhase.CopyingData]: ['Copy data', 'Copying data to the destination folder.'],
      [StorageMaintenancePhase.PreparingDestination]: ['Prepare destination', 'Checking the copied data and preparing the new location.'],
      [StorageMaintenancePhase.SwitchingLocation]: ['Switch and clean up', 'Switching to the new location and cleaning up old copies. The app will restart when this is complete.'],
    },
    failed: 'Migration did not complete',
    targetNotEmpty: 'The destination already contains files. Return to the original location and start a new move in Settings.',
    unavailable: 'The data folder is unavailable',
    retry: 'Retry',
    cancel: 'Cancel move',
    returnToSource: 'Return to original location',
    retryFromSettings: 'Return to the original location to start a new move in Settings. Copied files may remain in the destination.',
    error: 'Check available disk space, folder permissions, and whether files are in use.',
    blockingFile: 'Processes using this location',
    blockingCheck: 'File use check',
    blockingRetirement: 'Processes still running',
    blockingChecking: 'Looking for related processes…',
    blockingUnknown: 'Could not identify the related processes. Close only other programs you can identify.',
    processUnknown: 'Unknown process',
    processOwned: 'Application-related process',
    processExternal: 'Other program',
    waitForOwned: 'Wait for the listed application processes to exit, then retry.',
    waitAndReopen: 'Once those processes exit, close the migration window and reopen the app.',
    keepMaintenance: 'Keep the migration window and its processes open.',
    closeExternal: 'Confirm the listed programs are unrelated to migration, then close the affected files or quit those programs normally.',
    closeAndKeep: 'Confirm the other programs are unrelated to migration before closing their files or quitting them. Keep the migration window and its processes open.',
  },
};
const bridge = (
  window as unknown as {
    storageMaintenance: {
      status: () => Promise<StorageMaintenanceStatus>;
      onChanged: (callback: (value: StorageMaintenanceStatus) => void) => () => void;
      retry: () => Promise<void>;
      cancel: () => Promise<void>;
    };
  }
).storageMaintenance;
const element = (id: string) => document.getElementById(id)!;
const steps = Object.values(StorageMaintenancePhase).map(phase => {
  const row = document.createElement('li');
  const indicator = document.createElement('span');
  indicator.className = 'step-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'step-label';
  row.append(indicator, label);
  element('transfer').append(row);
  return { phase, row, label };
});

function renderPath(id: string, label: string, value?: string) {
  element(`${id}-row`).hidden = !value;
  element(`${id}-label`).textContent = label;
  element(`${id}-path`).textContent = value ?? '';
}

function renderBlocking(status: StorageMaintenanceStatus, text: typeof copy.en) {
  const blocking = status.error ? status.blocking : undefined;
  element('blocking').hidden = !blocking;
  const list = element('blocking-processes');
  list.replaceChildren();
  if (!blocking) return;

  element('blocking-title').textContent = blocking.kind === 'retirement' ? text.blockingRetirement
    : blocking.processes.length ? text.blockingFile : text.blockingCheck;
  list.hidden = !blocking.processes.length;
  let hasOwned = false;
  let hasExternal = false;
  for (const { name, pid, appOwned } of blocking.processes) {
    if (appOwned) hasOwned = true;
    else hasExternal = true;
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name || text.processUnknown;
    const detail = document.createElement('span');
    detail.textContent = `PID ${pid} · ${appOwned ? text.processOwned : text.processExternal}`;
    row.append(label, detail);
    list.append(row);
  }
  element('blocking-guidance').textContent = blocking.checking ? text.blockingChecking
    : !blocking.processes.length ? text.blockingUnknown
    : blocking.kind === 'retirement' ? (status.canRetry ? text.waitForOwned : text.waitAndReopen)
    : !hasExternal ? text.keepMaintenance
    : hasOwned ? text.closeAndKeep : text.closeExternal;
}

function renderProgress(status: StorageMaintenanceStatus, text: typeof copy.en) {
  const active = steps.findIndex(step => step.phase === status.phase);
  const transfer = element('transfer');
  transfer.hidden = Boolean(status.error) || active < 0;
  if (transfer.hidden) return;
  transfer.setAttribute('aria-label', text.progressLabel);
  steps.forEach(({ phase, row, label }, index) => {
    row.dataset.state = index < active ? 'complete' : index === active ? 'current' : 'pending';
    if (index === active) row.setAttribute('aria-current', 'step');
    else row.removeAttribute('aria-current');
    label.textContent = text.progress[phase][0];
  });
}

const render = (status: StorageMaintenanceStatus) => {
  const text = copy[status.language];
  const failed = Boolean(status.error);
  const container = element('storage-maintenance');
  document.documentElement.lang = status.language;
  container.dataset.failed = String(failed);
  element('title').textContent = failed ? text.recovery : text.title;
  const message = status.error === 'unavailable'
    ? text.unavailable
    : failed ? text.failed : status.phase ? text.progress[status.phase][1] : text.moving;
  if (element('phase').textContent !== message) element('phase').textContent = message;
  const dataLabel = !failed && status.sourcePath && status.sourcePath === status.dataPath
    ? text.sourcePath : text.dataPath;
  renderPath('data', dataLabel, status.dataPath ?? text.unknownPath);
  element('data-path').dataset.unknown = String(!status.dataPath);
  renderPath('source', text.sourcePath, status.sourcePath === status.dataPath ? undefined : status.sourcePath);
  renderPath('target', text.targetPath, status.targetPath === status.dataPath ? undefined : status.targetPath);
  renderPath('failure', text.failurePath, status.errorPath === status.dataPath ? undefined : status.errorPath);
  renderProgress(status, text);
  element('error-card').hidden = !failed;
  element('error-label').textContent = text.cause;
  element('error').textContent = status.error === 'target-not-empty'
    ? text.targetNotEmpty
    : [status.errorDetail ?? text.error, status.canCancel ? text.retryFromSettings : undefined]
      .filter(Boolean).join('\n');
  renderBlocking(status, text);
  element('retry').textContent = text.retry;
  element('cancel').textContent = failed ? text.returnToSource : text.cancel;
  element('retry').hidden = !status.canRetry;
  element('cancel').hidden = !status.canCancel;
  element('actions').hidden = !status.canRetry && !status.canCancel;
  container.hidden = false;
};
let receivedUpdate = false;
bridge.onChanged(status => {
  receivedUpdate = true;
  render(status);
});
void bridge.status().then(status => {
  if (!receivedUpdate) render(status);
});
element('retry').onclick = () => {
  void bridge.retry();
};
element('cancel').onclick = () => {
  void bridge.cancel();
};
