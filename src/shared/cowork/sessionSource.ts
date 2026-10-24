import type { ExternalSessionMetadata } from '../integrations/externalSession';

/** Creation entry point; an omitted source denotes a desktop conversation. */
export const CoworkSessionSource = {
  BrowserExtension: 'browser-extension',
} as const;

export type CoworkSessionSource = (typeof CoworkSessionSource)[keyof typeof CoworkSessionSource];

/** Source groups are determined by persisted origin and cannot be edited manually. */
export const isSourceGroupedSession = (session: {
  source?: CoworkSessionSource;
  external?: ExternalSessionMetadata;
}): boolean => Boolean(session.external) || session.source === CoworkSessionSource.BrowserExtension;
