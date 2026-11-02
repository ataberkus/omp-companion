#!/bin/bash
# Starts the OMP companion and opens the control room in your browser: the macOS counterpart of start.bat.
# Double-click it in Finder (it runs in a Terminal window) or run ./start.command. Variables set here stay in this script.
cd "$(dirname "$0")" || exit 1
# Sessions run OMP's SDK (the npm package @oh-my-pi/pi-coding-agent) inside the companion, on Bun.
# Terminal runs this from your login shell, so PATH has your profile's entries; the default install folders cover the rest.
for dir in "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
export PATH
pause() { echo; read -r -n 1 -s -p "Press any key to close this window."; echo; }
command -v bun >/dev/null || { echo "Bun was not found. Install it from https://bun.sh and try again."; pause; exit 1; }
if [ ! -f node_modules/@oh-my-pi/pi-coding-agent/package.json ]; then
  command -v npm >/dev/null || { echo "OMP's SDK is not installed and npm was not found. Install Node.js from https://nodejs.org, then run npm ci here."; pause; exit 1; }
  echo "Installing OMP's SDK (npm ci)..."
  npm ci || { echo "npm ci failed."; pause; exit 1; }
fi
if [ -n "$OMP_BIN" ]; then
  echo "Using OMP: $OMP_BIN"
elif ! command -v omp >/dev/null; then
  echo "omp was not found on PATH: the companion installs OMP when it starts (set OMP_WEB_NO_INSTALL=1 to skip)."
fi
# Reachable from your network (and your tailnet, if Tailscale runs) with a login. Set OMP_WEB_PASSWORD to choose the password;
# without it this window prints a random connection token per launch. Set OMP_WEB_HOST=127.0.0.1 to keep it on this Mac only,
# or to this Mac's Tailscale address (100.x.y.z) to accept only tailnet devices (see "Away from home with Tailscale" in README.md).
export OMP_WEB_HOST="${OMP_WEB_HOST:-0.0.0.0}"
if [ "$OMP_WEB_NO_TOKEN" != "1" ] && [ -z "$OMP_WEB_PASSWORD" ]; then
  echo "OMP_WEB_PASSWORD is not set: other devices need the connection token printed below."
fi
printf '\033]0;OMP companion\007'
# Restart companion (dashboard menu) stops the companion with exit code 75; the loop starts it again on the same port.
export OMP_WEB_RESTART_EXIT=75
while :; do
  bun companion/server.mjs "$@"
  [ $? -eq 75 ] || break
  echo
  echo "Restarting the companion..."
done
echo
echo "The companion stopped."
pause
