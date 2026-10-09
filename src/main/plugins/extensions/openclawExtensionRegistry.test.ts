import { describe, expect, it } from 'vitest';

import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import { buildBundledExtensionEntries } from './openclawExtensionRegistry';

describe('openclawExtensionRegistry', () => {
  it('configures the remaining managed extensions', () => {
    const entries = buildBundledExtensionEntries(() => true, 5);

    expect(entries).toEqual({
      [OpenClawExtensionId.STT_LOCAL_CLI]: { enabled: true },
      [OpenClawExtensionId.ASK_USER_QUESTION]: {
        enabled: true,
      },
      [OpenClawExtensionId.AUTOMATION_PERMISSION]: {
        enabled: true,
        config: {
          approvalTimeoutMinutes: 5,
        },
      },
      [OpenClawExtensionId.RUNTIME_SERVICES]: {
        enabled: true,
      },
      [OpenClawExtensionId.PLAN_MODE]: {
        enabled: true,
      },
      [OpenClawExtensionId.EMBEDDED_BROWSER]: {
        enabled: false,
      },
      [OpenClawExtensionId.ACPX]: {
        enabled: true,
      },
      [OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX]: {
        enabled: false,
      },
    });
  });

  it('enables MXC only when Windows sandbox execution is selected', () => {
    const entries = buildBundledExtensionEntries(() => true, 5, true);

    expect(entries[OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX]).toEqual({
      enabled: true,
      config: { containment: 'processcontainer', network: 'none' },
    });
  });

  it('omits inactive MXC config even when sandbox networking is selected', () => {
    const entries = buildBundledExtensionEntries(() => true, 5, false, true);

    expect(entries[OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX]).toEqual({ enabled: false });
  });

  it('allows outbound sandbox networking only after explicit opt-in', () => {
    const entries = buildBundledExtensionEntries(() => true, 5, true, true);

    expect(entries[OpenClawExtensionId.WINDOWS_NATIVE_SANDBOX]).toMatchObject({
      enabled: true,
      config: { network: 'default' },
    });
  });
});
