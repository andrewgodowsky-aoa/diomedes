/**
 * Recomputes every planted problem in the sample businesses from their raw files and fails
 * when a file and its planted.md disagree.
 *
 *   npm run samples:check                 all five
 *   npm run samples:check -- <slug>       one
 *   npm run samples:check -- <slug> --table   print the computed planted.md table
 */
import { BUSINESSES, business, checkBusiness, plantedTable } from './suite.js';

const args = process.argv.slice(2);
const table = args.includes('--table');
const slugs = args.filter((a) => !a.startsWith('--'));
const targets =
  slugs.length && slugs[0] !== 'all'
    ? slugs.map((s) => business(s).slug)
    : BUSINESSES.map((b) => b.slug);
let failed = 0;
for (const slug of targets) {
  const report = checkBusiness(slug);
  if (table) console.log(`\n## ${slug}\n\n${plantedTable(report.findings)}\n`);
  if (report.errors.length) {
    failed++;
    console.log(
      `FAIL ${slug}: ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`,
    );
    for (const e of report.errors) console.log(`  - ${e}`);
  } else
    console.log(
      `ok   ${slug}: ${report.findings.length} planted problems recomputed from the files, all match planted.md`,
    );
}
if (failed) {
  console.log(`\n${failed} of ${targets.length} sample businesses drifted from planted.md.`);
  process.exit(1);
}
