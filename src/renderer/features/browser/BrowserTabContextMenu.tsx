import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import BrowserContextMenu, {
  type BrowserContextMenuItem,
} from '@/features/browser/BrowserContextMenu';
import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

export type BrowserTabMenuAction =
  | 'new-right'
  | 'reload'
  | 'duplicate'
  | 'copy-url'
  | 'open-external'
  | 'rename'
  | 'toggle-mute'
  | 'close'
  | 'close-others'
  | 'close-right';

export default function BrowserTabContextMenu({
  x,
  y,
  muted,
  copyAddressLabel,
  canCloseOthers,
  canCloseRight,
  onAction,
  onDismiss,
  onRestoreFocus,
}: {
  x: number;
  y: number;
  muted: boolean;
  copyAddressLabel?: string;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  onAction: (action: BrowserTabMenuAction) => void;
  onDismiss: () => void;
  onRestoreFocus?: () => void;
}) {
  const ownerWindow = useOwnerWindow();
  const iconClass = 'h-4 w-4 shrink-0';
  const groups: BrowserContextMenuItem<BrowserTabMenuAction>[][] = [
    [
      {
        action: 'new-right',
        label: i18nService.t('browserTabMenuNewRight'),
        icon: <PlusIcon className={iconClass} />,
      },
      {
        action: 'reload',
        label: i18nService.t('browserPanelReload'),
        icon: <ArrowPathIcon className={iconClass} />,
      },
      {
        action: 'duplicate',
        label: i18nService.t('browserTabMenuDuplicate'),
        icon: <DocumentDuplicateIcon className={iconClass} />,
      },
      {
        action: 'copy-url',
        label: copyAddressLabel || i18nService.t('browserTabMenuCopyUrl'),
        icon: <LinkIcon className={iconClass} />,
      },
      {
        action: 'open-external',
        label: i18nService.t('browserTabMenuOpenExternal'),
        icon: <ArrowTopRightOnSquareIcon className={iconClass} />,
      },
    ],
    [
      {
        action: 'rename',
        label: i18nService.t('rename'),
        icon: <PencilIcon className={iconClass} />,
      },
      {
        action: 'toggle-mute',
        label: i18nService.t(muted ? 'browserTabMenuUnmute' : 'browserTabMenuMute'),
        icon: muted ? (
          <SpeakerWaveIcon className={iconClass} />
        ) : (
          <SpeakerXMarkIcon className={iconClass} />
        ),
      },
    ],
    [
      {
        action: 'close',
        label: i18nService.t('browserPanelCloseTab'),
        icon: <XMarkIcon className={iconClass} />,
      },
      {
        action: 'close-others',
        label: i18nService.t('browserTabMenuCloseOthers'),
        icon: <XMarkIcon className={iconClass} />,
        disabled: !canCloseOthers,
      },
      {
        action: 'close-right',
        label: i18nService.t('browserTabMenuCloseRight'),
        icon: <XMarkIcon className={iconClass} />,
        disabled: !canCloseRight,
      },
    ],
  ];
  return (
    <BrowserContextMenu
      x={x}
      y={y}
      label={i18nService.t('browserTabMenuLabel')}
      dismissLabel={i18nService.t('browserTabMenuDismiss')}
      groups={groups}
      height={392}
      onAction={onAction}
      onDismiss={() => {
        onDismiss();
        if (onRestoreFocus) ownerWindow.requestAnimationFrame(onRestoreFocus);
      }}
    />
  );
}
