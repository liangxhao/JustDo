import { ArrowUpCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { type MarketplacePluginDetail } from '@shared/plugins/marketplace';
import { createPortal } from 'react-dom';

import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import { MarketplaceAction } from './MarketplaceActions';
import type { PluginMarketplaceController } from './usePluginMarketplace';

export default function MarketplaceDetail({
  selectedDetail,
  detailLoading,
  onClose,
  controller,
}: {
  selectedDetail: MarketplacePluginDetail;
  detailLoading: boolean;
  onClose: () => void;
  controller: PluginMarketplaceController;
}) {
  const setSelectedDetail = onClose;
  const action = () => <MarketplaceAction item={selectedDetail} controller={controller} showText />;
  return (
    <>
      {' '}
      {selectedDetail &&
        createPortal(
          <Modal
            onClose={() => {
              if (!detailLoading) setSelectedDetail();
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold text-foreground">
                    {selectedDetail.name}
                  </h2>
                  {Boolean(
                    controller.localFor(selectedDetail) &&
                    controller.updateById.has(controller.localFor(selectedDetail)!.id),
                  ) && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      <ArrowUpCircleIcon className="h-3.5 w-3.5" />
                      {i18nService.t('marketplaceUpdateAvailable')}
                    </span>
                  )}
                  {selectedDetail.version && (
                    <span className="shrink-0 text-xs text-secondary">
                      v{selectedDetail.version}
                    </span>
                  )}
                </div>
                {selectedDetail.author && (
                  <p className="mt-1 text-xs text-secondary">{selectedDetail.author}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetail()}
                disabled={detailLoading}
                className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                aria-label={i18nService.t('close')}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
            <PluginMarkdownDescription className="mt-3" content={selectedDetail.description} />
            {detailLoading ? (
              <div className="py-8 text-center text-sm text-secondary">
                {i18nService.t('marketplaceLoading')}
              </div>
            ) : (
              <>
                {(selectedDetail.requirements?.bins?.length ||
                  selectedDetail.requirements?.env?.length) && (
                  <div className="mt-4 rounded-xl border border-border bg-background p-3">
                    <div className="text-xs font-semibold text-foreground">
                      {i18nService.t('marketplaceRequirements')}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[
                        ...(selectedDetail.requirements.bins ?? []),
                        ...(selectedDetail.requirements.env ?? []),
                      ].map(requirement => (
                        <code
                          key={requirement}
                          className="rounded-md bg-surface-raised px-2 py-1 text-xs text-foreground"
                        >
                          {requirement}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
                {selectedDetail.readme && (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-foreground">
                      {i18nService.t('marketplaceReadme')}
                    </div>
                    <PluginMarkdownDescription
                      className="mt-2 rounded-xl border border-border bg-background p-3"
                      content={selectedDetail.readme}
                    />
                  </div>
                )}
                <div className="mt-5 flex justify-end">{action()}</div>
              </>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
