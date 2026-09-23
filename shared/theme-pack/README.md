# ThemePack v1

The portable, versioned appearance contract shared by the Diomedes desktop Console
(`app-console`) and the diomedes.net Website Studio (`website`). One pack, two surfaces, one
validator.

Frozen at `schemaVersion: 1`. Anything that changes the meaning of a field in this folder is a new
schema version, not an edit.

## This is not a standard DTCG file

The **tokens** in `pack.tokens` follow the [DTCG](https://www.designtokens.org/tr/2025.10/format/)
`$type` / `$value` convention, because that convention is well understood and keeps a token's type
next to its value. **Everything else is a Diomedes format.** A ThemePack is not a DTCG document,
carries fields DTCG does not define (`surfaces`, `artwork`, `motion`, `assets`, `provenance`), and
should not be handed to a generic DTCG tool. Do not add DTCG features — aliases, `$extensions`,
groups, `{reference}` syntax — without a new schema version: the validator refuses them today, and
that refusal is the point.

## Files

| File               | What it is                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | The contract: every type, every allowed value, every bound, every limit. Imports nothing.                     |
| `validate.ts`      | `validateThemePack(unknown)` and the `migrate()` stub. Nothing is trusted until it has been through here.     |
| `resolve.ts`       | `resolveAppearance(layers)` — the layer order, and the CSS custom properties and `data-*` values it produces. |
| `compatibility.ts` | Which surface renders which field, and what happens to the ones it does not.                                  |
| `package.ts`       | The `.diomedes-theme` v1 container: export, import, `checksum()`, SHA-256 and base64.                         |
| `fixtures/`        | Two valid packs and the one small PNG they reference.                                                         |

Every one of these files imports only from this folder. That is enforced by a test, so the folder
can be copied to another repository (see `scripts/theme-pack-handoff.ts`) and used as it stands, with
no dependencies and no build step beyond TypeScript.

`npm run theme-pack:handoff` publishes the folder to `F:\Diomedes\deliverables\theme-pack-v1` with a
`MANIFEST.sha256`. It writes only into a destination it can recognise as its own — one that does not
exist, is empty, or already holds a `MANIFEST.sha256` — and refuses anything else rather than
recursively deleting a folder someone is using.

## A theme is data

A pack never carries CSS, HTML, JavaScript, a remote URL, a font to download, or executable motion.
It carries values the renderer already knows how to use. The validator refuses any string containing
`url(`, `<`, `javascript:` or `expression(`, anywhere in the document, including object keys.

No string anywhere in a pack — value or object key — may contain a control character either. That
range (`U+0000`–`U+001F` and `U+007F`) includes tab and newline, so every string in a pack is a
single line: `provenance.notes` is one paragraph of plain text, not a formatted block.

Colours are hex only: `#rrggbb` or `#rrggbbaa`. Functional notation is a parser surface, not a value.
The built-in schemes write their hairlines as `rgba(255,255,255,.07)`; the pack equivalent is
`#ffffff12`.

Fonts are chosen from `FONT_CHOICES` — ids of families the app already bundles, plus the platform
face. A pack names the id; the renderer owns the stack. Motion is a `presetId` from a fixed list plus
bounded numbers; a theme cannot describe a new animation, only pick one the renderer implements.

## The pack

```
schemaVersion  1
id             ^[a-z0-9][a-z0-9-]{2,63}$
name           display name, 1–64 characters, no markup and no control characters
revision       integer ≥ 1
baseTheme      one of the eleven built-in scheme ids (default: field)
surfaces       at least one of 'app-console' | 'website'
provenance     author, createdAt (ISO-8601), tool, notes?
tokens         color.{chrome,surface,raised,hair,hair2,t1,t2,t3,light,attn,fail} + lightScheme
typography     interface/reading/code scales (0.9, 1, 1.1, 1.25), lineHeight 1.3–1.9, three fonts
geometry       controlRadius 0–12 px, separatorStrength 0–1, density guided|standard|technical
artwork        logo, bust, emptyState, texture (+ website-only hero, sceneTreatment)
motion         presetId, duration 0–1200 ms, intensity 0–1, reducedMotionBehaviour 'static'
assets         sha-256 hex → { mime, bytes, width, height }
```

Unknown top-level keys are refused. So are unknown keys inside `tokens`, `typography`, `geometry`,
`motion`, `artwork` and every artwork placement. `density` keeps exactly the meaning it already has
in the Console.

Each artwork slot is `{ assetHash, focal {x,y}, crop {x,y,width,height}, opacity, blend, mask }`,
all normalised to 0–1 except the enumerations, with optional per-surface overrides under
`surfaces['app-console' | 'website']`. `assetHash` must be a key of `assets`.

`assets` is metadata only. The bytes travel in the package container, never inside the pack.

### Versioning

`validateThemePack` checks `schemaVersion` first and answers a foreign version with a single
`unsupported version` error rather than a hundred shape complaints. `migrate()` is the one place a
future version will grow a conversion; today it returns `{ ok: false, status: 'unsupported' }` for
anything but 1.

## Resolution order

`resolveAppearance(layers)` applies five layers, always in this order:

1. **defaults** — the built-in Field scheme and the Console's shipped typography, geometry and
   motion.
2. **selected theme** — a validated ThemePack.
3. **authorized workspace branding** — skipped entirely unless `authorized` is true. Entitlement is
   decided elsewhere (`services/control-plane/contract`), never here.
4. **allowed personal preferences** — interface, reading and code scale, density, reduced motion,
   texture opacity.
5. **mandatory accessibility and safety** — reduced motion, texture off, a contrast floor on the
   text roles, visible focus.

Layer 5 is written last and is not negotiable: a theme, a workspace or a personal preference cannot
edit it away. Asking for `motion: 'normal'` under `reducedMotion: true` still yields reduced motion.

The result is:

```ts
{
  vars:    { '--surface': '#100b1a', '--dm-ui-scale': '1.25', … },
  dataset: { package: 'graphite', themePack: 'mythic-synthwave', density: 'standard',
             motion: 'normal', texture: 'on', colorScheme: 'dark' },
  origins: { '--surface': 'theme', 'data:motion': 'accessibility', … }
}
```

`origins` names the layer that produced each value, keyed by the custom property name and by
`data:<key>` for dataset values. That is what an editor shows when it explains where a value came
from.

`dataset.motionPreset` carries `motion.presetId` through to the renderer, and layer 5 forces it to
`none` under reduced motion — which is what `reducedMotionBehaviour: 'static'` means in v1.

### What the app reads today, and what A2 is adding

`APPEARANCE_OUTPUTS` in `compatibility.ts` lists every custom property and dataset key the resolver
emits, with `existsInAppToday` saying whether `client/styles.css` already declares or selects on it.
A test asserts that flag against the real stylesheet, so the list cannot quietly go stale.

The colour tokens, `--r`/`--rb`, the three scales, the three fonts, `--dm-line-body`, the three
`--dm-t-*` timings, `data-package` and `data-motion` already existed before the Studio. The other
nine — `--dm-motion-intensity`, `--dm-texture-opacity`, `--dm-focus-width`, `--dm-focus-color`,
`data-theme-pack`, `data-density`, `data-texture`, `data-color-scheme` and `data-motion-preset` —
were added to `client/styles.css` by A2, and their flags flipped with them. Every rule that reads
one needs a value the built-in appearance path never writes, so applying a built-in scheme is
unchanged: `data-theme-pack` is absent unless a pack is applied, which makes it the hook for
anything that must not touch a built-in scheme. `--dm-texture-opacity` is declared and zeroed by
`data-texture='off'`, but no painted texture layer reads it yet — emitting a property nothing reads
is harmless; assuming it already works is not.

`dataset.package` is always the **base scheme id**, even for a custom pack, because
`desktop/main.mjs` keys `FIELD_TITLEBAR` by scheme id. A custom theme therefore always resolves a
working titlebar chrome/text pair.

Applying a resolved appearance means setting `document.documentElement` dataset values and custom
properties (or one `<style id="diomedes-theme">` holding only `--token: value` declarations). It
never navigates, reloads or restarts anything.

## What each surface renders

`THEME_PACK_COMPATIBILITY` in `compatibility.ts` is the manifest: one row per field, with
`renders` or `ignores` per surface and a note. `checkCompatibility(pack, surface)` reports against
it.

- **Optional field this surface does not render** → a **warning**, the field is ignored, the rest of
  the pack applies. `artwork.hero` and `artwork.sceneTreatment` are website-only v1 extensions, so
  the app warns and carries on. `artwork.emptyState` is the mirror case on the website.
- **The pack does not list this surface** → an **error**. Do not apply it. A pack built only for the
  website is not a Console theme with some parts missing; it is a pack that was never checked there.
- **`baseTheme`** is rendered by the app (fallbacks and the desktop titlebar) and carried but not
  rendered by the website, which reads only the resolved tokens. That is not worth a warning.

## The `.diomedes-theme` package

One JSON document — there is no zip and no archive format:

```json
{ "manifest": { "format": "diomedes-theme", "formatVersion": 1, "packId": "...",
                "revision": 3, "checksum": "...", "assetCount": 1, "totalAssetBytes": 232 },
  "pack":   { ... },
  "assets": { "<sha-256 hex>": "<base64 of exactly those bytes>" } }
```

Limits, all on decoded bytes: **8 MB total**, **2 MB per asset**, **16 megapixels per asset**. Asset
MIME types are `image/png`, `image/jpeg`, `image/webp`. Both caps and the pixel cap are injectable
(`ThemePackLimits`) so tests do not have to allocate megabytes.

Import checks, in order, and returns every problem it found: the container shape, the format and
version, the pack itself, the manifest checksum against the pack, that every asset's base64 decodes,
that the decoded bytes hash to the key they are filed under, that the declared byte count is true,
that no asset is carried which the pack did not declare and none it declared is missing, and every
size cap. A single flipped byte fails the hash and the package is refused.

Dimensions and type are read out of the image's own bytes — PNG IHDR, the JPEG SOF marker chain,
and the WebP VP8/VP8L/VP8X headers — by `readImageHeader`, which reads a fixed handful of bytes and
decodes nothing. A record that declares `16×16` for a 20000×20000 plate, or `image/png` for JPEG
bytes, is refused, and the megapixel cap is applied to the **measured** size. Bytes that are not a
readable PNG, JPEG or WebP are refused outright.

### `checksum(pack)` is content identity only

It is the SHA-256 of the pack's canonical (key-sorted) JSON. Two packs with the same checksum are
the same design, regardless of how their JSON was written.

**It is not a signature, not proof of authorship, and not proof of purchase.** Anyone can compute it
over anyone's pack. Licensing and entitlement are decided by the control plane
(`services/control-plane/contract`), never by a hash in a file.

## Fixtures

- `fixtures/mythic-synthwave.json` — violet, cyan and coral on black and graphite, on the `graphite`
  base, with a `bust` slot pointing at `fixtures/bust-plate.png` and a website-only `hero`.
- `fixtures/harbor-quiet.json` — a quiet variant on the `harbor` base, with a website-only
  `sceneTreatment`.

Both validate. Both carry exactly one website-only field, so the app-console warning path is
exercised on each. `fixtures/bust-plate.png` is a real 16×16 PNG (232 bytes); the tests hash it and
read its IHDR rather than trusting the numbers in the JSON.
