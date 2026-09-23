import { useState, type CSSProperties } from 'react';
import bustA from './art/nectovia-bust-A-840x898.webp';
import bustB from './art/nectovia-bust-B-840x898.webp';
import {
  BAND_EDGES,
  BAND_OFFSETS,
  BAND_STEPS,
  SIGNATURE_BANDS,
  SIGNATURE_END,
  takeSignature,
} from './home-signature';
import { readMotionFacts } from './nectovia-motion';

function sessionStore() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The agent home's art (Home.dc.html): the networked oracle at rest over the
 * one horizon line, with the registration mark where the bust meets it: the
 * lead, the trail, and the coral tab that appears nowhere else.
 *
 * Once per session the bust arrives as the fractured signal: five uneven bands
 * of B, displaced with cyan and violet registration ghosts, lock into place
 * out of order while A resolves over them (nectovia.css draws the motion;
 * transforms, opacity and clip-path only). When A has resolved the bands are
 * taken out of the page, and since the resting look is every animation's
 * final frame, nothing moves when they go. When motion is off in any of its
 * forms, or the session has already seen it, only A is drawn. It is art, not
 * content: hidden from assistive technology and never in the way of a pointer.
 *
 * DiomedesHome mounts it only while the painted scheme is Nectovia, so the
 * pictures are never fetched for any other scheme.
 */
export function HomeArt() {
  // Decided once, on arrival: a re-render never replays or cuts it short.
  const [signature] = useState(() => takeSignature(sessionStore(), readMotionFacts()));
  const [settled, setSettled] = useState(false);
  const playing = signature && !settled;
  // `signed` stays for the life of the visit that played it, so the screen's
  // view shear, which that visit skips, does not start when the bands go.
  return (
    <div
      className={`nv-art${signature ? ' signed' : ''}${playing ? ' signature' : ''}`}
      aria-hidden="true"
      onAnimationEnd={
        playing
          ? (event) => {
              if (event.animationName === SIGNATURE_END) setSettled(true);
            }
          : undefined
      }
    >
      <div className="nv-bust">
        {playing &&
          Array.from({ length: SIGNATURE_BANDS }, (_, band) => (
            <div
              key={band}
              className="nv-band"
              style={
                {
                  '--top': `${BAND_EDGES[band]}%`,
                  '--bottom': `${100 - BAND_EDGES[band + 1]}%`,
                  '--shift': `${BAND_OFFSETS[band]}px`,
                  '--step': BAND_STEPS[band],
                  '--mask': `url(${bustB})`,
                } as CSSProperties
              }
            >
              <span className="nv-ghost lead" />
              <span className="nv-ghost trail" />
              <img src={bustB} alt="" draggable={false} />
            </div>
          ))}
        <img className="nv-rest" src={bustA} alt="" draggable={false} decoding="async" />
        <span className="nv-horizon">
          <span className="nv-reg" />
        </span>
      </div>
    </div>
  );
}
