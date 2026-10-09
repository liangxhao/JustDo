import os from 'node:os';

import { afterEach, expect, test, vi } from 'vitest';

import { getMacAddress } from './macAddress';

const interfaceInfo = (mac: string, internal = false): os.NetworkInterfaceInfo => ({
  address: '192.0.2.1',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac,
  internal,
  cidr: '192.0.2.1/24',
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('skips internal, zero and malformed MACs and returns the first valid address without colons', () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    unavailable: undefined,
    loopback: [interfaceInfo('02:11:22:33:44:55', true)],
    invalid: [interfaceInfo(''), interfaceInfo('00:00:00:00:00:00'), interfaceInfo('invalid')],
    Ethernet: [interfaceInfo('02:ab:cd:ef:12:34'), interfaceInfo('02:22:33:44:55:66')],
    WiFi: [interfaceInfo('02:33:44:55:66:77')],
  });

  expect(getMacAddress()).toBe('02ABCDEF1234');
});

test.each([
  '',
  '00:00:00:00:00:00',
  '000000000000',
  'invalid',
  '02:ab:cd:ef:12',
  '02:ab:cd:ef:12:gg',
])('fails instead of generating a substitute identity when the only MAC is invalid (%s)', mac => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({ Ethernet: [interfaceInfo(mac)] });

  expect(() => getMacAddress()).toThrow('No valid MAC address found.');
});

test('fails when there are no network interfaces', () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({});

  expect(() => getMacAddress()).toThrow('No valid MAC address found.');
});

test('fails when every network interface is internal', () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    loopback: [interfaceInfo('02:11:22:33:44:55', true)],
  });

  expect(() => getMacAddress()).toThrow('No valid MAC address found.');
});

test('reports a network lookup failure without exposing the underlying error', () => {
  vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
    throw new Error('Private system diagnostic');
  });

  expect(() => getMacAddress()).toThrow('Unable to read network interfaces.');
});
