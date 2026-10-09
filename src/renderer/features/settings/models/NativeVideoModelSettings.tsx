import { NATIVE_VIDEO_PROVIDERS } from '@shared/providers/nativeVideoProviders';
import React from 'react';

import { useExtensionEnablement } from '@/features/plugins/extensions/useExtensionEnablement';

import NonLanguageModelEditor, { type NonLanguageModelEditorProps } from './NonLanguageModelEditor';

type Props = Omit<NonLanguageModelEditorProps, 'kind' | 'videoProviders' | 'videoProvidersLoaded'>;

export const NativeVideoModelSettings: React.FC<Props> = props => {
  const extensions = useExtensionEnablement();
  const providers = NATIVE_VIDEO_PROVIDERS.filter(entry => extensions.enabled.has(entry.id));
  return (
    <NonLanguageModelEditor
      {...props}
      kind="video"
      videoProviders={providers}
      videoProvidersLoaded={extensions.loaded}
    />
  );
};
