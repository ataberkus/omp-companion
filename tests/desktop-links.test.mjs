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

// Tailscale links work away from home too, so they follow the home ranges, ahead of WSL/VPN adapters; the MagicDNS name leads them.
test('phone links label tailnet addresses and add the MagicDNS name while Tailscale is connected', () => {
  const interfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Ethernet 3': [{ family: 'IPv4', address: '100.114.117.34', internal: false }, { family: 'IPv6', address: 'fd7a:115c:a1e0::482b:7523', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.1.17', internal: false }],
  };
  const tailscale = { name: 'my-pc.tail1234.ts.net', ips: ['100.114.117.34', 'fd7a:115c:a1e0::482b:7523'] };
  assert.deepEqual(phoneLinks(interfaces, 4545, '', tailscale), [
    { label: 'Ethernet — 192.168.1.17', url: 'http://192.168.1.17:4545/' },
    { label: 'Tailscale — my-pc.tail1234.ts.net', url: 'http://my-pc.tail1234.ts.net:4545/' },
    { label: 'Tailscale — 100.114.117.34', url: 'http://100.114.117.34:4545/' },
    { label: 'vEthernet (WSL) — 172.20.0.1', url: 'http://172.20.0.1:4545/' },
  ]);
  // Tailscale disconnected: its address left the adapters, so the name (which would resolve nowhere) is left out.
  const { 'Ethernet 3': _, ...offline } = interfaces;
  assert.deepEqual(phoneLinks(offline, 4545, 'abc', tailscale).map(l => l.label), ['Ethernet — 192.168.1.17', 'vEthernet (WSL) — 172.20.0.1']);
});

test('no network adapters gives no phone links', () => {
  assert.deepEqual(phoneLinks({}, 4545, 'abc'), []);
});
