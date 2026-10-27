import { isLocalHtmlFilePath } from '@shared/browser/browserLinkOpening';
import {
  MessageFileLinkPreparationError,
  MessageFileLinkSourceKind,
  type PrepareMessageFileLinkResult,
} from '@shared/preview/messageFileLink';
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import type { OpenLocalHtmlOptions } from '../display/tabs/useCoworkBrowserPanels';
import type { OpenMessageFileLink } from './messageFileLinks';
import type { OpenFilePreviewOptions } from './useFilePreviewEvents';

interface MessageFileLinkNavigationOptions {
  workspaceSessionId?: string;
  projectRoot: string;
  filePreviewRequestIdRef: MutableRefObject<number>;
  openFilePreview: (options: OpenFilePreviewOptions) => Promise<void>;
  openLocalHtml: (options: OpenLocalHtmlOptions) => Promise<void>;
}

function preparationErrorMessage(
  result: Extract<PrepareMessageFileLinkResult, { success: false }>,
  target: string,
): string {
  switch (result.error) {
    case MessageFileLinkPreparationError.MissingSource:
      return i18nService.t('messageFileLinkNoProject');
    case MessageFileLinkPreparationError.SourceChanged:
      return i18nService.t('messageFileLinkProjectChanged');
    case MessageFileLinkPreparationError.InvalidTarget:
      return i18nService.t('messageFileLinkInvalidTarget');
    case MessageFileLinkPreparationError.NotFound:
      return i18nService.t('coworkAttachmentNotFound').replace('{filepath}', target);
    default:
      return i18nService.t('coworkFilePreviewFailed');
  }
}

/** The receiving workspace owns both the current project and the navigation. */
export function useMessageFileLinkNavigation(
  options: MessageFileLinkNavigationOptions,
): OpenMessageFileLink {
  const latest = useRef(options);
  latest.current = options;
  const scope = useRef({
    sessionId: options.workspaceSessionId,
    projectRoot: options.projectRoot,
  });
  if (
    scope.current.sessionId !== options.workspaceSessionId ||
    scope.current.projectRoot !== options.projectRoot
  ) {
    scope.current = {
      sessionId: options.workspaceSessionId,
      projectRoot: options.projectRoot,
    };
  }
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  return useCallback<OpenMessageFileLink>((target, linkOptions) => {
    if (!mounted.current) return;
    const owner = latest.current;
    const capturedScope = scope.current;
    const activeRequest = ++request.current;
    let previewRequest = ++owner.filePreviewRequestIdRef.current;
    let invokingPreview = false;
    const isCurrent = () =>
      mounted.current &&
      scope.current === capturedScope &&
      request.current === activeRequest &&
      (invokingPreview || owner.filePreviewRequestIdRef.current === previewRequest);
    const showError = (message: string) => {
      if (isCurrent()) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      }
    };
    const open = async () => {
      let filePath: string;
      let navigationSuffix: string | undefined;
      if (
        linkOptions?.legacyHtml &&
        target.sourceKind === MessageFileLinkSourceKind.NativePath &&
        /^\/[^/]/u.test(target.target) &&
        isLocalHtmlFilePath(target.target)
      ) {
        // Preserve the pre-existing HTML-only slash-root adapter. Generic file
        // targets always pass the strict Main preparation below.
        filePath = target.target;
        navigationSuffix = target.navigationSuffix;
      } else {
        const result = await window.electron.shell.prepareMessageFileLink({
          ...target,
          ...(owner.projectRoot && owner.workspaceSessionId
            ? {
                workspaceSessionId: owner.workspaceSessionId,
                expectedProjectRoot: owner.projectRoot,
              }
            : {}),
        });
        if (!isCurrent()) return;
        if (!result.success) {
          showError(preparationErrorMessage(result, target.target));
          return;
        }
        filePath = result.filePath;
        navigationSuffix = result.navigationSuffix;
      }
      if (!isCurrent()) return;
      let opening: Promise<void>;
      // The existing preview action starts its own request synchronously. Adopt
      // that counter before awaiting it, then reject any later navigation.
      invokingPreview = true;
      try {
        opening = isLocalHtmlFilePath(filePath)
          ? owner.openLocalHtml({
              filePath,
              navigationSuffix,
              workingDirectory: owner.projectRoot || undefined,
              currentSessionOnly: true,
              isCurrent,
            })
          : owner.openFilePreview({ filePath, keepWorkspaceFilesOpen: true, isCurrent });
      } finally {
        previewRequest = owner.filePreviewRequestIdRef.current;
        invokingPreview = false;
      }
      await opening;
    };
    void open().catch(() => showError(i18nService.t('coworkFilePreviewFailed')));
  }, []);
}
