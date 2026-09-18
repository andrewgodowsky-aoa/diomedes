/**
 * Pictures: choosing one, and deciding how it sits.
 *
 * A3 shipped these controls as session-only state, because the contract stores
 * a placement only with the picture it places and there was no way yet to get a
 * picture. There is now, so this panel writes the pack: importing a file puts
 * `artwork.<slot>` and `assets.<hash>` in together, and every control after
 * that edits the placement through `artworkEdits`, which holds the bound the
 * contract states. Undo covers all of it for free, because the undo stack is
 * whole packs and a picture is now part of the pack.
 *
 * The file never leaves this computer. It is posted to the local service on
 * loopback, which reads its header, refuses what it cannot read, and stores the
 * original under the hash of its own bytes. Nothing is uploaded anywhere, no
 * model sees it, and no derivative is made — there is no image decoder in this
 * product, so what you import is what is stored and the browser scales it.
 */
import { useRef, useState } from 'react';
import {
  ARTWORK_MASKS,
  BLEND_MODES,
  type ArtworkSlot,
  type ThemePackV1,
} from '../../../shared/theme-pack/types';
import { Button } from '../../components';
import { ArtworkImage } from '../theme-artwork';
import { uploadAsset } from './themes-api';
import {
  ARTWORK_SLOT_LABELS,
  EDITABLE_ARTWORK_SLOTS,
  MASK_LABELS,
  artworkEdits,
} from './pack';

const SLOT_HINTS: Record<string, string> = {
  logo: 'Shown where this workspace names itself.',
  bust: 'The portrait plate beside a conversation.',
  emptyState: 'The picture on a screen with nothing in it yet.',
  texture:
    'A decorative background. It always sits beneath labels and focus rings, and turning texture off in Settings switches it off whatever a theme asks for.',
};

const BLEND_LABELS: Record<string, string> = {
  normal: 'Straight',
  multiply: 'Darken',
  screen: 'Lighten',
  'soft-light': 'Soft light',
};

/** A percentage, for the read-outs beside each slider. */
const asPercent = (value: number) => `${Math.round(value * 100)}%`;

function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="dc-art-control">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="mono">{asPercent(value)}</span>
    </label>
  );
}

export function Artwork({
  pack,
  themeId,
  onChange,
}: {
  pack: ThemePackV1;
  /** The theme these pictures are stored under: where an import lands. */
  themeId: string;
  onChange(next: ThemePackV1): void;
}) {
  const inputs = useRef<Partial<Record<ArtworkSlot, HTMLInputElement | null>>>({});
  const [busy, setBusy] = useState<ArtworkSlot | null>(null);
  const [problem, setProblem] = useState('');
  const [said, setSaid] = useState('');

  const importInto = async (slot: ArtworkSlot, file: File) => {
    setProblem('');
    setSaid('');
    setBusy(slot);
    try {
      const stored = await uploadAsset(themeId, file);
      onChange(artworkEdits.place(pack, slot, stored.hash, stored.record));
      setSaid(
        `${ARTWORK_SLOT_LABELS[slot]}: a ${stored.record.width}×${stored.record.height} picture is in place.`,
      );
    } catch (error) {
      // The service's own sentence, which says what was wrong with the file
      // rather than that something went wrong.
      setProblem(error instanceof Error ? error.message : 'That picture could not be imported.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="dc-section" aria-label="Artwork">
      <h3>Pictures</h3>
      <p className="caption">
        A picture you choose here is stored on this computer, inside this theme, and travels with it
        in the theme file. Nothing is uploaded and no picture is changed: PNG, JPEG and WebP up to
        two megabytes and sixteen megapixels. SVG is not accepted in this release.
      </p>
      {problem && (
        <p role="alert" className="fault-text">
          {problem}
        </p>
      )}
      <p className="caption" aria-live="polite">
        {said}
      </p>

      {EDITABLE_ARTWORK_SLOTS.map((slot) => {
        const entry = pack.artwork[slot];
        const record = entry ? pack.assets[entry.assetHash] : undefined;
        const label = ARTWORK_SLOT_LABELS[slot];
        return (
          <div className="dc-field" key={slot}>
            <div className="row">
              <span className="dc-field-label">{label}</span>
              <span className="push-right">
                <Button
                  tone="quiet"
                  disabled={busy === slot}
                  onClick={() => inputs.current[slot]?.click()}
                >
                  {entry ? 'Choose another picture' : 'Choose a picture'}
                </Button>
              </span>
            </div>
            <input
              ref={(element) => {
                inputs.current[slot] = element;
              }}
              type="file"
              className="dc-file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={`Import a picture for ${label}`}
              data-dc-artwork-input={slot}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice is still a change.
                event.target.value = '';
                if (file) void importInto(slot, file);
              }}
            />
            <p className="caption">{SLOT_HINTS[slot]}</p>

            {!entry ? (
              <p className="caption" data-dc-artwork-empty={slot}>
                No picture yet.
              </p>
            ) : (
              <div className="dc-placement" data-dc-artwork={slot}>
                <div className="dc-art-preview">
                  {/* The same renderer the app and the stage use, so what is
                      shown here is what will be painted, not an impression of
                      it. */}
                  <ArtworkImage themeId={themeId} pack={pack} slot={slot} />
                </div>
                <p className="caption mono" data-dc-artwork-size={slot}>
                  {record ? `${record.width}×${record.height}, ${record.bytes} bytes` : ''}
                </p>

                <Slider
                  label={`${label} focal point across`}
                  value={entry.focal.x}
                  onChange={(value) =>
                    onChange(artworkEdits.adjust(pack, slot, { focalX: value }))
                  }
                />
                <Slider
                  label={`${label} focal point down`}
                  value={entry.focal.y}
                  onChange={(value) => onChange(artworkEdits.adjust(pack, slot, { focalY: value }))}
                />
                <Slider
                  label={`${label} crop left`}
                  value={entry.crop.x}
                  onChange={(value) => onChange(artworkEdits.adjust(pack, slot, { cropX: value }))}
                />
                <Slider
                  label={`${label} crop top`}
                  value={entry.crop.y}
                  onChange={(value) => onChange(artworkEdits.adjust(pack, slot, { cropY: value }))}
                />
                <Slider
                  label={`${label} crop width`}
                  value={entry.crop.width}
                  min={0.05}
                  onChange={(value) =>
                    onChange(artworkEdits.adjust(pack, slot, { cropWidth: value }))
                  }
                />
                <Slider
                  label={`${label} crop height`}
                  value={entry.crop.height}
                  min={0.05}
                  onChange={(value) =>
                    onChange(artworkEdits.adjust(pack, slot, { cropHeight: value }))
                  }
                />
                <Slider
                  label={`${label} opacity`}
                  value={entry.opacity}
                  onChange={(value) => onChange(artworkEdits.adjust(pack, slot, { opacity: value }))}
                />

                <label className="dc-art-control">
                  <span>How it mixes</span>
                  <select
                    aria-label={`${label} blend`}
                    value={entry.blend}
                    onChange={(event) =>
                      onChange(artworkEdits.adjust(pack, slot, { blend: event.target.value }))
                    }
                  >
                    {BLEND_MODES.map((blend) => (
                      <option key={blend} value={blend}>
                        {BLEND_LABELS[blend]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dc-art-control">
                  <span>Edge</span>
                  <select
                    aria-label={`${label} mask`}
                    value={entry.mask}
                    onChange={(event) =>
                      onChange(artworkEdits.adjust(pack, slot, { mask: event.target.value }))
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
                  aria-label={`Remove the ${label} picture`}
                  onClick={() => onChange(artworkEdits.remove(pack, slot))}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
