/**
 * The packs that ship with Diomedes, as P01 manifests with their digests.
 *
 * Nothing here changes what a bundled pack does. The Software Engineering and
 * Small Business manifests are derived from the runtime manifests those packs
 * already load through (`shared/capability-packs.ts`); the weekly brief is the
 * template in `shared/packs.ts`; each industry variant is read from its own
 * `resources/industry-variants/<id>/` folder, and the digest pins every byte
 * of that folder, so a changed fixture is a changed pack.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMALL_BUSINESS_PACK, SOFTWARE_ENGINEERING_PACK } from '../shared/capability-packs.js';
import {
  canonicalPackBytes,
  industryVariantPackManifest,
  manifestFromCapabilityPack,
  packManifestSchema,
  weeklyBriefPackManifest,
  type PackManifest,
  type PackManifestBody,
} from '../shared/pack-manifest.js';

export const BUNDLED_VARIANTS_ROOT = fileURLToPath(
  new URL('../resources/industry-variants/', import.meta.url),
);

export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** The digest a manifest body earns: sha-256 over its canonical bytes. */
export const packDigest = (body: PackManifestBody): `sha256:${string}` =>
  `sha256:${sha256(canonicalPackBytes(body))}`;

/** Seal a body with its digest and prove the result is a valid manifest. */
export function sealManifest(body: PackManifestBody): PackManifest {
  return packManifestSchema.parse({ ...body, digest: packDigest(body) });
}

/** The packs whose runtime is already wired in this build, and so install with Diomedes. */
export const PREINSTALLED_PACK_IDS: readonly string[] = Object.freeze([
  SOFTWARE_ENGINEERING_PACK.id,
  SMALL_BUSINESS_PACK.id,
]);

async function variantFiles(folder: string) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const walk = async (relative: string) => {
    const entries = await fs.readdir(path.join(folder, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(folder, next));
        files.push({ path: next, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  await walk('');
  return files;
}

/**
 * Every bundled pack, sealed. An industry variant folder that does not read as
 * a variant is left out rather than guessed at; the industry registry is still
 * the authority that refuses it by name for business setup.
 */
export async function bundledCatalogue(root = BUNDLED_VARIANTS_ROOT): Promise<PackManifest[]> {
  const bodies: PackManifestBody[] = [
    manifestFromCapabilityPack(SOFTWARE_ENGINEERING_PACK),
    manifestFromCapabilityPack(SMALL_BUSINESS_PACK),
    weeklyBriefPackManifest(),
  ];
  let folders: string[] = [];
  try {
    folders = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    folders = [];
  }
  for (const name of folders) {
    const folder = path.join(root, name);
    try {
      const variant = JSON.parse(await fs.readFile(path.join(folder, 'variant.json'), 'utf8')) as {
        id: string;
        label: string;
        outputLabel: string;
        scopeLabel: string;
        guidanceText: string;
        contractVersion: number;
      };
      bodies.push(industryVariantPackManifest({ ...variant, files: await variantFiles(folder) }));
    } catch {
      // Not a readable variant: business setup's registry reports it; the catalogue omits it.
    }
  }
  return bodies.map(sealManifest);
}

/** Where a bundled pack's payload files are read from when it is installed. */
export function bundledPayloadRoot(manifest: PackManifestBody, root = BUNDLED_VARIANTS_ROOT) {
  const prefix = 'diomedes.industry.';
  return manifest.id.startsWith(prefix) ? path.join(root, manifest.id.slice(prefix.length)) : null;
}
