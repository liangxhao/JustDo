import { NATIVE_VIDEO_PROVIDERS } from '@shared/providers/nativeVideoProviders';
import React from 'react';

import NonLanguageModelEditor, { type NonLanguageModelEditorProps } from './NonLanguageModelEditor';

type Props = Omit<NonLanguageModelEditorProps, 'kind' | 'videoProviders'>;

/** Local catalog editing does not require live Gateway plugin discovery. */
export const NativeVideoModelSettings: React.FC<Props> = props => (
  <NonLanguageModelEditor {...props} kind="video" videoProviders={NATIVE_VIDEO_PROVIDERS} />
);
