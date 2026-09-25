/**
 * `npm run release:check`: refuses a release whose app files changed since its
 * version was tagged. See `checkReleaseVersion` in packaged-release-check.mjs.
 * Run it before cutting a release; ordinary pull requests do not run it.
 */
import { checkReleaseVersion } from './packaged-release-check.mjs';

const result = await checkReleaseVersion();
(result.ok ? console.log : console.error)(result.message);
process.exitCode = result.ok ? 0 : 1;
