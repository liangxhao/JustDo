import './index.css';
// Configure Monaco Editor for offline use (must be imported before any Monaco usage)
import '@/app/monacoConfig';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';

import { registerRendererDiagnostics } from '@/app/rendererDiagnostics';
import { rendererPreferences } from '@/services/rendererPreferences';

registerRendererDiagnostics();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

async function startRenderer(): Promise<void> {
  // Hydrate before slice initializers and theme consumers run on the new HTTP origin.
  await rendererPreferences.initialize();
  const [{ default: App }, { store }] = await Promise.all([import('@/app/App'), import('@/store')]);
  ReactDOM.createRoot(rootElement!).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>,
  );
}

void startRenderer().catch(error => {
  console.error('Failed to render the app:', error);
});
