import React from 'react';

import { NativeVideoModelSettings } from './NativeVideoModelSettings';
import NonLanguageModelEditor, { type NonLanguageModelEditorProps } from './NonLanguageModelEditor';

export { parseDiscoveredVoices, parseOpenApiDefaultModels } from './NonLanguageModelEditor';
export {
  buildNonLanguageModelEndpointPreview,
  buildNonLanguageModelModelsUrl,
  type NonLanguageModelKind,
  normalizeNonLanguageModelBaseUrl,
} from './nonLanguageModelUrls';

type Props = Pick<NonLanguageModelEditorProps, 'kind' | 'category' | 'setCategory'>;

const NonLanguageModelSettings: React.FC<Props> = props =>
  props.kind === 'video' ? (
    <NativeVideoModelSettings category={props.category} setCategory={props.setCategory} />
  ) : (
    <NonLanguageModelEditor {...props} />
  );

export default NonLanguageModelSettings;
