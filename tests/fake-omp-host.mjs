// Preload for desktop host tests (node --import ./tests/fake-omp-host.mjs desktop/host.mjs): the host's companion runs its
// sessions on fakeOmp instead of OMP's SDK, which needs Bun and a provider. A prompted or resumed session starts a turn
// that never ends, so it is still working when the host quits. The host imports this module in place of server.mjs.
import { registerHooks } from 'node:module';
import { createCompanion as realCreateCompanion } from '../companion/server.mjs';
import { fakeOmp } from './fake-omp.mjs';

export * from '../companion/server.mjs';
export const createCompanion = options => realCreateCompanion({
  ...options,
  omp: fakeOmp({ state: () => ({ todoPhases: [], isSettled: false }), prompt() { this.emit({ type: 'agent_start' }); return {}; } }),
});

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return context.parentURL?.endsWith('/desktop/host.mjs') && resolved.url.endsWith('/companion/server.mjs') ? { ...resolved, url: import.meta.url, shortCircuit: true } : resolved;
  },
});
