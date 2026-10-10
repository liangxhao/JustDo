/** Creation entry point; an omitted source denotes a desktop conversation. */
export const CoworkSessionSource = {
  BrowserExtension: 'browser-extension',
} as const;

export type CoworkSessionSource = (typeof CoworkSessionSource)[keyof typeof CoworkSessionSource];
