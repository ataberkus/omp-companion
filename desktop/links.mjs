// Phone links for the tray's "Copy phone link" submenu, built from os.networkInterfaces() and `tailscale status` (tailscaleSelf()).
// Home/office ranges first: Windows often lists WSL/Hyper-V (172.x) or VPN adapters a phone can't reach. Tailscale comes next:
// its links also work away from home, from any device signed in to the same tailnet.
import { tailnetAddress } from '../companion/server.mjs';

const rank = address => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : tailnetAddress(address) ? 3 : 4;

// An empty token (OMP_WEB_PASSWORD is set) leaves the fragment out: the phone asks for the password instead of it riding in the link.
// tailscale: { name, ips } or null. Its MagicDNS name is listed only while one of its addresses is on an adapter (Tailscale connected).
export function phoneLinks(interfaces, port, token, tailscale = null) {
  const fragment = token ? `#token=${token}` : '';
  const links = Object.entries(interfaces)
    .flatMap(([name, list]) => (list || [])
      .filter(n => (n.family === 'IPv4' || n.family === 4) && !n.internal)
      .map(n => ({ label: `${tailnetAddress(n.address) ? 'Tailscale' : name} — ${n.address}`, url: `http://${n.address}:${port}/${fragment}`, rank: rank(n.address) })));
  const connected = Object.values(interfaces).flat().some(n => n && tailscale?.ips?.includes(n.address));
  if (tailscale?.name && connected) links.push({ label: `Tailscale — ${tailscale.name}`, url: `http://${tailscale.name}:${port}/${fragment}`, rank: 2 });
  return links.sort((a, b) => a.rank - b.rank).map(({ label, url }) => ({ label, url }));
}

// The address the desktop app's tailnet listener binds. OMP_WEB_HOST naming a tailnet address wins; any other OMP_WEB_HOST
// (127.0.0.1, 0.0.0.0, a LAN address) turns the listener off; unset means this PC's own Tailscale address, IPv4 first.
// tailscale: tailscaleSelf() result ({ name, ips } with ips already tailnet-only) or null. '' means no listener.
export function pickTailnetHost(envHost, tailscale) {
  if (envHost) return tailnetAddress(envHost) ? envHost : '';
  const ips = tailscale?.ips || [];
  return ips.find(ip => !ip.includes(':')) || ips[0] || '';
}
