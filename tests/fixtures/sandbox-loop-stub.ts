/**
 * A delegate route for sandbox host tests whose model steps stay on this
 * computer (`destination: 'local'`), so a call interrupted by an exit is
 * repeated after a restart instead of parked. Its first call writes a note in
 * the delegate's sandbox; its second calls `onSecond` (the crash fixture exits
 * there) and then finishes. No network is touched.
 */
import type { LoopModelRoutes } from '../../server/harness/capabilities/native-loop.js';
import { teamRoutes } from './team-loop-stub.js';

export const CRASH_NOTE = 'written before the restart\n';

export function localDelegateRoutes(onSecond: () => void = () => {}): LoopModelRoutes {
  const routes = teamRoutes({
    delegate: (call) => {
      const done = call.messages.filter((message) => message.role === 'tool').length;
      if (done === 0) return { response: { type: 'tool', name: 'write_file', input: { path: 'Notes/check.md', text: CRASH_NOTE } } };
      onSecond();
      return { response: { type: 'final', text: 'Wrote Notes/check.md in my copy.' } };
    },
  });
  return {
    ...routes,
    adapter: async (route, request, stop) => ({ ...(await routes.adapter(route, request, stop)), destination: 'local' }),
  };
}
