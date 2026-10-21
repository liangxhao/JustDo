import { createContext } from 'react';

export const RendererStartupActivity = {
  Interface: 'interface',
  Preferences: 'preferences',
  Appearance: 'appearance',
  Language: 'language',
  Conversations: 'conversations',
  EngineStatus: 'engineStatus',
} as const;

export type RendererStartupActivity =
  (typeof RendererStartupActivity)[keyof typeof RendererStartupActivity];

/** Preserve Main's startup clock while renderer loading screens replace one another. */
export const StartupStartedAtContext = createContext<number | null>(null);

export type InitializationController = {
  reportActivity: (activity: RendererStartupActivity) => void;
  complete: () => void;
  fail: (error: unknown) => void;
};

export const InitializationContext = createContext<{
  active: boolean;
  controller: InitializationController;
} | null>(null);
