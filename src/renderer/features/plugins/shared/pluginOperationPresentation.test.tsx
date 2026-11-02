// @vitest-environment jsdom
import { PluginKind } from '@shared/plugins/marketplace';
import { PluginOperationAction, PluginOperationStage } from '@shared/plugins/pluginOperation';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { pluginsTranslations } from '@/services/i18n/pluginsTranslations';

import PluginOperationFeedback from './PluginOperationFeedback';
import { pluginOperationFailurePresentation } from './pluginOperationPresentation';
import {
  getPluginOperationOwner,
  type PluginOperationFailureInput,
  PluginOperationFailureState,
} from './pluginOperationService';

const locale = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('@/services/i18n', async () => {
  const { pluginsTranslations: dictionaries } = await import('@/services/i18n/pluginsTranslations');
  return {
    i18nService: {
      getLanguage: () => locale.language,
      t: (key: string) => {
        const dictionary = dictionaries[locale.language] as Record<string, string>;
        const common: Record<string, string> = { close: 'Close', confirm: 'Confirm' };
        return dictionary[key] ?? common[key] ?? key;
      },
    },
  };
});

const writeText = vi.fn<(_value: string) => Promise<void>>();

beforeEach(() => {
  locale.language = 'zh';
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(window, 'electron', { configurable: true, value: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function showFailure(
  failure: PluginOperationFailureInput,
  action: PluginOperationAction = PluginOperationAction.UPDATE,
) {
  const owner = getPluginOperationOwner();
  const operation = owner.start({ kind: PluginKind.EXTENSION, action, label: 'Sample extension' });
  operation.fail(failure);
  operation.finish();
  render(<PluginOperationFeedback />);
  return { dialog: screen.getByRole('alertdialog'), requestId: operation.context.requestId };
}

function guidanceIn(dialog: HTMLElement): HTMLElement {
  const heading = within(dialog).getByRole('heading', { name: '接下来可以做什么' });
  return heading.nextElementSibling as HTMLElement;
}

function openReportDetails(dialog: HTMLElement) {
  const details = dialog.querySelector('details')!;
  if (!details.open) fireEvent.click(details.querySelector('summary')!);
}

function batchItem(label: string): HTMLElement {
  return screen.getByText(label, { exact: true }).parentElement!.parentElement!;
}

test('explains a saved update with its failed restart and points to the visible title-bar status', async () => {
  const reason = '运行环境启动失败。\n本地依赖 runtime-helper 不可用。';
  const { dialog, requestId } = showFailure({
    message: reason,
    installationCommitted: true,
    failedStage: PluginOperationStage.RESTARTING_GATEWAY,
  });

  expect(screen.getByRole('alertdialog', { name: /更新内容已保存.*重启运行环境并重新连接/ })).toBe(
    dialog,
  );
  const displayedReason = within(dialog).getByText(reason, { normalizer: value => value });
  expect(displayedReason.className).toContain('whitespace-pre-wrap');
  const guidance = guidanceIn(dialog).textContent!;
  expect(guidance).toContain('标题栏');
  expect(guidance).toContain('查看原因');
  expect(guidance).not.toMatch(/设置|通用|重新启动 AI 引擎/);
  expect(
    within(dialog).getByText(
      pluginsTranslations.zh['pluginOperationInstallationOutcome.committed'],
    ),
  ).toBeTruthy();
  expect(dialog.textContent).not.toContain('pluginOperation');

  openReportDetails(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = writeText.mock.calls[0][0];
  expect(copied).toContain(reason);
  expect(copied).toContain('重启运行环境并重新连接');
  expect(copied).toContain(guidance);
  expect(copied).toContain(requestId);
  expect(copied).toContain('仅在提供“启动 AI 引擎”按钮时');
  expect(copied).toMatch(/不要.*安装或卸载/);
});

test('explicitly reports missing stage and cause instead of inventing a repair, and offers evidence to copy', async () => {
  const { dialog, requestId } = showFailure({ message: '', installationCommitted: true });

  expect(screen.getByRole('alertdialog', { name: /更新内容已保存.*服务未返回出错步骤/ })).toBe(
    dialog,
  );
  expect(within(dialog).getByText('未收到步骤信息')).toBeTruthy();
  expect(within(dialog).getByText(/服务没有返回具体错误原因/)).toBeTruthy();
  const guidance = guidanceIn(dialog).textContent!;
  expect(guidance).toContain('服务未返回出错步骤');
  expect(guidance).toContain('操作编号');
  expect(guidance).toContain('管理员');
  expect(guidance).not.toMatch(/重新启动|手动启用/);
  expect(dialog.textContent).not.toContain('pluginOperation');

  openReportDetails(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain(guidance);
  expect(writeText.mock.calls[0][0]).toContain(requestId);
});

test('keeps an unknown result unknown even with a restart stage and gives only read-only verification advice', () => {
  const { dialog } = showFailure({
    message: '插件变更请求已发送，尚未收到最终回执。',
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.RESTARTING_GATEWAY,
  });

  expect(screen.getByRole('alertdialog', { name: '操作状态待确认' })).toBe(dialog);
  const stage = within(dialog).getByText('最后已知步骤').parentElement!;
  expect(stage.textContent).toContain('重启运行环境并重新连接');
  const guidance = guidanceIn(dialog).textContent!;
  expect(guidance).toContain('核对最新状态');
  expect(guidance).toContain('不要重复提交');
  expect(guidance).not.toMatch(/重新启动|重启|手动启用|重试/);
  expect(within(dialog).queryByRole('button', { name: /重试|安装|重启/ })).toBeNull();
  expect(dialog.textContent).not.toContain('更新内容已保存');
});

test('provides a specific confirmation title and usable status advice in English', () => {
  locale.language = 'en';
  const presentation = pluginOperationFailurePresentation({
    action: PluginOperationAction.UPDATE,
    state: PluginOperationFailureState.COMMITTED,
    failedStage: PluginOperationStage.CONFIRMING,
  });

  expect(presentation.title).toBe('Update saved, but plugin status could not be confirmed');
  expect(presentation.guidance).toMatch(/check its version, switch and availability/i);
  expect(presentation.guidance).toMatch(/do not install or remove it again/i);
  expect(presentation.guidance).not.toMatch(/restart AI engine|enable.*manually/i);
  expect(JSON.stringify(presentation)).not.toContain('pluginOperation');
});

test('preserves saved content while treating an unconfirmed activation as read-only', async () => {
  const reason = '安装内容已保存，启用请求已发送，但最终回执丢失。';
  const { dialog } = showFailure({
    message: reason,
    installationCommitted: true,
    operationUnconfirmed: true,
    failedStage: PluginOperationStage.ENABLING,
  });

  expect(screen.getByRole('alertdialog', { name: '更新内容已保存，但最终结果仍待确认' })).toBe(
    dialog,
  );
  expect(within(dialog).getByText('最后已知步骤').parentElement!.textContent).toContain('启用插件');
  expect(guidanceIn(dialog).textContent).toContain('不要重复提交');
  expect(guidanceIn(dialog).textContent).not.toMatch(/手动启用|重启|重新启动/);
  expect(getPluginOperationOwner().failureSnapshot()[0]).toMatchObject({
    state: PluginOperationFailureState.COMMITTED,
    installationCommitted: true,
    operationUnconfirmed: true,
  });
  openReportDetails(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0][0]).toContain('更新内容已保存，但最终结果仍待确认');
  expect(writeText.mock.calls[0][0]).toContain('最后已知步骤: 启用插件');
  expect(writeText.mock.calls[0][0]).toContain(reason);
});

test('does not suggest enabling a plugin when disabling it failed while applying configuration', () => {
  const presentation = pluginOperationFailurePresentation({
    action: PluginOperationAction.DISABLE,
    state: PluginOperationFailureState.FAILED,
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });

  expect(presentation.title).toBe('关闭未完成');
  expect(presentation.guidance).toContain('核对版本、开关和可用状态');
  expect(presentation.guidance).toContain('不要重复提交');
  expect(presentation.guidance).not.toMatch(/启用|修正后保存|重新安装/);
});

test('keeps mixed batch facts and advice with each item instead of claiming one overall saved outcome or failed stage', async () => {
  const { dialog } = showFailure({
    message: '部分项目未完成。',
    state: PluginOperationFailureState.COMMITTED,
    failedStage: PluginOperationStage.RESTARTING_GATEWAY,
    items: [
      { label: 'Installed package', type: 'success', message: '该项目已安装。' },
      {
        label: 'Invalid package',
        type: 'error',
        message: '安装包缺少清单文件。',
        failedStage: PluginOperationStage.VALIDATING,
      },
      {
        label: 'Saved package',
        type: 'error',
        message: '服务地址尚未配置，插件无法启用。',
        installationCommitted: true,
        failedStage: PluginOperationStage.ENABLING,
      },
      {
        label: 'Unconfirmed package',
        type: 'error',
        message: '最终回执尚未收到。',
        operationUnconfirmed: true,
        failedStage: PluginOperationStage.RESTARTING_GATEWAY,
      },
    ],
  });

  expect(screen.getByRole('alertdialog', { name: '插件操作未全部完成' })).toBe(dialog);
  expect(within(dialog).getByText('未完成步骤').parentElement!.textContent).toContain(
    '详见下方各项',
  );
  expect(
    within(dialog).queryByText(
      pluginsTranslations.zh['pluginOperationInstallationOutcome.committed'],
    ),
  ).toBeNull();
  expect(guidanceIn(dialog).textContent).toContain('请逐项核对');
  const invalid = batchItem('Invalid package');
  expect(within(invalid).getByText(/联系插件提供方检查安装包/)).toBeTruthy();
  expect(invalid.textContent).not.toContain('已经保存');
  const saved = batchItem('Saved package');
  expect(within(saved).getByText(/在插件详情核对依赖/)).toBeTruthy();
  expect(saved.textContent).toContain('无需重新安装');
  const unconfirmed = batchItem('Unconfirmed package');
  expect(unconfirmed.textContent).toContain('最后已知步骤');
  const verification = within(unconfirmed).getByText(/请先核对最新状态/);
  expect(verification.textContent).toContain('不要重复提交');
  expect(verification.textContent).not.toMatch(/重新启动|重试/);
  expect(dialog.textContent).not.toContain('pluginOperation');

  openReportDetails(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: '复制错误详情' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const copied = writeText.mock.calls[0][0];
  expect(copied).toContain('安装包缺少清单文件。');
  expect(copied).toContain('联系插件提供方核对格式、安全校验或兼容性');
  expect(copied).toContain('先查看插件详情中的依赖说明');
  expect(copied).toContain('目前无法确认最终结果');
});
