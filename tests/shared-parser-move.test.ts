// The parser lives in shared/turn-blocks.ts and shared/artifacts.ts now, and
// client/console/turn-blocks.ts and client/console/artifacts.ts are re-export
// shims at the old paths. This proves the shim is a re-export, not a copy: the
// same function objects come back through either path, so the two can never
// drift apart.
import { describe, expect, it } from 'vitest';
import * as sharedArtifacts from '../shared/artifacts';
import * as sharedTurnBlocks from '../shared/turn-blocks';
import * as shimArtifacts from '../client/console/artifacts';
import * as shimTurnBlocks from '../client/console/turn-blocks';

describe('the shims at the old client paths', () => {
  it('re-export the exact shared/turn-blocks module', () => {
    expect(Object.keys(shimTurnBlocks).sort()).toEqual(Object.keys(sharedTurnBlocks).sort());
    for (const key of Object.keys(sharedTurnBlocks)) {
      expect(shimTurnBlocks[key as keyof typeof shimTurnBlocks], key).toBe(
        sharedTurnBlocks[key as keyof typeof sharedTurnBlocks],
      );
    }
  });

  it('re-export the exact shared/artifacts module', () => {
    expect(Object.keys(shimArtifacts).sort()).toEqual(Object.keys(sharedArtifacts).sort());
    for (const key of Object.keys(sharedArtifacts)) {
      expect(shimArtifacts[key as keyof typeof shimArtifacts], key).toBe(
        sharedArtifacts[key as keyof typeof sharedArtifacts],
      );
    }
  });

  it('reads the same artifact index whichever path a caller imports', () => {
    // The index carries closures (versionsOf, forBlock), so two separate calls
    // are never reference-equal even through the same function; the list is
    // the part that must actually agree.
    const text = '```mermaid\ngraph TD\n  A-->B\n```';
    const turn = { id: 't1', role: 'diomedes', text };
    expect(shimArtifacts.indexArtifacts('thread-1', [turn]).list).toEqual(
      sharedArtifacts.indexArtifacts('thread-1', [turn]).list,
    );
  });
});
