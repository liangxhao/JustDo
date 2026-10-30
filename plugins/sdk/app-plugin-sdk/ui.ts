import type {
  ComponentType,
  CSSProperties,
  KeyboardEvent,
  MouseEventHandler,
  ReactNode,
} from 'react';

export interface AppUiServices {
  i18n: { t(key: string): string; getLanguage(): 'zh' | 'en' };
  Modal(props: {
    isOpen?: boolean;
    onClose: () => void;
    className?: string;
    overlayClassName?: string;
    onClick?: MouseEventHandler;
    closeOnBackdrop?: boolean;
    children?: ReactNode;
    style?: CSSProperties;
  }): ReactNode;
  useOwnerDocument(): Document;
  OwnerDocumentProvider: ComponentType<{ value: Document | null; children?: ReactNode }>;
  useOwnerWindow(): Window & Pick<typeof globalThis, 'ResizeObserver'>;
  isComposerSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>, shortcut?: string): boolean;
}
