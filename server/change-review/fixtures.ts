/**
 * The two Business demonstration fixtures.
 *
 * Both run through the same `compareStructured` differ, the same rules, the
 * same renderer and the same manifest contract as every other change — that is
 * the point of the demonstration: one mechanism, two domains, no domain logic
 * in Core.
 *
 * Field descriptors carry the human labels and the attention codes a field
 * raises when it moves. Nothing here is restaurant-shaped; a different
 * business names different labels and reuses everything else.
 */

import type { StructuredField, StructuredRecord } from './structured.js';

export interface BusinessExample {
  readonly id: string;
  readonly title: string;
  readonly record: StructuredRecord;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

const restaurantFields: readonly StructuredField[] = [
  { path: 'schedule', label: 'Schedule', kind: 'value' },
  { path: 'recipients', label: 'Recipients', kind: 'list', flagCodes: ['recipient-list-changed'] },
  { path: 'dataSources', label: 'Data sources', kind: 'list', flagCodes: ['connector-changed'] },
  {
    path: 'permissions',
    label: 'Who can see it',
    kind: 'set',
    flagCodes: ['permission-set-changed'],
  },
];

const automationFields: readonly StructuredField[] = [
  { path: 'trigger', label: 'When it runs', kind: 'value' },
  { path: 'destination', label: 'Where it goes', kind: 'value', flagCodes: ['connector-changed'] },
  { path: 'enabled', label: 'Enabled', kind: 'value', flagCodes: ['automation-toggled'] },
  {
    path: 'access',
    label: 'Who can change it',
    kind: 'set',
    flagCodes: ['permission-set-changed'],
  },
  { path: 'threshold', label: 'Only above', kind: 'value' },
  {
    path: 'apiKey',
    label: 'Service key',
    kind: 'value',
    flagCodes: ['credential-changed'],
    sensitive: true,
  },
];

export const RESTAURANT_WEEKLY_REPORT: BusinessExample = {
  id: 'restaurant-weekly-report',
  title: 'Restaurant weekly operations report',
  record: {
    id: 'weekly-operations-report',
    label: 'Weekly operations report',
    fields: restaurantFields,
    values: {},
  },
  before: {
    schedule: 'Monday 7:00 AM',
    recipients: ['Owner', 'Kitchen Manager', 'Bar Manager'],
    dataSources: ['POS sales', 'Inventory counts'],
    permissions: ['Owner', 'General Manager'],
  },
  after: {
    schedule: 'Monday 6:00 AM',
    recipients: ['Owner', 'Kitchen Manager', 'Bar Manager', 'General Manager'],
    dataSources: ['POS sales', 'Inventory counts', 'Waste log'],
    permissions: ['Owner', 'General Manager', 'Assistant Manager'],
  },
};

export const AUTOMATION_INVOICE_REMINDER: BusinessExample = {
  id: 'automation-invoice-reminder',
  title: 'Small-business invoice reminder automation',
  record: {
    id: 'invoice-reminder',
    label: 'Invoice reminder automation',
    fields: automationFields,
    values: {},
  },
  before: {
    trigger: 'Mondays at 9:00 AM',
    destination: 'Email to office@northpeak.example',
    enabled: true,
    access: ['Owner', 'Accountant'],
    threshold: '$500',
    apiKey: 'nk-live-9f2e7c41b8aa',
  },
  after: {
    trigger: 'Every day at 8:00 AM',
    destination: 'Slack channel #billing',
    enabled: false,
    access: ['Owner', 'Accountant', 'Office Manager'],
    threshold: '$1,000',
    apiKey: 'nk-live-d310c6f41e92',
  },
};

export const BUSINESS_EXAMPLES: readonly BusinessExample[] = [
  RESTAURANT_WEEKLY_REPORT,
  AUTOMATION_INVOICE_REMINDER,
];

export function businessExample(id: string): BusinessExample | null {
  return BUSINESS_EXAMPLES.find((example) => example.id === id) ?? null;
}
