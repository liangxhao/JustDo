/**
 * Monaco Editor Configuration for Offline Use
 * Uses vite-plugin-monaco-editor for worker bundling
 * This ensures Monaco works offline without CDN dependencies
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Configure loader to use local monaco package (not CDN)
loader.config({ monaco });

// Initialize loader
loader.init().then(() => {
  console.log('Monaco Editor initialized (offline mode)');
});

export { monaco };
