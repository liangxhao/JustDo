import { AuthErrorCode, AuthStatus } from '@shared/app/auth';

import { useAuth } from '@/features/auth/useAuth';
import { i18nService } from '@/services/i18n';

export default function MarketplaceUnconfiguredNotice({ className }: { className: string }) {
  const { state, loading, errorCode } = useAuth();
  if (loading) return null;

  if (state.status === AuthStatus.SignedOut && errorCode !== AuthErrorCode.Unavailable) {
    return <p className={className}>{i18nService.t('marketplaceSignInRequired')}</p>;
  }

  return <p className={className}>{i18nService.t('marketplaceNotConfigured')}</p>;
}
