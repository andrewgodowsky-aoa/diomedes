/**
 * How a conversation answer may carry artifacts, and the one composer of a conversation's
 * instructions (artifacts v2, owner decisions of 2026-09-23).
 *
 * `ARTIFACT_FORMAT` tells a model how to write what the Console reads out of a turn: the fences
 * `fenceKind` turns into artifacts, the declaration `declarationOf` reads off a fence's first line,
 * the id `DECLARED_ID` accepts and the title a declaration can hold (`shared/turn-blocks.ts`,
 * `shared/artifacts.ts`), and what the panel's frames and the Mermaid pre-check draw
 * (`client/console/artifact-frame.ts`, `client/console/mermaid-render.ts`). It is composed after a
 * mode's own text, never inside `MODES`, so every mode text stays as it shipped.
 *
 * `answerInstructions` is what a conversation message is sent with, and so what a new lineage
 * records. Ask and Plan get their own text and then the format. Automatic gets its own text, the
 * visual instructions, the format and, always last, the decision format, so "write nothing after
 * it" stays the last thing it is told and an artifact lands before the block `splitDecision`
 * cuts at. Build and Fix never get the format: a proposal is strict JSON (`native-work.ts`).
 *
 * Changing either the format or the composition changes the composed texts. Add each new text's
 * digest to `KNOWN_INSTRUCTION_DIGESTS`, with its fixture, and keep the old ones: open
 * conversations keep the text they started with (`lineage-continuity.ts`), and a person moves one
 * to the current text with "Update this conversation".
 */
import { instructionsFor, type ConversationMode } from './interaction-turn.js';
import { MODES, VISUAL_INSTRUCTIONS } from './modes.js';

export const ARTIFACT_FORMAT =
  'When a diagram, picture, page mock-up or document helps, put each one in its own block fenced as mermaid, svg, html or markdown, named on its first line: %% artifact: id=delivery-flow title="Delivery check" in mermaid, <!-- artifact: id=home-mock title="Home mock" --> in the others. An id is up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit; reuse it only to revise that artifact. Titles are plain, at most 120 characters, without " or --. Nothing may run or load: no script, event handlers, links, outside images or fonts. Keep a mermaid diagram under 50,000 characters, with no url(), and a picture in it only as A@{ img: "data:image/png;base64,..." } (PNG, JPEG, GIF or WebP). Mermaid math is $$...$$ within one line; a diagram with math has no < (write \\lt) or ~ anywhere and no & or \\ outside the math, and in a flowchart a math row break is \\\\\\\\. Charts go only in visual blocks. The text must stand without the blocks.';

/** The instructions a conversation message in `mode` is sent with today. */
export function answerInstructions(mode: ConversationMode): string {
  const base =
    mode === 'auto'
      ? `${MODES.auto.instructions}\n\n${VISUAL_INSTRUCTIONS}\n\n${ARTIFACT_FORMAT}`
      : `${MODES[mode].instructions}\n\n${ARTIFACT_FORMAT}`;
  return instructionsFor(mode, base);
}
