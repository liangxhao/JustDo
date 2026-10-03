import { createContext } from 'react';

// Preview actions keep their local state while sharing the workspace's fixed toolbar.
export const FilePreviewToolbarContext = createContext<HTMLDivElement | null>(null);
