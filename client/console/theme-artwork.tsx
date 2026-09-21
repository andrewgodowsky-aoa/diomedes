/**
 * Painting a theme's pictures, in the app and in the preview.
 *
 * Four boundaries this file exists to hold.
 *
 * 1. **A theme carries a hash, not a link.** `isSafeProperty` in
 *    `theme-runtime.ts` refuses `url(` outright, which is exactly right: a
 *    custom property carrying a URL is a theme fetching something. So no
 *    picture reaches the document through a token. A theme says which bytes it
 *    wants by their SHA-256, and *this app* decides that a hash means
 *    `/api/themes/<id>/assets/<hash>` on its own loopback service. Nothing a
 *    theme file contains can point anywhere else.
 *
 * 2. **Blend and mask are names, not CSS.** Both come from closed lists in the
 *    contract and are used as class-name suffixes onto rules that already
 *    exist in the stylesheet. There is no declaration built from a theme's
 *    value, so there is nothing for a value to break out of.
 *
 * 3. **The texture is decorative and stays underneath.** It is an
 *    `aria-hidden`, `pointer-events: none` layer at `z-index: -1` inside a
 *    stacking context of its own, so it paints above its container's
 *    background and below every label, control and focus ring in it — without
 *    a single `z-index` anywhere else having to know it exists. A texture that
 *    could cover the label of a button someone is about to press would be a
 *    safety fault, not a style one.
 *
 * 4. **Opacity is not the theme's last word.** The layer's opacity is
 *    `--dm-texture-opacity`, which the resolver sets from the theme, then lets
 *    the person's own preference lower, and then the accessibility layer zero.
 *    Turning texture off must win over whatever a theme wanted, so the theme's
 *    number is never written straight onto the element.
 */
import type { ArtworkEntry, ArtworkSlot, ThemePackV1 } from '../../shared/theme-pack/types';
import { ARTWORK_MASKS, BLEND_MODES } from '../../shared/theme-pack/types';

/** The URL a hash means. Built here from validated parts, never from a theme. */
export const themeAssetUrl = (themeId: string, hash: string) =>
  `/api/themes/${encodeURIComponent(themeId)}/assets/${encodeURIComponent(hash)}`;

/**
 * The fixed classes a placement maps onto.
 *
 * Checked against the contract's own lists rather than interpolated blind: a
 * pack is validated before it gets here, and this is the seam where a value
 * becomes part of a class name, so it is worth being certain twice.
 */
export function artworkClasses(entry: ArtworkEntry): string {
  const blend = (BLEND_MODES as readonly string[]).includes(entry.blend) ? entry.blend : 'normal';
  const mask = (ARTWORK_MASKS as readonly string[]).includes(entry.mask) ? entry.mask : 'none';
  return `dm-artwork dm-blend-${blend} dm-mask-${mask}`;
}

/**
 * Where the picture sits, as a background.
 *
 * A crop says which part of the picture is the picture at all; the focal point
 * says what survives when the slot is a different shape from what is left. So
 * an uncropped placement covers the slot around its focal point, and a cropped
 * one scales its rectangle up to fill the slot.
 */
export function artworkBackground(themeId: string, entry: ArtworkEntry): React.CSSProperties {
  const { crop, focal } = entry;
  const whole = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
  const percent = (value: number) => `${Math.round(value * 10000) / 100}%`;
  return {
    backgroundImage: `url("${themeAssetUrl(themeId, entry.assetHash)}")`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: whole
      ? 'cover'
      : `${percent(1 / Math.max(crop.width, 0.05))} ${percent(1 / Math.max(crop.height, 0.05))}`,
    backgroundPosition: whole
      ? `${percent(focal.x)} ${percent(focal.y)}`
      : `${crop.width >= 1 ? '50%' : percent(crop.x / (1 - crop.width))} ${
          crop.height >= 1 ? '50%' : percent(crop.y / (1 - crop.height))
        }`,
  };
}

/**
 * The decorative texture layer for a container.
 *
 * Renders nothing at all when the theme places no texture, so the ordinary
 * case adds no element to the document. The container needs
 * `position: relative; isolation: isolate` — `.app` and `.dc-stage` both have
 * it — and that is the whole of the stacking arrangement.
 */
export function TextureLayer({
  themeId,
  pack,
}: {
  themeId: string | null;
  pack: ThemePackV1 | null;
}) {
  const texture = pack?.artwork.texture;
  if (!themeId || !texture) return null;
  return (
    <div
      className={`dm-texture-layer ${artworkClasses(texture)}`}
      // Decorative by definition: it carries no information, and a screen
      // reader announcing "image" over every screen would be noise.
      aria-hidden="true"
      data-dm-texture="on"
      style={artworkBackground(themeId, texture)}
    />
  );
}

/**
 * One placed picture, drawn where its slot belongs.
 *
 * A background rather than an `<img>`, so that the crop rectangle means the
 * same thing in every slot: `object-fit` cannot show an arbitrary sub-rectangle
 * of a picture, and two different answers to "what does crop do here" is the
 * kind of difference nobody finds until they have shipped a theme. The element
 * takes `role="img"` and a label when it has been given words, and is hidden
 * from assistive technology when it has not — a decorative plate with an
 * invented description is worse than a decorative plate with none.
 *
 * No derivative is served: this product carries no image decoder and is not
 * adding one, so the original is fetched and the browser scales it.
 */
export function ArtworkImage({
  themeId,
  pack,
  slot,
  label = '',
  className = '',
}: {
  themeId: string | null;
  pack: ThemePackV1 | null;
  slot: ArtworkSlot;
  label?: string;
  className?: string;
}) {
  const entry = pack?.artwork[slot];
  if (!themeId || !entry) return null;
  return (
    <span
      className={`dm-artwork-slot dm-slot-${slot} ${artworkClasses(entry)} ${className}`.trim()}
      data-dm-slot={slot}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      style={{ ...artworkBackground(themeId, entry), opacity: entry.opacity }}
    />
  );
}
