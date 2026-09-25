/**
 * npm run faux-cloud [-- --file <path>] [--port <n>] [--no-seed] [--identity password|workos-standin]
 *
 * Serves the faux cloud (the real control-plane handler over a JSON store and
 * local test sign-in) on 127.0.0.1, for the Nectovia desktop app and the
 * Diomedes Operations app. Faux data only; nothing here reaches Neon or WorkOS.
 *
 * --identity workos-standin signs people in through a local WorkOS stand-in
 * instead of passwords, verified by the Worker's own WorkOSIdentityVerifier: the
 * company build of the Operations app signs in against it exactly as it will
 * against WorkOS. Its store is a separate file.
 */
import { startFauxCloud, defaultFauxCloudFile, FAUX_CLOUD_PORT, FAUX_BACKEND_LABEL } from '../src/faux/server.js';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const identity = value('--identity') ?? process.env.NECTOVIA_FAUX_CLOUD_IDENTITY ?? 'password';
if (identity !== 'password' && identity !== 'workos-standin') throw new Error('--identity is password or workos-standin.');
const file = value('--file') ?? process.env.NECTOVIA_FAUX_CLOUD_FILE ?? defaultFauxCloudFile(identity);
const port = Number(value('--port') ?? process.env.NECTOVIA_FAUX_CLOUD_PORT ?? FAUX_CLOUD_PORT);
const running = await startFauxCloud({ file, port, seed: !args.includes('--no-seed'), identity });
console.log(`${FAUX_BACKEND_LABEL} ready: ${running.url}`);
console.log(`Store: ${running.file}`);
if (identity === 'workos-standin') console.log(`Sign-in: a local WorkOS stand-in at ${running.url}/workos (no passwords).`);
if (running.seed?.seeded) {
  console.log(identity === 'workos-standin'
    ? 'Seeded demo accounts. Sign in with one of these emails:'
    : `Seeded demo accounts. Every password is "${running.seed.password}":`);
  for (const account of Object.values(running.seed.accounts)) console.log(`  ${account.email}  (${account.name})`);
}
const stop = async () => { await running.close(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
