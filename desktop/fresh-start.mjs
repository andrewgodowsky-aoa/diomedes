import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * One clean start for 0.1.9 (Andrew, 2026-09-23). Every install so far is the
 * team's own, and 0.1.9 is the first build without the Workbook, so the first
 * launch of this release starts over from nothing: new settings, no projects,
 * no engine bindings, no saved sign-in. Nothing is deleted. The app data, the
 * project folder and the account-session store are renamed aside, so a person
 * can still recover a file by hand.
 *
 * It runs once per install, recorded by a marker in the Electron profile, and
 * never for a profile or data folder chosen through the environment (tests,
 * smoke drivers and installer proofs set those).
 */
export const FRESH_START_RELEASE = '0.1.9';
const MARKER = `fresh-start-${FRESH_START_RELEASE}`;
const AUTH_STORE = 'diomedes-native-auth.json';

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** A sibling name that is not taken yet, so an earlier set-aside is never overwritten. */
async function asideName(target, now) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const base = `${target} (before ${FRESH_START_RELEASE}, ${stamp})`;
  let candidate = base;
  for (let n = 2; await exists(candidate); n += 1) candidate = `${base} ${n}`;
  return candidate;
}

/**
 * @param {{ userData: string, dataDir: string, projectsDir?: string, now?: Date }} options
 * @returns {Promise<{ reset: boolean, moved: { from: string, to: string }[], kept: string[] }>}
 */
export async function freshStartOnce({ userData, dataDir, projectsDir, now = new Date() }) {
  const marker = path.join(userData, MARKER);
  if (await exists(marker)) return { reset: false, moved: [], kept: [] };
  const moved = [];
  const kept = [];
  // The app data decides whether this start is clean. If it cannot be moved,
  // no marker is written, so the next launch tries again rather than carrying
  // the old state forward for good.
  if (await exists(dataDir)) {
    const to = await asideName(dataDir, now);
    await fs.rename(dataDir, to);
    moved.push({ from: dataDir, to });
  }
  for (const target of [projectsDir, path.join(userData, AUTH_STORE)]) {
    if (!target || !(await exists(target))) continue;
    try {
      const to = await asideName(target, now);
      await fs.rename(target, to);
      moved.push({ from: target, to });
    } catch {
      // A project folder held open by another program stays where it is; the
      // fresh app data no longer lists anything in it.
      kept.push(target);
    }
  }
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(marker, `${now.toISOString()}\n`);
  return { reset: moved.length > 0, moved, kept };
}
