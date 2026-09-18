/**
 * The inspector: one plain question per control, and where the answer came from.
 *
 * Every control writes a ThemePack field through `packEdits`, which holds the
 * bound the contract states, so no control here can produce a pack the
 * validator would refuse. Every control also shows its origin — the layer
 * `resolveAppearance` says produced the value now on screen — because
 * "inherited" and "overridden" look identical until something says which.
 *
 * The labels are the ones the app already uses. Density is still guided,
 * standard and technical; a theme does not get to rename the product's words.
 */
import type { ReactNode } from 'react';
import {
  APPROVED_SCALES,
  ARTWORK_MASKS,
  BASE_THEME_IDS,
  BLEND_MODES,
  DENSITIES,
  FONT_CHOICES,
  MOTION_PRESET_IDS,
  type ArtworkSlot,
  type BaseThemeId,
  type ColorTokenName,
  type ThemePackV1,
} from '../../../shared/theme-pack/types';
import type { AppearanceLayerName, ResolvedAppearance } from '../../../shared/theme-pack/resolve';
import { Button } from '../../components';
import {
  ARTWORK_SLOT_LABELS,
  BRAND_TOKENS,
  DENSITY_LABELS,
  EDITABLE_ARTWORK_SLOTS,
  FONT_LABELS,
  MASK_LABELS,
  MOTION_LABELS,
  SEMANTIC_TOKENS,
  SIDEBAR_WIDTHS,
  TOKEN_LABELS,
  editPlacement,
  packEdits,
  packFromBaseTheme,
  type ArtworkPlacementDraft,
} from './pack';

/** Which custom property or dataset key carries each control's answer. */
const COLOUR_VARS: Record<ColorTokenName, string> = {
  chrome: '--chrome',
  surface: '--surface',
  raised: '--raised',
  hair: '--hair',
  hair2: '--hair-2',
  t1: '--t1',
  t2: '--t2',
  t3: '--t3',
  light: '--light',
  attn: '--attn',
  fail: '--fail',
};

const ORIGIN_WORDS: Record<AppearanceLayerName, string> = {
  defaults: 'Inherited from the built-in appearance',
  theme: 'Set by this theme',
  workspace: 'Set by your workspace',
  personal: 'Your own preference wins here',
  accessibility: 'Required, and cannot be overridden',
};

function Origin({ layer }: { layer: AppearanceLayerName | undefined }) {
  if (!layer) return null;
  return (
    <span className={`dc-origin ${layer}`} data-origin={layer}>
      {ORIGIN_WORDS[layer]}
    </span>
  );
}

function Field({
  label,
  origin,
  hint,
  onReset,
  children,
}: {
  label: string;
  origin?: AppearanceLayerName;
  hint?: string;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dc-field">
      <div className="row">
        <span className="dc-field-label">{label}</span>
        <span className="push-right">
          {onReset && (
            <Button tone="quiet" onClick={onReset} aria-label={`Reset ${label}`}>
              Reset
            </Button>
          )}
        </span>
      </div>
      {children}
      <Origin layer={origin} />
      {hint && <p className="caption">{hint}</p>}
    </div>
  );
}

export function Inspector({
  pack,
  resolved,
  selectedPiece,
  placements,
  onPlacements,
  sidebarWidth,
  onSidebarWidth,
  reducedMotionPreview,
  onReducedMotionPreview,
  onReplay,
  onChange,
}: {
  pack: ThemePackV1;
  resolved: ResolvedAppearance;
  selectedPiece: { name: string; about: string } | null;
  placements: Partial<Record<ArtworkSlot, ArtworkPlacementDraft>>;
  onPlacements(next: Partial<Record<ArtworkSlot, ArtworkPlacementDraft>>): void;
  sidebarWidth: string;
  onSidebarWidth(id: string): void;
  reducedMotionPreview: boolean;
  onReducedMotionPreview(on: boolean): void;
  onReplay(): void;
  onChange(next: ThemePackV1): void;
}) {
  const origin = (key: string) => resolved.origins[key];
  /** The same field in a fresh pack on this base scheme: what "inherited" means. */
  const inherited = packFromBaseTheme(pack.baseTheme, pack.name, pack.id, pack.provenance.author, pack.provenance.createdAt);

  return (
    <aside className="dc-inspector" aria-label="Design Center inspector">
      {selectedPiece && (
        <section className="dc-section dc-selection" aria-label="Selected component">
          <h3>{selectedPiece.name}</h3>
          <p className="caption">{selectedPiece.about}</p>
        </section>
      )}

      <section className="dc-section" aria-label="Name and base">
        <h3>This theme</h3>
        <Field label="Name">
          <input
            aria-label="Theme name"
            value={pack.name}
            maxLength={64}
            onChange={(e) => onChange(packEdits.name(pack, e.target.value))}
          />
        </Field>
        <Field
          label="Built on"
          origin={origin('data:package')}
          hint="The built-in scheme this theme falls back to, and the one the window frame is coloured from."
        >
          <select
            aria-label="Built on"
            value={pack.baseTheme}
            onChange={(e) => onChange(packEdits.baseTheme(pack, e.target.value as BaseThemeId))}
          >
            {BASE_THEME_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="dc-section" aria-label="Brand colours">
        <h3>Your colours</h3>
        <p className="caption">
          The colours that make this theme yours. Nothing in the app depends on what they mean.
        </p>
        {BRAND_TOKENS.map((token) => (
          <Field
            key={token}
            label={TOKEN_LABELS[token]}
            origin={origin(COLOUR_VARS[token])}
            onReset={() =>
              onChange(packEdits.colour(pack, token, inherited.tokens.color[token].$value))
            }
          >
            <ColourInput
              label={TOKEN_LABELS[token]}
              value={pack.tokens.color[token].$value}
              onChange={(value) => onChange(packEdits.colour(pack, token, value))}
            />
          </Field>
        ))}
      </section>

      <section className="dc-section" aria-label="Meaning colours">
        <h3>Colours that mean something</h3>
        <p className="caption">
          The app uses these to say “this is the main text”, “this needs you”, “this failed”. Keep
          them legible and keep them apart.
        </p>
        {SEMANTIC_TOKENS.map((token) => (
          <Field
            key={token}
            label={TOKEN_LABELS[token]}
            origin={origin(COLOUR_VARS[token])}
            onReset={() =>
              onChange(packEdits.colour(pack, token, inherited.tokens.color[token].$value))
            }
          >
            <ColourInput
              label={TOKEN_LABELS[token]}
              value={pack.tokens.color[token].$value}
              onChange={(value) => onChange(packEdits.colour(pack, token, value))}
            />
          </Field>
        ))}
        <Field label="Light palette" hint="Tells the app and this computer that the page is light, not dark.">
          <label className="setting-row">
            <span>This is a light theme</span>
            <input
              type="checkbox"
              checked={pack.tokens.lightScheme.$value}
              onChange={(e) => onChange(packEdits.lightScheme(pack, e.target.checked))}
            />
          </label>
        </Field>
      </section>

      <section className="dc-section" aria-label="Type">
        <h3>Type</h3>
        {(
          [
            ['interfaceScale', 'Interface size', '--dm-ui-scale'],
            ['readingScale', 'Reading size', '--dm-read-scale'],
            ['codeScale', 'Code size', '--dm-code-scale'],
          ] as const
        ).map(([key, label, variable]) => (
          <Field
            key={key}
            label={label}
            origin={origin(variable)}
            onReset={() => onChange(packEdits.scale(pack, key, inherited.typography[key]))}
          >
            <select
              aria-label={label}
              value={pack.typography[key]}
              onChange={(e) => onChange(packEdits.scale(pack, key, Number(e.target.value)))}
            >
              {APPROVED_SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {Math.round(scale * 100)}%
                </option>
              ))}
            </select>
          </Field>
        ))}
        <Field
          label="Line height"
          origin={origin('--dm-line-body')}
          onReset={() => onChange(packEdits.lineHeight(pack, inherited.typography.lineHeight))}
        >
          <input
            type="range"
            aria-label="Line height"
            min={1.3}
            max={1.9}
            step={0.05}
            value={pack.typography.lineHeight}
            onChange={(e) => onChange(packEdits.lineHeight(pack, Number(e.target.value)))}
          />
          <span className="mono">{pack.typography.lineHeight}</span>
        </Field>
        {(
          [
            ['interfaceFont', 'Interface face', '--dm-font-ui'],
            ['readingFont', 'Reading face', '--dm-font-read'],
            ['codeFont', 'Code face', '--dm-font-code'],
          ] as const
        ).map(([key, label, variable]) => (
          <Field
            key={key}
            label={label}
            origin={origin(variable)}
            hint="Only faces this app already carries. A theme never downloads a font."
            onReset={() => onChange(packEdits.font(pack, key, inherited.typography[key]))}
          >
            <select
              aria-label={label}
              value={pack.typography[key]}
              onChange={(e) => onChange(packEdits.font(pack, key, e.target.value))}
            >
              {FONT_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {FONT_LABELS[choice] ?? choice}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </section>

      <section className="dc-section" aria-label="Surfaces and controls">
        <h3>Surfaces and controls</h3>
        <Field
          label="Separator strength"
          origin={origin('--hair')}
          hint="How present the lines between things are. 0 hides them; 1 is the app’s own hairline."
          onReset={() =>
            onChange(packEdits.separatorStrength(pack, inherited.geometry.separatorStrength))
          }
        >
          <input
            type="range"
            aria-label="Separator strength"
            min={0}
            max={1}
            step={0.05}
            value={pack.geometry.separatorStrength}
            onChange={(e) => onChange(packEdits.separatorStrength(pack, Number(e.target.value)))}
          />
          <span className="mono">{pack.geometry.separatorStrength}</span>
        </Field>
        <Field
          label="Control radius"
          origin={origin('--r')}
          hint="How round buttons, inputs and cards are, in pixels."
          onReset={() => onChange(packEdits.controlRadius(pack, inherited.geometry.controlRadius))}
        >
          <input
            type="range"
            aria-label="Control radius"
            min={0}
            max={12}
            step={1}
            value={pack.geometry.controlRadius}
            onChange={(e) => onChange(packEdits.controlRadius(pack, Number(e.target.value)))}
          />
          <span className="mono">{pack.geometry.controlRadius}px</span>
        </Field>
        <Field
          label="Density"
          origin={origin('data:density')}
          hint="The same three settings the Console already has, with the same meanings."
          onReset={() => onChange(packEdits.density(pack, inherited.geometry.density))}
        >
          <div className="segmented">
            {DENSITIES.map((density) => (
              <button
                key={density}
                type="button"
                className={pack.geometry.density === density ? 'on' : ''}
                aria-pressed={pack.geometry.density === density}
                onClick={() => onChange(packEdits.density(pack, density))}
              >
                {DENSITY_LABELS[density]}
              </button>
            ))}
          </div>
        </Field>
      </section>

      <section className="dc-section" aria-label="Artwork">
        <h3>Pictures</h3>
        <p className="caption">
          Where a picture sits in its slot. Adding the picture itself arrives in a later version;
          until it does, these settings are kept for this session and are not part of the saved
          theme, because the contract stores a placement only with the picture it places.
        </p>
        {EDITABLE_ARTWORK_SLOTS.map((slot) => {
          const placement = placements[slot];
          return (
            <Field key={slot} label={ARTWORK_SLOT_LABELS[slot]}>
              {!placement ? (
                <Button
                  onClick={() =>
                    onPlacements({
                      ...placements,
                      [slot]: {
                        focal: { x: 0.5, y: 0.5 },
                        crop: { x: 0, y: 0, width: 1, height: 1 },
                        opacity: 1,
                        blend: 'normal',
                        mask: 'none',
                      },
                    })
                  }
                >
                  Place a picture here
                </Button>
              ) : (
                <div className="dc-placement">
                  <div className="dc-placeholder" aria-hidden="true">
                    No picture yet
                  </div>
                  <label>
                    <span>Across</span>
                    <input
                      type="range"
                      aria-label={`${ARTWORK_SLOT_LABELS[slot]} focal point across`}
                      min={0}
                      max={1}
                      step={0.05}
                      value={placement.focal.x}
                      onChange={(e) =>
                        onPlacements({
                          ...placements,
                          [slot]: editPlacement(placement, { focalX: Number(e.target.value) }),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Down</span>
                    <input
                      type="range"
                      aria-label={`${ARTWORK_SLOT_LABELS[slot]} focal point down`}
                      min={0}
                      max={1}
                      step={0.05}
                      value={placement.focal.y}
                      onChange={(e) =>
                        onPlacements({
                          ...placements,
                          [slot]: editPlacement(placement, { focalY: Number(e.target.value) }),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>How solid</span>
                    <input
                      type="range"
                      aria-label={`${ARTWORK_SLOT_LABELS[slot]} opacity`}
                      min={0}
                      max={1}
                      step={0.05}
                      value={placement.opacity}
                      onChange={(e) =>
                        onPlacements({
                          ...placements,
                          [slot]: editPlacement(placement, { opacity: Number(e.target.value) }),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>How it mixes</span>
                    <select
                      aria-label={`${ARTWORK_SLOT_LABELS[slot]} blend`}
                      value={placement.blend}
                      onChange={(e) =>
                        onPlacements({
                          ...placements,
                          [slot]: editPlacement(placement, { blend: e.target.value }),
                        })
                      }
                    >
                      {BLEND_MODES.map((blend) => (
                        <option key={blend} value={blend}>
                          {blend}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Edge</span>
                    <select
                      aria-label={`${ARTWORK_SLOT_LABELS[slot]} mask`}
                      value={placement.mask}
                      onChange={(e) =>
                        onPlacements({
                          ...placements,
                          [slot]: editPlacement(placement, { mask: e.target.value }),
                        })
                      }
                    >
                      {ARTWORK_MASKS.map((mask) => (
                        <option key={mask} value={mask}>
                          {MASK_LABELS[mask]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    tone="quiet"
                    onClick={() => {
                      const next = { ...placements };
                      delete next[slot];
                      onPlacements(next);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </Field>
          );
        })}
      </section>

      <section className="dc-section" aria-label="Movement">
        <h3>Movement</h3>
        <Field
          label="How things move"
          origin={origin('data:motionPreset')}
          onReset={() => onChange(packEdits.motionPreset(pack, inherited.motion.presetId))}
        >
          <select
            aria-label="How things move"
            value={pack.motion.presetId}
            onChange={(e) => onChange(packEdits.motionPreset(pack, e.target.value))}
          >
            {MOTION_PRESET_IDS.map((preset) => (
              <option key={preset} value={preset}>
                {MOTION_LABELS[preset]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="How long"
          origin={origin('--dm-t-view')}
          onReset={() => onChange(packEdits.motionDuration(pack, inherited.motion.duration))}
        >
          <input
            type="range"
            aria-label="How long"
            min={0}
            max={1200}
            step={20}
            value={pack.motion.duration}
            onChange={(e) => onChange(packEdits.motionDuration(pack, Number(e.target.value)))}
          />
          <span className="mono">{pack.motion.duration}ms</span>
        </Field>
        <Field
          label="How much"
          origin={origin('--dm-motion-intensity')}
          onReset={() => onChange(packEdits.motionIntensity(pack, inherited.motion.intensity))}
        >
          <input
            type="range"
            aria-label="How much"
            min={0}
            max={1}
            step={0.05}
            value={pack.motion.intensity}
            onChange={(e) => onChange(packEdits.motionIntensity(pack, Number(e.target.value)))}
          />
          <span className="mono">{pack.motion.intensity}</span>
        </Field>
        <div className="actions">
          <Button onClick={onReplay}>Replay</Button>
        </div>
        <label className="setting-row">
          <span>Preview with reduced motion</span>
          <input
            type="checkbox"
            checked={reducedMotionPreview}
            onChange={(e) => onReducedMotionPreview(e.target.checked)}
          />
        </label>
        <p className="caption">
          Reduced motion stops movement whatever a theme asks for. This shows what someone who has
          asked for it will see; it does not change your own setting.
        </p>
      </section>

      <section className="dc-section" aria-label="Layout">
        <h3>Layout</h3>
        <Field
          label="Sidebar width"
          hint="ThemePack v1 carries no layout, so this is a preview preference and is not saved into the theme."
        >
          <div className="segmented">
            {SIDEBAR_WIDTHS.map((width) => (
              <button
                key={width.id}
                type="button"
                className={sidebarWidth === width.id ? 'on' : ''}
                aria-pressed={sidebarWidth === width.id}
                onClick={() => onSidebarWidth(width.id)}
              >
                {width.label}
              </button>
            ))}
          </div>
        </Field>
      </section>
    </aside>
  );
}

/**
 * A colour, as a swatch and as the hex the pack stores.
 *
 * Both are shown because the picker cannot express the eight-digit hex the
 * contract allows for the separators, and the text field can.
 */
function ColourInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const opaque = value.length === 9 ? value.slice(0, 7) : value;
  return (
    <span className="dc-colour">
      <input
        type="color"
        aria-label={`${label} swatch`}
        value={opaque}
        onChange={(e) => onChange(value.length === 9 ? `${e.target.value}${value.slice(7)}` : e.target.value)}
      />
      <input
        type="text"
        aria-label={`${label} hex`}
        className="mono"
        value={value}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value.trim();
          if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(next)) onChange(next);
        }}
      />
    </span>
  );
}
