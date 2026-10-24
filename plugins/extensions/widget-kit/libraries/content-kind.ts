import { escapeHtml, scriptJson } from '../document/serialization';
import { installOfflineLibraryBootstrap } from './bootstrap';
import { createOfflineLibraryResourceReader, OFFLINE_LIBRARY_RESOURCES } from './resources';
import { OFFLINE_HTML_KIND, parseOfflineHtmlDocument } from './schema';

/** Keep the asset root in index.ts so source and the precompiled root entry agree. */
export function createOfflineHtmlContentKind(assetRoot: URL) {
  return {
    kind: OFFLINE_HTML_KIND,
    label: 'Offline HTML',
    resources: {
      surface: 'widget-libraries',
      paths: OFFLINE_LIBRARY_RESOURCES.map(resource => resource.path),
      readPublicResource: createOfflineLibraryResourceReader(assetRoot),
    },
    validateSource(source: string): void {
      parseOfflineHtmlDocument(source);
    },
    composeDocument({
      source,
      resourceUrls,
    }: {
      source: string;
      title: string;
      resourceUrls: Readonly<Record<string, string>>;
      promptGranted: boolean;
    }): string {
      const document = parseOfflineHtmlDocument(source);
      const scripts = document.libraries.map(id => ({ id, scriptId: `widget-library-${id}` }));
      const resources = document.libraries.map((id, index) => {
        const resource = OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === id)!;
        const url = resourceUrls[resource.path];
        if (!url) throw new Error('Offline widget library resource unavailable');
        return `<script id="${scripts[index].scriptId}" src="${escapeHtml(url)}"></script>`;
      });
      return (
        `<script>(${installOfflineLibraryBootstrap.toString()})(${scriptJson(scripts)});</script>` +
        resources.join('') +
        document.html
      );
    },
  };
}
