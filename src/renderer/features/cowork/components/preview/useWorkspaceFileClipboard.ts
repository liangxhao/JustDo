import type { WorkspaceDirectoryEntry } from '@shared/preview/filePreview';
import {
  type WorkspaceFileClipboardSnapshot,
  type WorkspaceFileMutationOutcome,
  type WorkspaceFileMutationTarget,
  WorkspaceFileTransferError,
  type WorkspaceFileTransferMode,
} from '@shared/preview/workspaceFiles';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface WorkspaceFileClipboardOptions {
  sessionId: string;
  onBeforeMutation?: (affectedPaths: string[]) => Promise<boolean>;
  onTransferred: () => void;
}

const operationError = (code: string) =>
  i18nService.t(
    code === WorkspaceFileTransferError.InvalidTarget
      ? 'coworkWorkspaceFilesInvalidTarget'
      : code === WorkspaceFileTransferError.ClipboardChanged
        ? 'coworkWorkspaceFilesClipboardChanged'
        : code === WorkspaceFileTransferError.InvalidName
          ? 'coworkWorkspaceFilesInvalidName'
          : code === WorkspaceFileTransferError.AlreadyExists
            ? 'coworkWorkspaceFilesAlreadyExists'
            : 'coworkWorkspaceFilesOperationFailed',
  );

export function useWorkspaceFileClipboard({
  sessionId,
  onBeforeMutation,
  onTransferred,
}: WorkspaceFileClipboardOptions) {
  const [clipboard, setClipboard] = useState<WorkspaceFileClipboardSnapshot | null>(null);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const [isWritingClipboard, setIsWritingClipboard] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [affectedPaths, setAffectedPaths] = useState<string[]>([]);
  const [error, setError] = useState('');
  const currentSession = useRef(sessionId);
  const generation = useRef(0);
  const mounted = useRef(true);
  const pending = useRef<symbol | null>(null);
  const readRequest = useRef<symbol | null>(null);
  const onBeforeMutationRef = useRef(onBeforeMutation);
  const onTransferredRef = useRef(onTransferred);
  currentSession.current = sessionId;
  onBeforeMutationRef.current = onBeforeMutation;
  onTransferredRef.current = onTransferred;

  useEffect(() => {
    mounted.current = true;
    setClipboard(null);
    setIsReadingClipboard(false);
    setIsWritingClipboard(false);
    setIsTransferring(false);
    setAffectedPaths([]);
    setError('');
    pending.current = null;
    readRequest.current = null;
    return () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = null;
      readRequest.current = null;
    };
  }, [sessionId]);

  const refreshClipboard = useCallback(async () => {
    if (!mounted.current || currentSession.current !== sessionId || pending.current) return;
    const request = Symbol();
    const requestedGeneration = generation.current;
    readRequest.current = request;
    const isCurrent = () =>
      mounted.current &&
      requestedGeneration === generation.current &&
      currentSession.current === sessionId &&
      readRequest.current === request;
    setIsReadingClipboard(true);
    try {
      const result = await window.electron.shell.readWorkspaceFileClipboard();
      if (isCurrent()) setClipboard(result.success ? result.value : null);
    } catch {
      if (isCurrent()) setClipboard(null);
    } finally {
      if (isCurrent()) {
        readRequest.current = null;
        setIsReadingClipboard(false);
      }
    }
  }, [sessionId]);

  const copy = async (entry: WorkspaceDirectoryEntry, mode: WorkspaceFileTransferMode) => {
    if (!mounted.current || currentSession.current !== sessionId || pending.current) return;
    const operation = Symbol();
    const requestedGeneration = generation.current;
    pending.current = operation;
    readRequest.current = null;
    const isCurrent = () =>
      mounted.current &&
      requestedGeneration === generation.current &&
      currentSession.current === sessionId &&
      pending.current === operation;
    setIsReadingClipboard(false);
    setIsWritingClipboard(true);
    setError('');
    try {
      const result = await window.electron.shell.writeWorkspaceFileClipboard({
        sessionId,
        sourcePath: entry.relativePath,
        mode,
      });
      if (!isCurrent()) return;
      if (result.success) setClipboard(result.value);
      else setError(operationError(result.code));
    } catch {
      if (isCurrent()) setError(operationError(WorkspaceFileTransferError.Failed));
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setIsWritingClipboard(false);
      }
    }
  };

  const paste = async (targetDirectory: string) => {
    if (!mounted.current || currentSession.current !== sessionId || pending.current) return;
    const operation = Symbol();
    const requestedGeneration = generation.current;
    pending.current = operation;
    readRequest.current = null;
    const isCurrent = () =>
      mounted.current &&
      requestedGeneration === generation.current &&
      currentSession.current === sessionId &&
      pending.current === operation;
    setIsReadingClipboard(false);
    setIsTransferring(true);
    setAffectedPaths([]);
    setError('');
    let submitted = false;
    try {
      const preparation = await window.electron.shell.prepareWorkspaceFilePaste({
        sessionId,
        targetDirectory,
      });
      if (!isCurrent()) return;
      if (!preparation.success) {
        if (preparation.code === WorkspaceFileTransferError.ClipboardChanged) setClipboard(null);
        setError(operationError(preparation.code));
        return;
      }
      const prepared = preparation.value;
      setClipboard(prepared.clipboard);
      if (prepared.clipboard.paths.length === 0) return;
      setAffectedPaths(prepared.affectedPaths);
      if (
        prepared.affectedPaths.length &&
        onBeforeMutationRef.current &&
        !(await onBeforeMutationRef.current(prepared.affectedPaths))
      )
        return;
      if (!isCurrent()) return;
      submitted = true;
      const result = await window.electron.shell.pasteWorkspaceFiles({
        sessionId,
        targetDirectory,
        clipboardRevision: prepared.clipboard.revision,
        destinationRevision: prepared.destinationRevision,
      });
      if (!isCurrent()) return;
      if (result.success) setClipboard(result.value.clipboard);
      else {
        if (result.code === WorkspaceFileTransferError.ClipboardChanged) setClipboard(null);
        setError(operationError(result.code));
      }
      // Native cancellation and failures can leave a partially completed operation.
      onTransferredRef.current();
    } catch {
      if (isCurrent()) {
        setError(operationError(WorkspaceFileTransferError.Failed));
        if (submitted) onTransferredRef.current();
      }
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setIsTransferring(false);
        setAffectedPaths([]);
      }
    }
  };

  const mutate = async (
    target: WorkspaceFileMutationTarget,
  ): Promise<WorkspaceFileMutationOutcome | null> => {
    if (
      !mounted.current ||
      currentSession.current !== sessionId ||
      target.sessionId !== sessionId ||
      pending.current
    )
      return null;
    const operation = Symbol();
    const requestedGeneration = generation.current;
    pending.current = operation;
    readRequest.current = null;
    const isCurrent = () =>
      mounted.current &&
      requestedGeneration === generation.current &&
      currentSession.current === sessionId &&
      pending.current === operation;
    setIsReadingClipboard(false);
    setIsTransferring(true);
    setAffectedPaths([]);
    setError('');
    let submitted = false;
    try {
      const preparation = await window.electron.shell.prepareWorkspaceFileMutation(target);
      if (!isCurrent()) return null;
      if (!preparation.success) {
        setError(operationError(preparation.code));
        return null;
      }
      let prepared = preparation.value;
      setAffectedPaths(prepared.affectedPaths);
      if (prepared.affectedPaths.length && onBeforeMutationRef.current) {
        if (!(await onBeforeMutationRef.current(prepared.affectedPaths))) return null;
        if (!isCurrent()) return null;
        // Saving a preview can replace the file atomically. Prepare the same
        // location again after its guard, while refusing a changed set of paths.
        const refreshed = await window.electron.shell.prepareWorkspaceFileMutation(target);
        if (!isCurrent()) return null;
        if (!refreshed.success) {
          setError(operationError(refreshed.code));
          return null;
        }
        const originalPaths = new Set(prepared.affectedPaths);
        const refreshedPaths = new Set(refreshed.value.affectedPaths);
        if (
          prepared.locationRevision !== refreshed.value.locationRevision ||
          originalPaths.size !== refreshedPaths.size ||
          [...originalPaths].some(filePath => !refreshedPaths.has(filePath))
        ) {
          setError(operationError(WorkspaceFileTransferError.Failed));
          return null;
        }
        prepared = refreshed.value;
      }
      if (!isCurrent()) return null;
      submitted = true;
      const result = await window.electron.shell.mutateWorkspaceFile({
        ...target,
        revision: prepared.revision,
      });
      if (!isCurrent()) return null;
      onTransferredRef.current();
      if (result.success) return result.value;
      setError(operationError(result.code));
      return null;
    } catch {
      if (isCurrent()) {
        setError(operationError(WorkspaceFileTransferError.Failed));
        if (submitted) onTransferredRef.current();
      }
      return null;
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setIsTransferring(false);
        setAffectedPaths([]);
        void refreshClipboard();
      }
    }
  };

  return {
    clipboard,
    refreshClipboard,
    copy,
    paste,
    mutate,
    clearError: () => setError(''),
    isReadingClipboard,
    isWritingClipboard,
    isTransferring,
    affectedPaths,
    error,
  };
}
