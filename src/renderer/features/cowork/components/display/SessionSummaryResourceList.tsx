import { GlobeAltIcon } from '@heroicons/react/24/outline';

import type {
  SessionSummaryResources,
  SummaryResource,
} from '@/libs/openclaw-chat/model/session-summary-resources';
import { i18nService } from '@/services/i18n';

import WorkspaceFileIcon from '../shared/WorkspaceFileIcon';
import type { SummaryResourceListKind } from './displayTabIds';

export function SessionSummaryResourceIcon({ resource }: { resource: SummaryResource }) {
  if (resource.target.kind === 'url') {
    return <GlobeAltIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />;
  }
  return (
    <WorkspaceFileIcon
      fileName={
        (resource.target.kind === 'file' ? resource.target.path : resource.title)
          .split(/[\\/]/u)
          .pop() ?? resource.title
      }
    />
  );
}

function resourceLocation(resource: SummaryResource): string | undefined {
  const { target } = resource;
  if (target.kind === 'file') return target.path;
  if (target.kind === 'url') return target.url;
  if (target.kind === 'media' && /^https?:\/\//iu.test(target.url)) return target.url;
  return resource.mimeType;
}

export default function SessionSummaryResourceList({
  kind,
  resources,
  onOpenResource,
}: {
  kind: SummaryResourceListKind;
  resources: SessionSummaryResources | null;
  onOpenResource: (resource: SummaryResource) => void;
}) {
  const isOutput = kind === 'outputs';
  const items = resources?.[kind] ?? [];
  const loading = !resources || (isOutput && resources.outputsLoading);
  const unavailable = isOutput && resources?.outputsUnavailable;
  const partial = isOutput && resources?.omittedOversized;
  return (
    <section
      aria-label={i18nService.t(isOutput ? 'coworkSummaryOutputs' : 'coworkSummarySources')}
      className="h-full overflow-y-auto bg-background p-3"
    >
      <ul className="divide-y divide-border">
        {items.map(item => {
          const title = item.title || i18nService.t('coworkSummaryAttachment');
          const location = resourceLocation(item);
          return (
            <li key={item.id} className="py-1 first:pt-0">
              <button
                type="button"
                aria-label={title}
                title={location || title}
                className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => onOpenResource(item)}
              >
                <span className="mt-0.5 shrink-0">
                  <SessionSummaryResourceIcon resource={item} />
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block break-words text-sm font-medium text-foreground">
                    {title}
                  </span>
                  {location && (
                    <span className="block break-all text-xs leading-4 text-muted">{location}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {loading && (
        <p role="status" className="px-2 py-2 text-xs text-muted">
          {i18nService.t('loading')}
        </p>
      )}
      {unavailable && (
        <p role="status" className="px-2 py-2 text-xs text-muted">
          {i18nService.t('coworkSummaryOutputsUnavailable')}
        </p>
      )}
      {partial && (
        <p className="px-2 py-2 text-xs text-muted">
          {i18nService.t('coworkSummaryOutputsPartial')}
        </p>
      )}
      {!items.length && !loading && !unavailable && !partial && (
        <p className="px-2 py-2 text-xs text-muted">
          {i18nService.t(isOutput ? 'coworkSummaryOutputsNone' : 'coworkSummarySourcesNone')}
        </p>
      )}
    </section>
  );
}
