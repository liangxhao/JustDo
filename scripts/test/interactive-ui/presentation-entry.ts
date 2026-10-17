import '../../../src/renderer/libs/openclaw-chat/components/native-widget/view';
import { decodeNativeCanvasResult } from '../../../src/renderer/libs/openclaw-chat/pipeline/native-canvas';
import type { NativeWidgetView } from '../../../src/renderer/libs/openclaw-chat/components/native-widget/view';

// Test-only host adapter. Document bytes and descriptor come from the isolated real Gateway.
Object.assign(window, {
  mountPresentation(input: { descriptor: unknown; view: unknown; gatewayUrl: string }) {
    const widget = document.createElement('justdo-native-widget') as NativeWidgetView;
    widget.preview = decodeNativeCanvasResult(
      JSON.stringify(input.descriptor),
      'show_widget',
      'presentation-call',
    );
    widget.context = {
      client: {
        generation: 1,
        gatewayUrl: input.gatewayUrl,
        request: async <T>() => input.view as T,
      },
      generation: 1,
      sessionKey: 'presentation-session',
      isCurrent: () => true,
      canDraft: () => true,
    };
    document.getElementById('preview')!.replaceChildren(widget);
    return widget.updateComplete;
  },
});
