import { withMediaAdapters } from './media-adapters';
import native from './native-index.mjs';

export default {
  ...native,
  register: (api: Parameters<NonNullable<typeof native.register>>[0]) =>
    native.register?.(withMediaAdapters(api)),
};
