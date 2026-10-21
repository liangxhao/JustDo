import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { registerRendererDiagnostics } from '@/app/rendererDiagnostics';
import { RendererStartupActivity } from '@/app/shell/initialization/startupPresentation';
import { rendererPreferences } from '@/services/rendererPreferences';

registerRendererDiagnostics();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

async function startRenderer(): Promise<void> {
  document
    .getElementById('startup-document')
    ?.setAttribute('data-activity', RendererStartupActivity.Preferences);
  // Hydrate before slice initializers and theme consumers run on the new HTTP origin.
  await rendererPreferences.initialize();
  // Keep the original HTML failure visible if bootstrapping already failed.
  if (window.startupDiagnostics?.failure) return;
  const { default: Gate } = await import('@/app/shell/initialization/AppInitializationGate');
  if (window.startupDiagnostics?.failure) return;
  const Application = React.lazy(async () => {
    // Configure the offline editor before importing any of its consumers.
    await import('@/app/monacoConfig');
    const [{ default: App }, { store }, { Provider }] = await Promise.all([
      import('@/app/App'),
      import('@/store'),
      import('react-redux'),
    ]);
    return {
      default: () => (
        <Provider store={store}>
          <App />
        </Provider>
      ),
    };
  });
  ReactDOM.createRoot(rootElement!).render(
    <React.StrictMode>
      <Gate>
        <Application />
      </Gate>
    </React.StrictMode>,
  );
}

void startRenderer().catch(error => {
  console.error('Failed to render the app:', error);
  window.startupDiagnostics?.fail(error);
});
