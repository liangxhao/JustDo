import { useEffect, useRef, useState } from 'react';
import type {
  SwarmWorkflowDetail,
  SwarmWorkflowIntervention,
  SwarmWorkflowInterventionAction,
  SwarmWorkflowInterventionNote,
} from '../contracts/workflow';
import type { WorkflowBrowserPorts } from './ports';

const EMPTY_NOTES: SwarmWorkflowInterventionNote[] = [];
export interface WorkflowInterventionOptions {
  sessionId: string;
  detail: SwarmWorkflowDetail;
  disabled: boolean;
  onChanged(): void;
}
export function useWorkflowIntervention(
  api: Pick<WorkflowBrowserPorts, 'interveneSwarmWorkflow' | 'newOperationId'>,
  { sessionId, detail, disabled, onChanged }: WorkflowInterventionOptions,
) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [acceptedAction, setAcceptedAction] = useState<SwarmWorkflowInterventionAction>();

  const pending = useRef<SwarmWorkflowIntervention>();
  const notes = detail.interventions ?? EMPTY_NOTES;

  useEffect(() => {
    // A response can be lost after acceptance. Reconcile using the persisted ID.
    if (pending.current && notes.some(note => note.id === pending.current?.id)) {
      if (text.trim() === pending.current.text) setText('');
      setAcceptedAction(pending.current.action);
      pending.current = undefined;
      setFailed(false);
    }
  }, [notes, text]);
  const send = async (action: SwarmWorkflowInterventionAction) => {
    if (
      busy ||
      disabled ||
      !detail.revision ||
      (action === 'note' && !detail.canNote) ||
      (action === 'continue' && !detail.canContinue) ||
      (action === 'retry' && !detail.canRetry) ||
      (action !== 'retry' && !text.trim())
    )
      return;
    const body = text.trim();
    const request =
      pending.current?.action === action && pending.current.text === body
        ? pending.current
        : { id: api.newOperationId(), action, text: body };
    pending.current = request;
    setBusy(true);
    setFailed(false);
    setAcceptedAction(undefined);
    try {
      const result = await api.interveneSwarmWorkflow(
        sessionId,
        detail.flowId,
        detail.nodeId,
        detail.revision,
        request,
      );
      // Polling may have confirmed persistence before this reply arrives.
      if (!result.success) {
        if (pending.current?.id === request.id) setFailed(true);
      } else {
        setText('');
        pending.current = undefined;
        setAcceptedAction(action);
      }
    } catch {
      if (pending.current?.id === request.id) setFailed(true);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return { text, setText, busy, failed, acceptedAction, setAcceptedAction, notes, send };
}
