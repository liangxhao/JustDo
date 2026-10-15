import { ArrowPathIcon, ClockIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

import type { McpProbeResult } from './mcp';

interface McpProbeButtonProps {
  onProbe: () => void;
  disabled?: boolean;
  probing?: boolean;
  result?: McpProbeResult;
  label?: string;
  showText?: boolean;
}

const McpProbeButton = ({
  onProbe,
  disabled = false,
  probing = false,
  result,
  label = i18nService.t('mcpTestServer'),
  showText = false,
}: McpProbeButtonProps) => (
  <button
    type="button"
    onClick={event => {
      event.stopPropagation();
      onProbe();
    }}
    disabled={disabled || probing}
    aria-label={label}
    aria-busy={probing || undefined}
    title={[
      label,
      probing
        ? i18nService.t('mcpTestingServer')
        : result
          ? i18nService.t(result.available ? 'mcpProbeStatusAvailable' : 'mcpProbeUnavailable')
          : null,
    ]
      .filter(Boolean)
      .join(' · ')}
    className={`inline-flex shrink-0 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${
      showText ? 'border border-border px-3 py-1.5 text-xs' : 'h-6 w-6'
    }`}
  >
    {showText ? (
      i18nService.t(probing ? 'mcpTestAllTesting' : 'mcpTestShort')
    ) : probing ? (
      <ArrowPathIcon
        aria-hidden="true"
        className="h-[18px] w-[18px] animate-spin"
        strokeWidth={1.75}
      />
    ) : (
      <ClockIcon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
    )}
  </button>
);

export default McpProbeButton;
