import { describe, expect, it, vi } from 'vitest';

import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import {
  applyDefaultOpenClawPluginEntries,
  buildDefaultOpenClawPluginEntries,
  isUserToggleableBundledPlugin,
  listManagedOpenClawPluginIds,
  mergeOpenClawPluginConfig,
} from './openclawConfigBuilders';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

const pluginId = OpenClawExtensionId.WIDGET_KIT;
const defaults = () => buildDefaultOpenClawPluginEntries(id => id === pluginId);

describe('optional Widget Kit plugin configuration', () => {
  it('enables the bundled plugin by default and keeps it user-toggleable', () => {
    expect(defaults()).toEqual({ [pluginId]: { enabled: true } });
    expect(buildDefaultOpenClawPluginEntries(() => false)).toEqual({});
    expect(isUserToggleableBundledPlugin(pluginId)).toBe(true);
    expect(listManagedOpenClawPluginIds()).not.toContain(pluginId);
  });

  it.each([true, false])('preserves explicit enabled=%s through managed sync', enabled => {
    const previous = {
      entries: { [pluginId]: { enabled } },
      load: { paths: ['C:/user-plugins'] },
      deny: ['third-party-disabled'],
    };
    const merged = mergeOpenClawPluginConfig(
      applyDefaultOpenClawPluginEntries(previous, defaults()),
      { 'runtime-services': { enabled: true } },
      [pluginId],
    );
    expect(merged.entries).toMatchObject({
      [pluginId]: { enabled },
      'runtime-services': { enabled: true },
    });
    expect(merged.load).toEqual(previous.load);
    expect(merged.deny).toEqual(previous.deny);
    expect(previous.entries[pluginId]).toEqual({ enabled });
  });
});
