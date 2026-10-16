// Phone links for the tray's "Copy phone link" submenu, built from os.networkInterfaces().
// Home/office ranges first: Windows often lists WSL/Hyper-V (172.x) or VPN adapters a phone can't reach.
const rank = address => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2;

// An empty token (OMP_WEB_PASSWORD is set) leaves the fragment out: the phone asks for the password instead of it riding in the link.
export function phoneLinks(interfaces, port, token) {
  return Object.entries(interfaces)
    .flatMap(([name, list]) => (list || [])
      .filter(n => (n.family === 'IPv4' || n.family === 4) && !n.internal)
      .map(n => ({ label: `${name} — ${n.address}`, url: `http://${n.address}:${port}/${token ? `#token=${token}` : ''}`, rank: rank(n.address) })))
    .sort((a, b) => a.rank - b.rank)
    .map(({ label, url }) => ({ label, url }));
}
