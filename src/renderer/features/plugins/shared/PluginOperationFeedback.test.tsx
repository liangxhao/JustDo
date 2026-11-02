// @vitest-environment jsdom
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationProgress,
  PluginOperationStage,
} from '@shared/plugins/pluginOperation';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import EngineInteractionBoundary from '@/app/shell/startup/routing/EngineInteractionBoundary';
import {
  getEngineReadinessSnapshot,
  refreshEngineReadiness,
} from '@/app/shell/startup/routing/useEngineReadiness';
import { i18nService } from '@/services/i18n';
import { pluginsTranslations } from '@/services/i18n/pluginsTranslations';

import OperationResultModal, { OperationResultNotice } from './OperationResultModal';
import PluginOperationFeedback from './PluginOperationFeedback';
import { pluginOperationFailurePresentation } from './pluginOperationPresentation';
import {
  getPluginOperationOwner,
  type PluginOperationFailureInput,
  PluginOperationFailureState,
} from './pluginOperationService';
import PluginOperationStatus from './PluginOperationStatus';
import {
  PluginOperationStatusContent,
  PluginOperationStatusSlot,
} from './PluginOperationStatusSlot';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'pluginOperationElapsed' ? '{seconds}s elapsed' : key),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  let notify!: (progress: PluginOperationProgress) => void;
  const bridge = {
    plugins: {
      onOperationProgress: vi.fn((callback: typeof notify) => {
        notify = callback;
        return vi.fn();
      }),
    },
  };
  Object.defineProperty(window, 'electron', { configurable: true, value: bridge });
  return {
    bridge,
    owner: getPluginOperationOwner(bridge),
    notify: (progress: PluginOperationProgress) => notify(progress),
  };
}

function setupEngineReadiness(bridge: object, admitted = false) {
  let state: AppInitializationState = {
    phase: AppInitializationPhase.Ready,
    step: AppInitializationStep.Complete,
    route: StartupRoute.Normal,
    firstLaunch: false,
    enginePreparationPending: !admitted,
    completedSteps: 4,
    totalSteps: 4,
    userDataPath: 'C:/data',
    activity: AppInitializationActivity.Finalize,
    startedAt: 1,
    activityStartedAt: 1,
    updatedAt: 1,
  };
  let status: OpenClawEngineStatus = {
    phase: EnginePhase.Running,
    version: 'test',
    canRetry: false,
  };
  let stateListener: (next: AppInitializationState) => void = () => undefined;
  let statusListener: (next: OpenClawEngineStatus) => void = () => undefined;
  const getState = vi.fn(async () => state);
  const getStatus = vi.fn(async () => ({ success: true, status }));
  Object.assign(bridge, {
    initialization: {
      getState,
      onChanged: (listener: typeof stateListener) => {
        stateListener = listener;
        return () => undefined;
      },
    },
    openclaw: {
      engine: {
        getStatus,
        onProgress: (listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });
  return {
    getState,
    getStatus,
    state: () => state,
    admit: (ready: boolean, notify = true) => {
      state = { ...state, enginePreparationPending: !ready };
      if (notify) stateListener(state);
    },
    fail: (message: string) => {
      status = { ...status, phase: EnginePhase.Error, message, canRetry: true };
      statusListener(status);
    },
  };
}

const options = {
  kind: PluginKind.EXTENSION,
  action: PluginOperationAction.INSTALL,
  label: 'Library tool',
};

function useActualTranslations(language: 'zh' | 'en') {
  const dictionary = pluginsTranslations[language] as Record<string, string>;
  vi.spyOn(i18nService, 't').mockImplementation(key => dictionary[key] ?? key);
}

function openReportDetails() {
  const details = document.querySelector('details')!;
  if (!details.open) fireEvent.click(details.querySelector('summary')!);
  return details;
}

function showRemovalFailure(input: PluginOperationFailureInput) {
  const { owner } = setup();
  const operation = owner.start({ ...options, action: PluginOperationAction.REMOVE });
  operation.fail(input);
  operation.finish();
  render(<PluginOperationFeedback />);
  return { dialog: screen.getByRole('alertdialog'), requestId: operation.context.requestId };
}

test('explains a confirmed removal separately from a failed engine restart and copies the reason and advice', async () => {
  useActualTranslations('zh');
  const reason = '原生卸载已完成。\n恢复引擎连接时本地服务退出。';
  const { dialog, requestId } = showRemovalFailure({
    message: reason,
    state: PluginOperationFailureState.REFRESH_FAILED,
    failedStage: PluginOperationStage.RESTARTING_GATEWAY,
  });
  expect(screen.getByRole('alertdialog', { name: '插件已卸载，运行环境恢复失败' })).toBe(dialog);
  expect(screen.getByText(reason, { normalizer: value => value })).toBeTruthy();
  const guidance = screen.getByRole('heading', { name: '接下来可以做什么' }).nextElementSibling!
    .textContent!;
  expect(guidance).toContain('无需再次卸载');
  expect(guidance).toContain('标题栏');
  expect(guidance).toContain('查看原因');
  expect(guidance).not.toContain('启动 AI 引擎');
  expect(guidance).not.toMatch(/设置|通用|重新安装|启用插件|仍无法使用插件/);
  expect(dialog.textContent).not.toContain('pluginOperation');

  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  openReportDetails();
  fireEvent.click(screen.getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain(reason);
  expect(writeText.mock.calls[0][0]).toContain(guidance);
  expect(writeText.mock.calls[0][0]).toContain(requestId);
  expect(writeText.mock.calls[0][0]).toContain('仅在提供“启动 AI 引擎”按钮时');
});

test('describes both explicit runtime recovery stages as a completed removal in English', () => {
  useActualTranslations('en');
  for (const failedStage of [
    PluginOperationStage.PREPARING_RUNTIME,
    PluginOperationStage.RESTARTING_GATEWAY,
  ]) {
    const presentation = pluginOperationFailurePresentation({
      action: PluginOperationAction.REMOVE,
      state: PluginOperationFailureState.REFRESH_FAILED,
      failedStage,
    });
    expect(presentation.title).toBe('Plugin uninstalled; runtime recovery failed');
    expect(presentation.guidance).toContain('do not remove it again');
    expect(presentation.guidance).toContain('title bar');
    expect(presentation.guidance).toContain('only if a “Start AI engine” button is offered');
    expect(presentation.guidance).not.toMatch(
      /Settings|General|enable the plugin|plugin still cannot be used/,
    );
  }
});

test.each([
  {
    language: 'zh' as const,
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
    title: /插件已卸载.*应用配置并等待运行环境/,
    advice: '网络策略或运行配置',
    saved: '无需再次卸载',
    copy: '复制错误详情',
  },
  {
    language: 'en' as const,
    failedStage: PluginOperationStage.SAVING_CONFIGURATION,
    title: /Plugin uninstalled.*Save plugin configuration/,
    advice: 'allowed-plugin list',
    saved: 'Do not remove it again',
    copy: 'Copy error details',
  },
])(
  'names the unfinished removal configuration step and offers administrator help: $failedStage',
  async ({ language, failedStage, title, advice, saved, copy }) => {
    useActualTranslations(language);
    const reason = 'Native removal finished. Configuration cleanup failed.';
    const { dialog, requestId } = showRemovalFailure({
      message: reason,
      state: PluginOperationFailureState.REFRESH_FAILED,
      failedStage,
    });
    expect(screen.getByRole('alertdialog', { name: title })).toBe(dialog);
    const nextStep = pluginsTranslations[language].pluginOperationFailureNextStep;
    const guidance = screen.getByRole('heading', { name: nextStep }).nextElementSibling!
      .textContent!;
    expect(guidance).toContain(saved);
    expect(guidance).toContain(advice);
    expect(guidance).toMatch(/管理员|administrator/);
    expect(guidance).not.toMatch(/设置|Settings|手动卸载|removing it manually|手动启用/);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    openReportDetails();
    fireEvent.click(screen.getByRole('button', { name: copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain(reason);
    expect(writeText.mock.calls[0][0]).toContain(guidance);
    expect(writeText.mock.calls[0][0]).toContain(requestId);
  },
);

test('offers conditional file-use and permission remedies for a known uninstall failure', async () => {
  useActualTranslations('zh');
  const reason = '无法移除插件文件：目标文件仍被相关程序占用。';
  const { dialog } = showRemovalFailure({
    message: reason,
    failedStage: PluginOperationStage.UNINSTALLING,
  });
  expect(screen.getByRole('alertdialog', { name: '卸载未完成' })).toBe(dialog);
  const guidance = screen.getByRole('heading', { name: '接下来可以做什么' }).nextElementSibling!
    .textContent!;
  expect(guidance).toContain('按具体原因处理');
  expect(guidance).toContain('核对插件仍在列表中再手动卸载');
  expect(guidance).not.toMatch(/启用|设置|核对版本、开关/);

  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  openReportDetails();
  fireEvent.click(screen.getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain(reason);
  expect(writeText.mock.calls[0][0]).toContain(guidance);
  expect(writeText.mock.calls[0][0]).toContain('如提示文件被占用');
  expect(writeText.mock.calls[0][0]).toContain('如提示无权限');
});

test.each([
  {
    state: PluginOperationFailureState.REFRESH_FAILED,
    failedStage: PluginOperationStage.RESTARTING_GATEWAY,
    operationUnconfirmed: true as const,
  },
  {
    state: PluginOperationFailureState.COMMITTED,
    failedStage: PluginOperationStage.SAVING_CONFIGURATION,
    installSourceInUse: true as const,
  },
])(
  'never claims removal finished when an unknown flag is present: $state / $failedStage',
  input => {
    useActualTranslations('zh');
    const { dialog } = showRemovalFailure({ message: '尚未收到原生卸载的最终回执。', ...input });
    expect(screen.getByRole('alertdialog', { name: '操作状态待确认' })).toBe(dialog);
    expect(screen.getByText('最后已知步骤')).toBeTruthy();
    const guidance = screen.getByRole('heading', { name: '接下来可以做什么' }).nextElementSibling!
      .textContent!;
    expect(guidance).toContain('核对最新状态');
    expect(guidance).toContain('不要重复提交');
    expect(guidance).not.toMatch(/无需再次卸载|再手动卸载|启动 AI 引擎|设置|启用/);
    expect(dialog.textContent).not.toContain('插件已卸载');
  },
);

test('shares the progress stack with settled feedback and blocks its portal actions during an engine restart', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  const refresh = vi.fn();
  function StatusHarness({ blocked }: { blocked: boolean }) {
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    return (
      <>
        <PluginOperationStatus feedbackSlotRef={setSlot} />
        <EngineInteractionBoundary disabled={blocked}>
          <PluginOperationStatusSlot.Provider value={slot}>
            <PluginOperationStatusContent>
              <button onClick={refresh}>Refresh pending installation</button>
            </PluginOperationStatusContent>
          </PluginOperationStatusSlot.Provider>
        </EngineInteractionBoundary>
      </>
    );
  }
  const view = render(<StatusHarness blocked={false} />);
  const button = screen.getByRole('button', { name: 'Refresh pending installation' });
  const progressStack = screen.getByText('pluginOperationStage.queued').closest('.fixed');
  expect(button.closest('.fixed')).toBe(progressStack);
  expect(button.closest('.pointer-events-auto')).toBeTruthy();
  act(() => operation.finish());
  expect(screen.queryByText('pluginOperationStage.queued')).toBeNull();
  expect(button.closest('.fixed')).toBe(progressStack);
  fireEvent.click(button);
  expect(refresh).toHaveBeenCalledOnce();
  view.rerender(<StatusHarness blocked />);
  fireEvent.click(button);
  expect(refresh).toHaveBeenCalledOnce();
});

test('replaces running feedback with one result after final reconciliation and preserves its failure stage', () => {
  const { owner, notify } = setup();
  const operation = owner.start(options);
  render(
    <>
      <PluginOperationStatus />
      <PluginOperationFeedback />
    </>,
  );
  act(() => {
    notify({
      ...options,
      ...operation.context,
      stage: PluginOperationStage.ENABLING,
      elapsedMs: 2100,
    });
    operation.fail({
      message: 'Required configuration is missing',
      failedStage: PluginOperationStage.ENABLING,
      installationCommitted: true,
    });
    operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByText('pluginOperationStage.refreshing_inventory')).toBeTruthy();

  act(() => operation.finish());
  const dialog = screen.getByRole('alertdialog', {
    name: 'pluginOperationFailureTitle.install.committed',
  });
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  expect(screen.getByText('pluginOperationStageLabel.enabling')).toBeTruthy();
  expect(screen.getByText('Required configuration is missing')).toBeTruthy();
  expect(screen.getByText('pluginOperationInstallationOutcome.committed')).toBeTruthy();
  expect(screen.queryByText('pluginOperationStage.refreshing_inventory')).toBeNull();
  expect(screen.getByText('pluginOperationFailureShortNext.enable')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  expect(dialog.closest('[data-workspace-overlay]')?.className).toContain('z-[80]');
});

test('retains failures across category unmounts and dismisses only the displayed result', () => {
  const { owner } = setup();
  const view = render(<PluginOperationFeedback />);
  view.unmount();
  const first = owner.start(options);
  first.fail({ message: 'First failure' });
  first.finish();
  const second = owner.start({ ...options, label: 'Second tool' });
  second.fail({ message: 'Second failure', operationUnconfirmed: true });
  second.finish();

  render(<PluginOperationFeedback />);
  expect(screen.getByText('First failure')).toBeTruthy();
  expect(screen.queryByText('Second failure')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  expect(
    screen.getByRole('alertdialog', { name: 'pluginOperationFailureTitle.unconfirmed' }),
  ).toBeTruthy();
  expect(screen.getByText('Second failure')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  expect(owner.failureSnapshot()).toEqual([]);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('keeps long details collapsed and copies the original error, supplemental note and batch items', async () => {
  const { owner } = setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const operation = owner.start(options);
  operation.fail({
    message: 'Original native refusal\nMore information',
    details: 'Additional refresh failure',
    items: [
      {
        label: 'Another extension',
        message: 'Another package failed',
        failedStage: PluginOperationStage.CONFIRMING,
        installSourceInUse: true,
      },
    ],
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  const details = screen.getByText('pluginOperationFailureDetails').closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText('pluginOperationFailureItemUnconfirmed')).toBeTruthy();
  openReportDetails();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureCopy' }));
  await waitFor(() => expect(screen.getByText('pluginOperationFailureCopied')).toBeTruthy());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Original native refusal'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Additional refresh failure'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Another package failed'));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(operation.context.requestId));
});

test.each([true, false])(
  'a batch only refers to its item stages when they exist (%s)',
  withStage => {
    const { owner } = setup();
    const operation = owner.start(options);
    operation.fail({
      message: 'One succeeded and one failed',
      items: [
        { label: 'Good package', message: 'Imported successfully', type: 'success' },
        {
          label: 'Invalid package',
          message: 'Native format was rejected',
          type: 'error',
          ...(withStage ? { failedStage: PluginOperationStage.VALIDATING } : {}),
        },
      ],
    });
    operation.finish();
    render(<PluginOperationFeedback />);
    expect(
      screen.getByText(
        withStage
          ? 'pluginOperationFailureStagesInItems'
          : 'pluginOperationFailureStageUnavailable',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        withStage
          ? 'pluginOperationFailureStageUnavailable'
          : 'pluginOperationFailureStagesInItems',
      ),
    ).toBeNull();
    expect(screen.getByText('Imported successfully')).toBeTruthy();
    expect(screen.getByText('Native format was rejected')).toBeTruthy();
    if (withStage) expect(screen.getByText(/pluginOperationStageLabel.validating/)).toBeTruthy();
  },
);

test('a clipboard failure retains the error dialog and reports how to copy manually', async () => {
  const { owner } = setup();
  const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const operation = owner.start(options);
  operation.fail({ message: 'A failed operation' });
  operation.finish();
  render(<PluginOperationFeedback />);

  openReportDetails();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureCopy' }));
  await waitFor(() => expect(screen.getByText('pluginOperationFailureCopyFailed')).toBeTruthy());
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(owner.failureSnapshot()).toHaveLength(1);
});

test('Escape closes only the top error and restores an underlying editor without changing its input', () => {
  const { owner } = setup();
  render(<input aria-label="Unsaved configuration" defaultValue="keep this value" />);
  const input = screen.getByRole('textbox');
  input.focus();
  const underlyingEscape = vi.fn();
  document.addEventListener('keydown', underlyingEscape, true);
  const operation = owner.start(options);
  operation.fail({ message: 'Save was refused' });
  operation.finish();
  render(<PluginOperationFeedback />);
  const dismiss = screen.getByRole('button', { name: 'pluginOperationFailureDismiss' });
  expect(document.activeElement).toBe(dismiss);

  fireEvent.keyDown(dismiss, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(underlyingEscape).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('keep this value');
  document.removeEventListener('keydown', underlyingEscape, true);
});

test('keeps legacy successful and partially successful batch results compatible', () => {
  render(
    <OperationResultModal
      result={{
        type: 'error',
        title: 'Some imports were incomplete',
        message: 'One imported; one failed',
        items: [
          { label: 'Good package', message: 'Imported successfully', type: 'success' },
          {
            label: 'Saved package',
            message: 'Enabling refused',
            failedStage: PluginOperationStage.ENABLING,
            installationCommitted: true,
          },
        ],
      }}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole('alertdialog', { name: 'Some imports were incomplete' })).toBeTruthy();
  expect(screen.getByText('Imported successfully')).toBeTruthy();
  expect(screen.getByText('pluginOperationFailureItemCommitted')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'confirm' })).toBeTruthy();
});

test('a later legacy result cannot take keyboard ownership from the higher error layer', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({ message: 'Visible top failure' });
  operation.finish();
  render(<PluginOperationFeedback />);
  const dismiss = screen.getByRole('button', { name: 'pluginOperationFailureDismiss' });
  const closeLegacy = vi.fn();
  render(
    <OperationResultModal
      result={{ type: 'success', title: 'Another operation completed' }}
      onClose={closeLegacy}
    />,
  );
  expect(document.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(closeLegacy).not.toHaveBeenCalled();
  expect(owner.failureSnapshot()).toEqual([]);
  expect(screen.getByRole('status').textContent).toContain('Another operation completed');
  expect(document.activeElement).not.toBe(
    screen.getByRole('button', { name: 'pluginOperationNoticeDismiss' }),
  );
});

test('shows a completed removal with pending engine recovery without blocking or taking focus and keeps its report available', async () => {
  useActualTranslations('zh');
  const { owner } = setup();
  render(<input aria-label="Plugin search" defaultValue="keep this search" />);
  const input = screen.getByRole('textbox');
  input.focus();
  const operation = owner.start({ ...options, action: PluginOperationAction.REMOVE });
  const reason = '引擎准备观察已被新的准备请求替代。\n原生卸载回执已正常返回。';
  operation.fail({
    message: reason,
    state: PluginOperationFailureState.REFRESH_FAILED,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    elapsedMs: 3200,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
  });
  operation.finish();
  render(<PluginOperationFeedback />);

  expect(screen.queryByRole('alertdialog')).toBeNull();
  const noticeStatus = screen.getByText('插件已卸载').closest('[role="status"]')!;
  expect(noticeStatus.textContent).toContain('AI 引擎状态待确认');
  expect(document.activeElement).toBe(input);
  expect(screen.getByText('请查看标题栏的 AI 引擎状态，无需重复操作插件。')).toBeTruthy();
  expect(document.querySelector('.animate-spin')).toBeNull();
  expect(screen.queryByRole('button', { name: /重试|卸载|启动|刷新/ })).toBeNull();
  const details = screen.getByText('查看详情').closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText(reason, { normalizer: value => value }).closest('details')).toBe(details);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(details.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: '复制详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain(reason);
  expect(writeText.mock.calls[0][0]).toContain('待确认环节');
  expect(writeText.mock.calls[0][0]).toContain('已用时 3 秒');
  expect(writeText.mock.calls[0][0]).toContain(operation.context.requestId);
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
  expect(owner.failureSnapshot()).toEqual([]);
  expect((input as HTMLInputElement).value).toBe('keep this search');
});

test('waits for fresh Main admission before retiring pending recovery and then closes clean success after three seconds', async () => {
  const { owner, bridge } = setup();
  const engine = setupEngineReadiness(bridge, true);
  render(<PluginOperationFeedback />);
  await waitFor(() => expect(getEngineReadinessSnapshot().ready).toBe(true));
  const readsBeforeResult = engine.getState.mock.calls.length;
  let resolveState!: (state: AppInitializationState) => void;
  engine.admit(false, false);
  engine.getState.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveState = resolve;
      }),
  );

  act(() => {
    const operation = owner.start(options);
    operation.fail({
      message: 'Native installation completed; recovery observation was replaced.',
      state: PluginOperationFailureState.COMMITTED,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
      mutationCompleted: true,
      runtimeRecoveryPending: true,
    });
    operation.finish();
  });
  expect(engine.getState.mock.calls.length).toBeGreaterThan(readsBeforeResult);
  expect(owner.failureSnapshot()[0].runtimeRecovered).toBeUndefined();
  expect(screen.getByText('pluginOperationRecoveryPending')).toBeTruthy();

  await act(async () => resolveState(engine.state()));
  expect(getEngineReadinessSnapshot().status?.phase).toBe(EnginePhase.Running);
  expect(getEngineReadinessSnapshot().ready).toBe(false);
  expect(owner.failureSnapshot()[0].runtimeRecovered).toBeUndefined();

  vi.useFakeTimers();
  await act(async () => engine.admit(true));
  expect(owner.failureSnapshot()[0]).toMatchObject({
    state: PluginOperationFailureState.COMMITTED,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
    runtimeRecovered: true,
  });
  expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
  expect(screen.queryByText('pluginOperationRecoveryPendingNext')).toBeNull();
  expect(screen.getByText('pluginOperationFailureLastStage')).toBeTruthy();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  act(() => vi.advanceTimersByTime(2999));
  expect(owner.failureSnapshot()).toHaveLength(1);
  act(() => engine.fail('A later unrelated engine failure'));
  expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
  expect(screen.queryByText('A later unrelated engine failure')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(owner.failureSnapshot()).toEqual([]);
});

test.each([false, true])(
  'rereads an already admitted engine when a late result is received (view remounted: %s)',
  async remount => {
    const { owner, bridge } = setup();
    const engine = setupEngineReadiness(bridge, true);
    const view = render(<PluginOperationFeedback />);
    await waitFor(() => expect(getEngineReadinessSnapshot().ready).toBe(true));
    const readsBeforeResult = engine.getState.mock.calls.length;
    if (remount) view.unmount();
    act(() => {
      const operation = owner.start(options);
      operation.fail({
        message: 'Native installation completed; its earlier readiness observation was superseded.',
        state: PluginOperationFailureState.COMMITTED,
        mutationCompleted: true,
        runtimeRecoveryPending: true,
      });
      operation.finish();
    });
    if (remount) render(<PluginOperationFeedback />);

    await waitFor(() => expect(owner.failureSnapshot()[0].runtimeRecovered).toBe(true));
    expect(engine.getState.mock.calls.length).toBeGreaterThan(readsBeforeResult);
    expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  },
);

test.each([false, true])(
  'follows a superseding readiness read before resolving a pending notice (new admission: %s)',
  async ready => {
    const { owner, bridge } = setup();
    const engine = setupEngineReadiness(bridge, true);
    render(<PluginOperationFeedback />);
    await waitFor(() => expect(getEngineReadinessSnapshot().ready).toBe(true));
    let resolveFirstState!: (state: AppInitializationState) => void;
    let resolveLatestState!: (state: AppInitializationState) => void;
    let resolveFirstStatus!: (result: { success: boolean; status: OpenClawEngineStatus }) => void;
    engine.getState
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirstState = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveLatestState = resolve;
          }),
      );
    engine.getStatus.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirstStatus = resolve;
        }),
    );
    engine.admit(ready, false);
    await act(async () => {
      const operation = owner.start(options);
      operation.fail({
        message: 'Native installation completed; recovery observation was replaced.',
        state: PluginOperationFailureState.COMMITTED,
        mutationCompleted: true,
        runtimeRecoveryPending: true,
      });
      operation.finish();
    });
    let latest!: Promise<boolean>;
    await act(async () => {
      latest = refreshEngineReadiness();
    });
    await act(async () => {
      resolveFirstState({ ...engine.state(), enginePreparationPending: true });
      resolveFirstStatus({
        success: true,
        status: { phase: EnginePhase.Starting, version: 'test', canRetry: false },
      });
    });
    expect(getEngineReadinessSnapshot().ready).toBe(true);
    expect(owner.failureSnapshot()[0].runtimeRecovered).toBeUndefined();
    expect(screen.getByText('pluginOperationRecoveryPending')).toBeTruthy();

    await act(async () => resolveLatestState(engine.state()));

    await expect(latest).resolves.toBe(ready);
    expect(owner.failureSnapshot()[0].runtimeRecovered).toBe(ready ? true : undefined);
    expect(Boolean(screen.queryByText('pluginOperationRecoveryPending'))).toBe(!ready);
  },
);

test('keeps verbatim supplemental information after recovery and preserves its historical report across later failure and remount', async () => {
  const { owner, bridge } = setup();
  const engine = setupEngineReadiness(bridge);
  const operation = owner.start(options);
  const message = 'Native installation completed; recovery verification was superseded.';
  const supplement = 'The inventory could not be read.\nAdditional diagnostic information.';
  operation.fail({
    message,
    details: supplement,
    state: PluginOperationFailureState.COMMITTED,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
  });
  operation.finish();
  const view = render(<PluginOperationFeedback />);
  await waitFor(() => expect(engine.getState).toHaveBeenCalled());
  vi.useFakeTimers();
  await act(async () => engine.admit(true));

  expect(owner.failureSnapshot()[0].runtimeRecovered).toBe(true);
  expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
  const visibleSupplement = screen.getByText(supplement, { normalizer: value => value });
  expect(visibleSupplement.closest('details')).toBeNull();
  expect(visibleSupplement.className).toContain('whitespace-pre-wrap');
  expect(visibleSupplement.className).toContain('max-h-32');
  act(() => vi.advanceTimersByTime(10000));
  expect(owner.failureSnapshot()).toHaveLength(1);

  openReportDetails();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'pluginOperationReportCopy' })),
  );
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0][0]).toContain(message);
  expect(writeText.mock.calls[0][0]).toContain(supplement);
  expect(writeText.mock.calls[0][0]).toContain('pluginOperationFailureLastStage');
  expect(writeText.mock.calls[0][0]).not.toContain('pluginOperationPendingStage');
  expect(writeText.mock.calls[0][0]).not.toContain('pluginOperationRecoveryPendingNext');

  act(() => engine.fail('A later unrelated failure'));
  view.unmount();
  render(<PluginOperationFeedback />);
  expect(
    screen.getByText(supplement, { normalizer: value => value }).closest('details'),
  ).toBeNull();
  expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
  expect(screen.queryByText('A later unrelated failure')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(owner.failureSnapshot()[0]).toMatchObject({
    message,
    details: supplement,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
    runtimeRecovered: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationNoticeDismiss' }));
  expect(owner.failureSnapshot()).toEqual([]);
});

test('a recovered notice stays paused while either its report has focus or the pointer remains over it', () => {
  vi.useFakeTimers();
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'Native installation completed.',
    state: PluginOperationFailureState.COMMITTED,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
  });
  operation.finish();
  owner.confirmRuntimeRecovery([operation.context.requestId]);
  const close = vi.fn();
  render(
    <OperationResultNotice
      result={{ type: 'success', title: 'Installation completed' }}
      operation={owner.failureSnapshot()[0]}
      runtimeRecovered
      onClose={close}
    />,
  );
  const summary = screen.getByText('pluginOperationReportDetails');
  const notice = summary.closest('.rounded-xl')!;
  act(() => summary.focus());
  fireEvent.mouseEnter(notice);
  fireEvent.mouseLeave(notice);
  act(() => vi.advanceTimersByTime(10000));
  expect(document.activeElement).toBe(summary);
  expect(close).not.toHaveBeenCalled();

  fireEvent.mouseEnter(notice);
  act(() => summary.blur());
  act(() => vi.advanceTimersByTime(10000));
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseLeave(notice);
  act(() => vi.advanceTimersByTime(3000));
  expect(close).toHaveBeenCalledOnce();
});

test.each([
  {
    name: 'saved content without a completed mutation receipt',
    failure: {
      installationCommitted: true,
      runtimeRecoveryPending: true,
      state: PluginOperationFailureState.COMMITTED,
    },
    title: 'pluginOperationFailureTitle.install.committed',
  },
  {
    name: 'an unconfirmed mutation',
    failure: { mutationCompleted: true, runtimeRecoveryPending: true, operationUnconfirmed: true },
    title: 'pluginOperationFailureTitle.unconfirmed',
  },
  {
    name: 'a prior business failure',
    failure: {
      mutationCompleted: true,
      runtimeRecoveryPending: true,
      state: PluginOperationFailureState.FAILED,
    },
    title: 'pluginOperationFailureTitle.install',
  },
  {
    name: 'a mixed batch',
    failure: {
      mutationCompleted: true,
      runtimeRecoveryPending: true,
      items: [
        { label: 'Saved package', message: 'Saved', type: 'success' },
        { label: 'Unconfirmed package', message: 'No receipt', operationUnconfirmed: true },
      ],
    },
    title: 'pluginOperationFailureTitle.batch',
  },
])(
  'keeps $name in the result modal even when engine recovery is pending',
  async ({ failure, title }) => {
    const { owner, bridge } = setup();
    setupEngineReadiness(bridge, true);
    const operation = owner.start(options);
    operation.fail({
      message: 'Reported result',
      state: PluginOperationFailureState.REFRESH_FAILED,
      failedStage: PluginOperationStage.PREPARING_RUNTIME,
      ...failure,
    } as PluginOperationFailureInput);
    operation.finish();
    render(<PluginOperationFeedback />);
    await waitFor(() => expect(getEngineReadinessSnapshot().ready).toBe(true));
    expect(screen.getByRole('alertdialog', { name: title })).toBeTruthy();
    expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
    expect(owner.failureSnapshot()[0].runtimeRecovered).toBeUndefined();
  },
);

test('a pending recovery notice never hides a later real failure and dismissal leaves the other result intact', () => {
  const { owner } = setup();
  const pending = owner.start({ ...options, action: PluginOperationAction.REMOVE });
  pending.fail({
    message: 'A newer engine preparation owns recovery',
    state: PluginOperationFailureState.REFRESH_FAILED,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
  });
  pending.finish();
  const failed = owner.start({ ...options, label: 'Invalid package' });
  failed.fail({
    message: 'The package has no manifest',
    failedStage: PluginOperationStage.VALIDATING,
  });
  failed.finish();
  render(<PluginOperationFeedback />);
  expect(
    screen.getByRole('alertdialog', { name: 'pluginOperationFailureTitle.install' }),
  ).toBeTruthy();
  expect(screen.getByText('pluginOperationCompleted.remove')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationFailureDismiss' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(owner.failureSnapshot().map(result => result.requestId)).toEqual([
    pending.context.requestId,
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationNoticeDismiss' }));
  expect(owner.failureSnapshot()).toEqual([]);
});

test('a completed install with a real engine error remains a warning modal with its original reason', () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'The engine process exited during preparation',
    state: PluginOperationFailureState.REFRESH_FAILED,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    mutationCompleted: true,
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  expect(
    screen.getByRole('alertdialog', { name: 'pluginOperationFailureTitle.install.completed' }),
  ).toBeTruthy();
  expect(screen.getByText('The engine process exited during preparation')).toBeTruthy();
  expect(screen.queryByText('pluginOperationRecoveryPending')).toBeNull();
});

test('keeps a native cause on the second line visible outside collapsed details', () => {
  const { owner } = setup();
  const operation = owner.start({ ...options, action: PluginOperationAction.ENABLE });
  const reason =
    'Plugin enable setting saved.\nEngine startup failed: a local dependency is missing.';
  operation.fail({
    message: reason,
    state: PluginOperationFailureState.REFRESH_FAILED,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  const visibleReason = screen.getByText(reason, { normalizer: value => value });
  expect(visibleReason.closest('details')).toBeNull();
  expect(visibleReason.className).toContain('whitespace-pre-wrap');
  expect(visibleReason.className).toContain('max-h-32');
  expect(document.querySelector('details')!.open).toBe(false);
});

test('shows a fully completed batch with only pending engine recovery as one nonblocking notice and preserves each report', async () => {
  const { owner } = setup();
  const operation = owner.start(options);
  operation.fail({
    message: 'Both packages were installed; engine recovery still needs confirmation.',
    state: PluginOperationFailureState.COMMITTED,
    mutationCompleted: true,
    runtimeRecoveryPending: true,
    items: [
      {
        label: 'First package',
        message: 'Native install completed; recovery observation replaced.',
        type: 'success',
        mutationCompleted: true,
        runtimeRecoveryPending: true,
        failedStage: PluginOperationStage.PREPARING_RUNTIME,
      },
      {
        label: 'Second package',
        message: 'Native install completed.',
        type: 'success',
        mutationCompleted: true,
      },
    ],
  });
  operation.finish();
  render(<PluginOperationFeedback />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByText('pluginOperationCompleted.install')).toBeTruthy();
  const details = screen.getByText('pluginOperationReportDetails').closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText('First package').closest('details')).toBe(details);
  expect(screen.getByText('Second package').closest('details')).toBe(details);
  fireEvent.click(details.querySelector('summary')!);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationReportCopy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain(
    'Native install completed; recovery observation replaced.',
  );
  expect(writeText.mock.calls[0][0]).toContain('Native install completed.');
});

test('clean success preserves source information in a brief shared notice without taking focus', () => {
  vi.useFakeTimers();
  setup();
  render(<input aria-label="Unsaved plugin settings" defaultValue="keep me" />);
  const input = screen.getByRole('textbox');
  input.focus();
  const close = vi.fn();
  const message = 'Skill removed.\nThe active source is now the bundled copy.';
  render(
    <OperationResultModal
      result={{ type: 'success', title: 'Skill removed', message }}
      onClose={close}
    />,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(
    'The active source is now the bundled copy.',
  );
  expect(screen.getByText(message, { normalizer: value => value }).closest('.fixed')).toBeTruthy();
  expect(document.activeElement).toBe(input);
  act(() => vi.advanceTimersByTime(2999));
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseEnter(screen.getByText('Skill removed', { exact: true }).closest('.rounded-xl')!);
  act(() => vi.advanceTimersByTime(3000));
  expect(close).not.toHaveBeenCalled();
  fireEvent.mouseLeave(screen.getByText('Skill removed', { exact: true }).closest('.rounded-xl')!);
  act(() => vi.advanceTimersByTime(3000));
  expect(close).toHaveBeenCalledOnce();
});

test('an explicit success advisory remains available until dismissed', () => {
  vi.useFakeTimers();
  setup();
  const close = vi.fn();
  render(
    <OperationResultModal
      result={{
        type: 'success',
        title: 'Skill removed',
        message: 'The active source is now the bundled copy.',
        persistent: true,
      }}
      onClose={close}
    />,
  );
  act(() => vi.advanceTimersByTime(10000));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByText('The active source is now the bundled copy.')).toBeTruthy();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'pluginOperationNoticeDismiss' }));
  expect(close).toHaveBeenCalledOnce();
});
