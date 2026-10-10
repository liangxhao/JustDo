import { isNativeCanvasPreview, type NativeCanvasPreview } from '../../pipeline/native-canvas';

export const WidgetFailure = { LOAD: 'load', RUNTIME: 'runtime' } as const;
export type WidgetFailureKind = (typeof WidgetFailure)[keyof typeof WidgetFailure];

/** A bounded request about a verified document, never a copy of its HTML or errors. */
export function widgetRebuildDraft(
  preview: NativeCanvasPreview,
  failure: WidgetFailureKind,
  translate: (key: string) => string,
): string {
  if (!isNativeCanvasPreview(preview)) return '';
  const identity = {
    title: (preview.title ?? translate('coworkCanvasTitle')).slice(0, 200),
    document: preview.docId,
  };
  const reason = translate(
    failure === WidgetFailure.RUNTIME ? 'coworkWidgetRebuildRuntime' : 'coworkWidgetRebuildLoad',
  );
  return `${translate('coworkWidgetRebuildPrompt')}\n${reason}\n${JSON.stringify(identity)}`;
}
