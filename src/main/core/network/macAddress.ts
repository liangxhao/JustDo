import os from 'node:os';

const MAC_ADDRESS_PATTERN = /^[0-9A-F]{12}$/;

/** Return the first valid non-internal MAC as 12 uppercase hexadecimal characters. */
export function getMacAddress(): string {
  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    throw new Error('Unable to read network interfaces.');
  }

  // Keep OS enumeration order; internal does not identify virtual or disconnected adapters.
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.internal || !info.mac) continue;
      const mac = info.mac.replace(/:/g, '').toUpperCase();
      if (MAC_ADDRESS_PATTERN.test(mac) && mac !== '000000000000') return mac;
    }
  }
  throw new Error('No valid MAC address found.');
}
