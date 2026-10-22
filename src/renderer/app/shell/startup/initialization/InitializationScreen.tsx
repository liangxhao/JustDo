import type { AppInitializationState } from '@shared/app/initialization';

import FirstLaunchGuide from './FirstLaunchGuide';
import StartupScreen from './StartupScreen';

/** Main freezes the data-generation route; the presentation only consumes it. */
export default function InitializationScreen({ state }: { state: AppInitializationState }) {
  return state.firstLaunch ? <FirstLaunchGuide state={state} /> : <StartupScreen state={state} />;
}
