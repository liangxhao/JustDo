import { useState } from 'react';

import { i18nService } from '@/services/i18n';

export default function StartupLogButton() {
  const [failed, setFailed] = useState(false);
  const openLogs = async () => {
    setFailed(false);
    try {
      await window.electron.log.openFolder();
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button type="button" className="startup-action" onClick={() => void openLogs()}>
        {i18nService.t('startupOpenLogs')}
      </button>
      {failed && <p role="alert">{i18nService.t('startupOpenLogsFailed')}</p>}
    </>
  );
}
