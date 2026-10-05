import { ipcMain } from 'electron';

import { ComputerControlIpc } from '../../../shared/openclaw/computerControl';
import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import { evaluateComputerControlNativePolicy } from '../../openclaw/config/computerControlNativePolicy';
import { ComputerControlSettingsService } from '../../openclaw/config/computerControlSettingsService';
import { hasBundledOpenClawExtension } from '../../plugins/extensions/openclawLocalExtensions';

export function registerComputerControlHandlers(deps: {
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  getRuntimeRoot: () => string | null;
}) {
  const settings = new ComputerControlSettingsService(
    deps.requestGateway,
    () => hasBundledOpenClawExtension(OpenClawExtensionId.CUA_COMPUTER),
    tools => evaluateComputerControlNativePolicy(deps.getRuntimeRoot(), tools),
  );
  ipcMain.handle(ComputerControlIpc.Get, () => settings.get());
  ipcMain.handle(ComputerControlIpc.SetEnabled, (_event, enabled: unknown) =>
    deps.runConfigMutationExclusive(() => settings.setEnabled(enabled)),
  );
}
