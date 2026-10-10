import { describe, expect, it } from 'vitest';

import { decodeNativeCanvasResult, type NativeCanvasPreview } from '../../pipeline/native-canvas';
import { WidgetFailure, widgetRebuildDraft } from './rebuild';

const translate = (key: string) => key;
const preview = () =>
  decodeNativeCanvasResult(
    JSON.stringify({
      kind: 'canvas',
      presentation: { target: 'assistant_message', sandbox: 'scripts', title: '"Quoted"\ntitle' },
      view: { id: 'cv_known' },
    }),
    'show_widget',
    'call-1',
  )!;

describe('user-requested widget recreation', () => {
  it('includes only the verified document identity and a closed failure category', () => {
    const draft = widgetRebuildDraft(preview(), WidgetFailure.LOAD, translate);
    expect(draft).toContain('coworkWidgetRebuildLoad');
    expect(draft).not.toContain('coworkWidgetRebuildRuntime');
    expect(JSON.parse(draft.split('\n').slice(-1)[0])).toEqual({
      document: 'cv_known',
      title: '"Quoted"\ntitle',
    });
    expect(draft.length).toBeLessThan(4000);
    expect(widgetRebuildDraft(preview(), WidgetFailure.RUNTIME, translate)).toContain(
      'coworkWidgetRebuildRuntime',
    );
  });

  it('cannot turn a copied or model-authored descriptor into a recreation suggestion', () => {
    const copied = { ...preview() } as NativeCanvasPreview;
    expect(widgetRebuildDraft(copied, WidgetFailure.LOAD, translate)).toBe('');
  });
});
