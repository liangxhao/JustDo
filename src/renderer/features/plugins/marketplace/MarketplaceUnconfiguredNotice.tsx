import { AuthErrorCode, AuthOperation, AuthStatus } from '@shared/app/auth';

import { useAuth } from '@/features/auth/useAuth';
import { i18nService } from '@/services/i18n';

// Integrated builds can hide the unavailable message while keeping the sign-in prompt.
const SHOW_DEFAULT_MARKETPLACE_NOTICE = true;

export default function MarketplaceUnconfiguredNotice({ className }: { className: string }) {
  const { state, loading, errorCode } = useAuth();
  if (loading || state.operation === AuthOperation.Login) return null;

  if (state.status === AuthStatus.SignedOut && errorCode !== AuthErrorCode.Unavailable) {
    return <p className={className}>{i18nService.t('marketplaceSignInRequired')}</p>;
  }
  if (!SHOW_DEFAULT_MARKETPLACE_NOTICE) return null;

  return <p className={className}>{i18nService.t('marketplaceNotConfigured')}</p>;
}
