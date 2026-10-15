import { i18nService } from '@/services/i18n';

interface ExtensionBadgeProps {
  label?: string;
  onOpen?: () => void;
}

const ExtensionBadge = ({ label, onOpen }: ExtensionBadgeProps) => {
  const text = i18nService.t('pluginScope.extension');
  const className =
    'inline-flex whitespace-nowrap px-1 text-[8px] font-medium leading-3 text-purple-700 dark:text-purple-300';
  return onOpen ? (
    <button
      type="button"
      title={label ?? text}
      aria-label={label ?? text}
      className={`${className} rounded-sm transition-colors hover:text-purple-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:hover:text-purple-200`}
      onClick={event => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {text}
    </button>
  ) : (
    <span className={className} title={label ?? text}>
      {text}
    </span>
  );
};

export default ExtensionBadge;
