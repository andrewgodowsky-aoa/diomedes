/**
 * Demo data for the faux cloud. Every record is made through the same service
 * calls a person or staff member would make — sign-up, creating a business,
 * invitation codes, staff administration, route registry, policy publication
 * and grant issue — so the seed also exercises those paths. Only the first
 * admin is bootstrapped, through bootstrapFirstAdmin, because staff
 * administration needs one to exist.
 *
 * In password mode every account's password is FAUX_DEMO_PASSWORD. In
 * workos-standin mode there are no passwords: each person signs in through the
 * stand-in with their email. Faux data only: none of these people, businesses or
 * grants exist, and nothing here was bought.
 */
import type { FauxCloud } from './cloud.js';
import { bootstrapFirstAdmin, type RouteEntry } from '../commercial.js';

export const FAUX_DEMO_PASSWORD = 'nectovia-demo';
export const FAUX_SEED_ID = 'demo-2026-09-25';

export const DEMO_ACCOUNTS = {
  owner: { email: 'owner@juniper.test', name: 'Maya Ortiz' },
  manager: { email: 'manager@juniper.test', name: 'Sam Rivera' },
  employee: { email: 'employee@juniper.test', name: 'Priya Shah' },
  harborOwner: { email: 'owner@harbor.test', name: 'Leo Grant' },
  free: { email: 'free@example.test', name: 'Jordan Lee' },
  staffAdmin: { email: 'admin@diomedes.test', name: 'Ops Admin' },
  staffSupport: { email: 'support@diomedes.test', name: 'Ops Support' },
  staffBilling: { email: 'billing@diomedes.test', name: 'Ops Billing' },
  staffRouting: { email: 'routing@diomedes.test', name: 'Ops Routing' },
} as const;
export type DemoAccount = keyof typeof DEMO_ACCOUNTS;

type RouteSeed = Omit<RouteEntry, 'v' | 'revision' | 'updatedAt' | 'updatedBy'>;
export const DEMO_ROUTES: readonly RouteSeed[] = [
  {
    id: 'aws-luna-5-6', provider: 'aws-bedrock', model: 'us.openai.gpt-5.6-luna', label: 'GPT-5.6 Luna', region: 'us',
    processing: 'AWS Bedrock US inference profile. The provider does not train on inputs.', status: 'qualified',
    evidence: 'Faux seed: the route Efficient runs on today (routing decision 2026-09-21). Replace with a dated qualification record before go-live.',
  },
  {
    id: 'aws-luna-6', provider: 'aws-bedrock', model: 'us.openai.gpt-6-luna', label: 'GPT-6 Luna', region: 'us',
    processing: 'AWS Bedrock US inference profile. In the faux cloud a scripted provider answers instead.', status: 'qualified',
    evidence: 'Faux seed: scripted provider, 2026-09-25',
  },
  {
    id: 'aws-sol-6', provider: 'aws-bedrock', model: 'us.openai.gpt-6-sol', label: 'GPT-6 Sol', region: 'us',
    processing: 'AWS Bedrock US inference profile.', status: 'unqualified',
    evidence: 'Announced on Bedrock 2026-09-22. Not yet checked on the company account.',
  },
  {
    id: 'vertex-gemini-3-8-flash', provider: 'google-vertex', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', region: 'us-central1',
    processing: 'Google Vertex AI, project diomedes-dev.', status: 'qualified',
    evidence: 'Faux seed: the Focused route of the 2026-09-23 tier map. Replace with a dated qualification record before go-live.',
  },
  {
    id: 'azure-luna-6', provider: 'azure-openai', model: 'gpt-6-luna', label: 'GPT-6 Luna', region: null,
    processing: 'Azure OpenAI deployment on the company subscription.', status: 'unqualified',
    evidence: 'Listed in the Azure catalog. No deployment on the company subscription yet.',
  },
];

export interface SeedResult {
  seeded: boolean;
  password: string;
  accounts: typeof DEMO_ACCOUNTS;
  organizations: { juniper: string; harbor: string } | null;
}

/** Seed an empty store. A store that already has any account is left alone. */
export async function seedDemo(cloud: FauxCloud): Promise<SeedResult> {
  const snapshot = cloud.store.snapshot();
  if (snapshot.seeded !== null || snapshot.identity.users.length > 0 || snapshot.accounts.persons.length > 0)
    return { seeded: false, password: FAUX_DEMO_PASSWORD, accounts: DEMO_ACCOUNTS, organizations: null };
  const tokens = {} as Record<DemoAccount, string>;
  for (const [key, account] of Object.entries(DEMO_ACCOUNTS) as [DemoAccount, (typeof DEMO_ACCOUNTS)[DemoAccount]][]) {
    tokens[key] = await cloud.seedSignIn({ name: account.name, email: account.email, password: FAUX_DEMO_PASSWORD });
    await cloud.accounts.signIn(tokens[key]);
  }

  // Businesses, and people joining them by invitation code.
  const juniper = await cloud.accounts.createOrganization(tokens.owner, 'Juniper Street Bakery');
  const harbor = await cloud.accounts.createOrganization(tokens.harborOwner, 'Harbor Hardware');
  const week = 7 * 24 * 60 * 60 * 1000;
  const managerCode = await cloud.accounts.createInvitationCode(tokens.owner, juniper.id, { role: 'admin', email: DEMO_ACCOUNTS.manager.email, ttlMs: week });
  await cloud.accounts.redeemInvitationCode(tokens.manager, managerCode.code);
  // The Manager invites the Employee: a Manager may invite Employees.
  const employeeCode = await cloud.accounts.createInvitationCode(tokens.manager, juniper.id, { role: 'member', email: null, ttlMs: week });
  await cloud.accounts.redeemInvitationCode(tokens.employee, employeeCode.code);

  // The first admin is bootstrapped; everyone else is added by that admin.
  const adminSession = await cloud.accounts.signIn(tokens.staffAdmin);
  await bootstrapFirstAdmin(cloud.store.commercial, adminSession.person.id, new Date().toISOString());
  for (const [key, role] of [['staffSupport', 'support'], ['staffBilling', 'billing'], ['staffRouting', 'routing']] as const) {
    const session = await cloud.accounts.signIn(tokens[key]);
    await cloud.commercial.addStaff(tokens.staffAdmin, { personId: session.person.id, role });
  }

  // The route registry and the first policy, by the Routing role.
  for (const entry of DEMO_ROUTES) await cloud.commercial.saveRoute(tokens.staffRouting, entry);
  await cloud.commercial.publishPolicy(tokens.staffRouting, {
    // Managed inference (nectovia-managed/1): every tier runs on GPT-6 Luna. Reasoning effort
    // differs by tier on the desktop; the route does not.
    tiers: { efficient: 'aws-luna-6', focused: 'aws-luna-6', thorough: 'aws-luna-6' },
    note: 'Faux seed: GPT-6 Luna behind all three tiers, answered by the scripted provider (2026-09-25).',
    baseRevision: 0,
  });

  // Juniper Street Bakery holds Business; Harbor Hardware holds nothing yet.
  await cloud.commercial.issueGrant(tokens.staffBilling, juniper.id, {
    planId: 'business', source: 'internal-test', reference: 'Faux seed', note: 'Demo business with the Nectovia Agent included.',
  });

  await cloud.store.run(async (draft) => { draft.seeded = FAUX_SEED_ID; });
  return { seeded: true, password: FAUX_DEMO_PASSWORD, accounts: DEMO_ACCOUNTS, organizations: { juniper: juniper.id, harbor: harbor.id } };
}
