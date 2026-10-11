import { ArrowUturnLeftIcon } from '@heroicons/react/24/outline';
import type {
  CollaborationDelivery,
  CollaborationMember,
  CollaborationRoom,
} from '@shared/cowork/agent-team/collaboration';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { prepareCollaborationReference } from './collaborationReference';

export default function CollaborationReferenceAction({
  room,
  member,
  name,
  delivery,
  onFocusComposer,
}: {
  room: CollaborationRoom;
  member: CollaborationMember;
  name: string;
  delivery?: CollaborationDelivery;
  onFocusComposer: () => void;
}) {
  const [pending, setPending] = useState(false);
  const context = useRef({ room, member, delivery });
  const live = useRef(true);
  const submitting = useRef(false);
  context.current = { room, member, delivery };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const source = member.sessionId === room.anchorSessionId;
  return (
    <button
      type="button"
      aria-label={i18nService.t(source ? 'teamReturnToSource' : 'teamReferenceInSource')}
      disabled={pending || room.deleting}
      className="rounded-md p-1.5 text-secondary hover:bg-surface-raised hover:text-primary disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      title={i18nService.t(source ? 'teamReturnToSource' : 'teamReferenceInSource')}
      onClick={() => {
        if (submitting.current) return;
        if (source) {
          onFocusComposer();
          return;
        }
        const operation = context.current;
        const isCurrent = () =>
          live.current &&
          context.current.room.id === operation.room.id &&
          context.current.member.sessionKey === operation.member.sessionKey &&
          context.current.delivery?.id === operation.delivery?.id;
        submitting.current = true;
        setPending(true);
        void prepareCollaborationReference(room, member, name, delivery, isCurrent)
          .then(() => {
            if (isCurrent()) onFocusComposer();
          })
          .catch(error => {
            if (isCurrent())
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService.t(
                    error instanceof Error ? error.message : 'collaborationRuntimeUnavailable',
                  ),
                }),
              );
          })
          .finally(() => {
            submitting.current = false;
            if (live.current) setPending(false);
          });
      }}
    >
      <ArrowUturnLeftIcon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
