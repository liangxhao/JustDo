import type { ReactNode, SyntheticEvent } from 'react';

/** Keep admitted drafts and operation owners mounted while blocking native actions, including portals. */
export default function EngineInteractionBoundary({
  disabled,
  children,
  className,
}: {
  disabled: boolean;
  children: ReactNode;
  className?: string;
}) {
  const block = (event: SyntheticEvent) => {
    if (!disabled) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className={className}
      {...(disabled ? { inert: '' } : {})}
      onClickCapture={block}
      onKeyDownCapture={block}
      onPointerDownCapture={block}
      onChangeCapture={block}
      onInputCapture={block}
      onBeforeInputCapture={block}
      onSubmitCapture={block}
      onDropCapture={block}
      onPasteCapture={block}
    >
      {children}
    </div>
  );
}
