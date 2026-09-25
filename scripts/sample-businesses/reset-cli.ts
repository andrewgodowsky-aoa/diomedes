/**
 * Rebuilds sample businesses from the committed files into a folder the app can open,
 * with empty app data beside each one.
 *
 *   npm run samples:reset -- <slug|all> [--root <folder>]
 *
 * The root defaults to %LOCALAPPDATA%\nectovia-sample-businesses (DIOMEDES_SAMPLES_DIR
 * overrides it). See reset.ts for what is written and what is refused.
 */
import { BUSINESSES, business } from './suite.js';
import { defaultRoot, resetBusiness } from './reset.js';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 ? args[at + 1] : defaultRoot();
if (at >= 0 && !root) throw new Error('--root needs a folder');
const slugs = args.filter((a, i) => !a.startsWith('--') && i !== at + 1);
if (!slugs.length) {
  console.log(
    `Usage: npm run samples:reset -- <${BUSINESSES.map((b) => b.slug).join('|')}|all> [--root <folder>]`,
  );
  process.exit(2);
}
const targets = slugs.includes('all')
  ? BUSINESSES.map((b) => b.slug)
  : slugs.map((s) => business(s).slug);
try {
  for (const slug of targets) {
    const r = await resetBusiness(slug, { root });
    console.log(`Reset ${r.slug}`);
    console.log(`  Project folder:  ${r.project}`);
    console.log(`  App data:        ${r.dataDir} (empty)`);
    console.log(`  Desktop profile: ${r.profileDir} (empty)`);
    console.log(`  Files:           ${r.files}, sha256 ${r.sha256}`);
  }
  console.log(`\nOpen a sample in Nectovia with its own empty data, never your real profile:`);
  console.log(
    `  . '<root>\\<slug>\\env.ps1'   then start Nectovia from that window and open the project folder.`,
  );
  console.log(`  Root: ${root}`);
} catch (error) {
  console.error(`samples:reset stopped: ${(error as Error).message}`);
  process.exit(1);
}
