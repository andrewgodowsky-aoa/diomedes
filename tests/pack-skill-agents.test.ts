import { describe, expect, test } from 'vitest';
import { AGENT_CATALOG, listedAgents, runKindOf } from '../shared/agents.js';
import {
  isSkillAgent,
  skillAgentIds,
  SMALL_BUSINESS_PACK,
  validateManifest,
  type CapabilityPackManifest,
  type PackSkill,
} from '../shared/capability-packs.js';

// DIO-311: a pack skill names the Agent it runs as, instead of carrying a Mode.
const agent = (id: string) => AGENT_CATALOG.find((item) => item.id === id)!;
const base = SMALL_BUSINESS_PACK.skills[0];
const withAgent = (id: unknown) =>
  validateManifest({
    ...SMALL_BUSINESS_PACK,
    skills: [{ ...base, agent: id } as PackSkill],
  } as CapabilityPackManifest);

describe('a skill names a read-and-draft built-in Agent', () => {
  test('Researcher, Planner and Explorer are each accepted', () => {
    for (const id of ['diomedes.researcher', 'diomedes.architect', 'diomedes.explorer']) {
      expect(isSkillAgent(agent(id))).toBe(true);
      expect(skillAgentIds()).toContain(id);
      expect(withAgent(id)).toEqual([]);
    }
  });

  test('every Agent the rule accepts is listed, reads and drafts, and writes nothing', () => {
    expect(skillAgentIds().length).toBeGreaterThanOrEqual(3);
    for (const id of skillAgentIds()) {
      const definition = agent(id);
      expect(listedAgents([definition])).toHaveLength(1);
      expect(['ask', 'plan']).toContain(runKindOf(definition));
      expect(definition.requires).not.toContain('text-proposals');
    }
  });

  test('an internal Agent is refused', () => {
    const internal = AGENT_CATALOG.find((item) => item.internal)!;
    expect(isSkillAgent(internal)).toBe(false);
    expect(withAgent(internal.id)).toContain(
      `Skill ${base.id} names an Agent that is not offered to people: ${internal.id}.`,
    );
  });

  test('an id that is not in the catalog is refused', () => {
    expect(withAgent('diomedes.no-such-agent')).toContain(
      `Skill ${base.id} names an Agent that does not exist: diomedes.no-such-agent.`,
    );
    expect(withAgent(undefined)).toHaveLength(1);
  });

  test('an Agent that writes files is refused', () => {
    for (const id of ['diomedes.builder', 'diomedes.debugger', 'diomedes.writer']) {
      expect(isSkillAgent(agent(id))).toBe(false);
      expect(withAgent(id)).toContain(
        `Skill ${base.id} names an Agent that writes files. A skill reads and drafts; it never writes.`,
      );
    }
  });

  test('the twelve Small Business skills all pass validateManifest', () => {
    expect(SMALL_BUSINESS_PACK.skills).toHaveLength(12);
    expect(validateManifest(SMALL_BUSINESS_PACK)).toEqual([]);
    for (const skill of SMALL_BUSINESS_PACK.skills)
      expect(['diomedes.researcher', 'diomedes.architect']).toContain(skill.agent);
  });
});
