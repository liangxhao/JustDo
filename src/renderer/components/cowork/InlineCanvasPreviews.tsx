import React, { useCallback,useState } from 'react';

import type { CanvasPreview } from '../../utils/canvasShortcode';

type InlineCanvasPreviewsProps = {
  previews: CanvasPreview[];
};

/**
 * Get file extension from URL
 */
const getFileExtension = (url: string): string | null => {
  const cleanUrl = url.split('#')[0].split('?')[0];
  const match = cleanUrl.match(/\.([A-Za-z0-9]{1,6})$/);
  return match ? match[1].toLowerCase() : null;
};

/**
 * Determine content type from URL and isImage flag
 */
const getContentType = (url: string, isImage?: boolean): 'image' | 'html' | 'pdf' | 'unknown' => {
  // Use explicit isImage flag if provided (from MEDIA: detection)
  if (isImage === true) return 'image';

  const ext = getFileExtension(url);
  if (!ext) return 'unknown';

  const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
  if (imageExtensions.has(ext)) return 'image';

  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';

  return 'unknown';
};

/**
 * Single preview item component
 */
const PreviewItem: React.FC<{ preview: CanvasPreview }> = ({ preview }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  const { url, title, height = 320, isImage } = preview;
  const contentType = getContentType(url, isImage);

  return (
    <div className="inline-block rounded-lg border border-border overflow-hidden">
      {/* Loading indicator */}
      {isLoading && !hasError && (
        <div className="flex items-center justify-center py-4 px-8 bg-surface-raised">
          <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error state */}
      {hasError && (
        <div className="p-3 text-center text-secondary bg-surface-raised">
          <p>Failed to load preview</p>
          <p className="text-sm mt-1 opacity-70">{url}</p>
        </div>
      )}

      {/* Content rendering - no extra background/padding */}
      {contentType === 'image' && !hasError && (
        <img
          src={url}
          alt={title || 'Preview'}
          onLoad={handleLoad}
          onError={handleError}
          className="block max-w-full h-auto rounded"
          style={{ maxHeight: height }}
        />
      )}

      {contentType === 'html' && !hasError && (
        <iframe
          src={url}
          onLoad={handleLoad}
          onError={handleError}
          className="block bg-white dark:bg-gray-900 rounded"
          style={{ height, minHeight: 160 }}
          sandbox="allow-scripts allow-same-origin"
          title={title || 'Canvas content'}
        />
      )}

      {contentType === 'pdf' && !hasError && (
        <iframe
          src={url}
          onLoad={handleLoad}
          onError={handleError}
          className="block rounded"
          style={{ height }}
          title={title || 'PDF content'}
        />
      )}

      {contentType === 'unknown' && !hasError && (
        <div className="p-2 text-center bg-surface-raised">
          <a
            href={url}
            onClick={e => {
              e.preventDefault();
              window.electron?.shell?.openExternal(url);
            }}
            className="text-primary hover:text-primary-hover underline text-sm"
          >
            Open content
          </a>
        </div>
      )}
    </div>
  );
};

/**
 * Inline canvas previews - renders multiple embed previews within message
 */
const InlineCanvasPreviews: React.FC<InlineCanvasPreviewsProps> = ({ previews }) => {
  if (!previews || previews.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {previews.map((preview, index) => (
        <PreviewItem key={`${preview.url}-${index}`} preview={preview} />
      ))}
    </div>
  );
};

export default InlineCanvasPreviews;
