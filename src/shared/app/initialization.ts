export const AppInitializationIpc = {
  GetState: 'app:initialization:getState',
  Changed: 'app:initialization:changed',
  Relaunch: 'app:initialization:relaunch',
} as const;

export const AppInitializationPhase = {
  Preparing: 'preparing',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export const AppInitializationStep = {
  UserData: 'userData',
  Runtime: 'runtime',
  Configuration: 'configuration',
  Engine: 'engine',
  Complete: 'complete',
} as const;

export type AppInitializationState = {
  phase: (typeof AppInitializationPhase)[keyof typeof AppInitializationPhase];
  step: (typeof AppInitializationStep)[keyof typeof AppInitializationStep];
  firstLaunch: boolean;
  completedSteps: number;
  totalSteps: number;
  userDataPath: string;
  error?: string;
};
