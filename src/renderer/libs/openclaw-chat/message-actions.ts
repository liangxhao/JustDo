import type { MessageFileLinkTarget } from '@shared/preview/messageFileLink';

import type { NativeMessageQuote } from '../../../../plugins/sdk/app-plugin-sdk/metadata';

export type { NativeMessageQuote } from '../../../../plugins/sdk/app-plugin-sdk/metadata';

export const IMAGE_PREVIEW_EVENT = 'cowork:preview-image';

export type MessageQuoteHandler = (
  quote: NativeMessageQuote,
  target: 'composer' | 'side-chat',
) => void;

/** The receiving workspace owns preparation, routing and navigation lifetime. */
export type OpenMessageFileLink = (
  target: MessageFileLinkTarget,
  options?: { legacyHtml?: boolean },
) => void;
