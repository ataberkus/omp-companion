import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneLinks } from '../desktop/links.mjs';

// Windows often lists WSL/Hyper-V (172.x) or VPN adapters first; the Wi-Fi address a phone can reach must lead.
test('phone links put home/office ranges first and skip loopback and IPv6', () => {
  const interfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }],
    'Corp VPN': [{ family: 'IPv4', address: '10.8.0.5', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  assert.deepEqual(phoneLinks(interfaces, 4545, 'abc'), [
    { label: 'Wi-Fi — 192.168.1.20', url: 'http://192.168.1.20:4545/#token=abc' },
    { label: 'Corp VPN — 10.8.0.5', url: 'http://10.8.0.5:4545/#token=abc' },
    { label: 'vEthernet (WSL) — 172.20.0.1', url: 'http://172.20.0.1:4545/#token=abc' },
  ]);
});

test('no network adapters gives no phone links', () => {
  assert.deepEqual(phoneLinks({}, 4545, 'abc'), []);
});
