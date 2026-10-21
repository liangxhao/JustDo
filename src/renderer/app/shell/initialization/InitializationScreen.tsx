import type { AppInitializationState } from '@shared/app/initialization';

import FirstLaunchGuide from '../first-launch/FirstLaunchGuide';
import StartupScreen from '../startup/StartupScreen';

/** Main owns the first-launch marker; presentation never infers or writes it. */
export default function InitializationScreen({ state }: { state: AppInitializationState }) {
  return state.firstLaunch ? <FirstLaunchGuide state={state} /> : <StartupScreen state={state} />;
}
