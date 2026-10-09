import type { BrowserRecordingStep } from '@shared/browser/browserRecording';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import { recordingActionValue, recordingElementKind } from './browserRecordingPresentation';

const step: BrowserRecordingStep = {
  id: 's',
  pageId: 'p',
  at: 0,
  title: '',
  url: '',
  action: 'scroll',
  value: '0,700',
};
beforeEach(() => i18nService.setLanguage('zh', { persist: false }));
describe('human-readable recording details', () => {
  it('explains scroll coordinates as absolute positions, not gesture distances', () => {
    expect(recordingActionValue(step)).toEqual({
      label: '滚动到的位置',
      text: '横向 0 像素 · 纵向 700 像素',
    });
    expect(recordingActionValue({ ...step, value: '-20, 12.5' }).text).toBe(
      '横向 -20 像素 · 纵向 12.5 像素',
    );
  });
  it('does not invent coordinates for malformed legacy data', () => {
    expect(recordingActionValue({ ...step, value: 'unknown' }).text).toBe('unknown');
    expect(recordingActionValue({ ...step, value: ',700' }).text).toBe(',700');
  });
  it('labels keys and selection states separately from input content', () => {
    expect(recordingActionValue({ ...step, action: 'key', value: 'Enter' })).toEqual({
      label: '按下按键',
      text: 'Enter',
    });
    expect(
      recordingActionValue({
        ...step,
        action: 'select',
        value: 'false',
        target: { tag: 'input', role: 'checkbox', name: '', selector: '' },
      }),
    ).toEqual({ label: '选中状态', text: '未选中' });
    expect(
      recordingActionValue({
        ...step,
        action: 'select',
        value: 'false',
        target: { tag: 'select', role: '', name: '', selector: '' },
      }),
    ).toEqual({ label: '选择结果', text: 'false' });
  });
  it('uses human element types without pretending to reproduce website appearance', () => {
    expect(
      recordingElementKind({
        ...step,
        target: { tag: 'div', role: '', name: '行业分布', selector: '' },
      }),
    ).toBe('页面区域');
    expect(
      recordingElementKind({
        ...step,
        target: { tag: 'div', role: 'button', name: 'Go', selector: '' },
      }),
    ).toBe('按钮');
  });
  it('supports English and never formats a password value', () => {
    i18nService.setLanguage('en', { persist: false });
    expect(recordingActionValue(step).text).toBe('Horizontal 0 px · Vertical 700 px');
    expect(recordingActionValue({ ...step, sensitive: true, value: 'private' }).text).toBe(
      'Password not recorded',
    );
  });
});
