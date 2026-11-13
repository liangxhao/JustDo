import { i18nService } from '@/services/i18n';

export function engineMemoryAdvice(): string {
  return i18nService.t(window.electron?.platform === 'win32'
    ? 'engineMemoryAllocationWindowsAdvice'
    : 'engineMemoryAllocationAdvice');
}
