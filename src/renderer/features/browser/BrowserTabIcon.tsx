import { GlobeAltIcon } from '@heroicons/react/24/outline';
import { isBrowserFaviconDataUrl } from '@shared/browser/browser';
import { useState } from 'react';

export default function BrowserTabIcon({ faviconUrl }: { faviconUrl?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return isBrowserFaviconDataUrl(faviconUrl) && faviconUrl !== failedUrl ? (
    <img
      src={faviconUrl}
      alt=""
      className="h-4 w-4 shrink-0 rounded-sm object-contain"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(faviconUrl)}
    />
  ) : (
    <GlobeAltIcon className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
  );
}
