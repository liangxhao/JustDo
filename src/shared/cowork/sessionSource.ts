import type { ExternalSessionMetadata } from '../integrations/externalSession';

/** Creation entry point; an omitted source denotes a desktop conversation. */
export const CoworkSessionSource = {
  ChromeExtension: 'chrome-extension',
} as const;

export type CoworkSessionSource = (typeof CoworkSessionSource)[keyof typeof CoworkSessionSource];

/** Unknown persisted sources cannot be interpreted as desktop conversations. */
export const isSupportedSessionSource = (
  value: unknown,
): value is CoworkSessionSource | null | undefined =>
  value === undefined || value === null || value === CoworkSessionSource.ChromeExtension;

/** Source groups are determined by persisted origin and cannot be edited manually. */
export const isSourceGroupedSession = (session: {
  source?: CoworkSessionSource;
  external?: ExternalSessionMetadata;
}): boolean => Boolean(session.external) || session.source === CoworkSessionSource.ChromeExtension;
