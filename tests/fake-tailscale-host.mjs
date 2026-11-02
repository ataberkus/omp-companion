// Preload for desktop host tests of the tailnet listener (node --import ./tests/fake-tailscale-host.mjs desktop/host.mjs):
// the host imports this module in place of server.mjs, as with tests/fake-omp-host.mjs.
// - tailscaleSelf() answers from the JSON file named by FAKE_TAILSCALE, read at every lookup: {"self": {"name","ips"} or null}.
//   A test rewrites it to make Tailscale drop, come back or change address; 127.0.0.x addresses stand in for the tailnet ones.
//   {"hangListen": true} makes a new tailnet listener's listen() never call back (the main 127.0.0.1 listener is not affected).
// - FAKE_TAILSCALE_SCALE divides the host's own timers (the 30 s recheck, the 10 s listen/close limit) and the 5-minute
//   grace of tailscaleKeeper(), so a test sees minutes of Tailscale behaviour in seconds.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createCompanion as realCreateCompanion, tailscaleKeeper as realKeeper } from '../companion/server.mjs';

export * from '../companion/server.mjs';
const scale = Number(process.env.FAKE_TAILSCALE_SCALE) || 1;
const control = () => JSON.parse(readFileSync(process.env.FAKE_TAILSCALE, 'utf8'));
export const tailscaleSelf = async () => control().self ?? null;
export const tailscaleKeeper = (graceMs = 300000) => realKeeper(graceMs / scale);
export const createCompanion = async options => {
  const app = await realCreateCompanion(options);
  const serve = app.serve;
  app.serve = () => {
    const srv = serve();
    const listen = srv.listen;
    srv.listen = function (...args) { return control().hangListen ? this : listen.apply(this, args); };
    return srv;
  };
  return app;
};

// Only timers the host sets itself, so the companion's own (the screen's 2 s close, its refresh) keep their real delays.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...args) {
  const caller = new Error().stack.split('\n')[2] || '';
  return realSetTimeout(fn, caller.includes('/desktop/host.mjs') ? ms / scale : ms, ...args);
};

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return context.parentURL?.endsWith('/desktop/host.mjs') && resolved.url.endsWith('/companion/server.mjs') ? { ...resolved, url: import.meta.url, shortCircuit: true } : resolved;
  },
});
