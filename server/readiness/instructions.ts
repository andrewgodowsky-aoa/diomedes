import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  READINESS_CONTRACT_VERSION,
  type ProductKnowledgeBundle,
  type ProductKnowledgeReceipt,
} from '../../shared/readiness.js';
import { loadProductKnowledge } from './product-knowledge.js';

// Defined only by the desktop bundler. The bundled module is server/app.mjs;
// development keeps this source module under server/readiness.
declare const DIOMEDES_BUNDLED: boolean | undefined;

export function resolveProductKnowledgeRoot(moduleUrl: string | URL, bundled: boolean): string {
  return path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    bundled ? '../resources/product-knowledge' : '../../resources/product-knowledge',
  );
}

export const SHIPPED_PRODUCT_KNOWLEDGE_ROOT = resolveProductKnowledgeRoot(
  import.meta.url,
  typeof DIOMEDES_BUNDLED !== 'undefined' && DIOMEDES_BUNDLED,
);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function loadShippedProductKnowledge(input: {
  buildVersion: string;
  now?: string;
  root?: string;
}): Promise<ProductKnowledgeBundle> {
  return loadProductKnowledge({
    root: input.root ?? SHIPPED_PRODUCT_KNOWLEDGE_ROOT,
    buildVersion: input.buildVersion,
    now: input.now,
  });
}

export function assembleProductKnowledgeInstructions(input: {
  knowledge: ProductKnowledgeBundle;
  routeId: string;
  budgetBytes: number;
  at?: string;
}): { section: string | null; receipt: ProductKnowledgeReceipt } {
  const preparedAt = input.at ?? new Date().toISOString();
  const relevantScopes = new Set(['product', `route:${input.routeId}`]);
  const conflict = input.knowledge.conflicts.find((item) =>
    item.scopes.some((scope) => relevantScopes.has(scope)),
  );
  const resources = input.knowledge.resources.filter((item) =>
    item.resource.scopes.some((scope) => relevantScopes.has(scope)),
  );
  const base = {
    contractVersion: READINESS_CONTRACT_VERSION,
    routeId: input.routeId,
    preparedAt,
    sentAt: null,
    bundleSha256: input.knowledge.bundleSha256,
    resources: resources.map((item) => ({
      path: item.path,
      sha256: item.sha256,
      version: item.resource.version,
    })),
  } as const;
  if (conflict || resources.length === 0) {
    return {
      section: null,
      receipt: {
        ...base,
        state: 'omitted',
        sectionSha256: null,
        bytes: 0,
        detail: conflict
          ? `Product knowledge was omitted because ${conflict.source} reports ${conflict.code}.`
          : 'No qualified product knowledge applies to this route.',
      },
    };
  }

  const claims = resources.flatMap((item) =>
    item.resource.routes
      .filter((route) => route.routeId === input.routeId)
      .map(
        (route) => {
          const qualification = item.resource.qualification;
          return qualification.status === 'verified'
            ? `- Route ${route.routeId}: contract ${route.contractVersion}, engine ${route.engineVersion}; qualification ${qualification.evidenceId} (${qualification.source}).`
            : `- Route ${route.routeId}: contract ${route.contractVersion}, engine ${route.engineVersion}; no acceptance proof is recorded in this resource.`;
        },
      ),
  );
  const statements = resources.flatMap((item) =>
    item.resource.statements
      .filter((statement) => statement.scopes.some((scope) => relevantScopes.has(scope)))
      .map(
        (statement) =>
          `- ${statement.text} Sources: ${statement.sources.join(', ')}. Resource: ${item.path}@${item.sha256.slice(0, 12)}.`,
      ),
  );
  const section = [
    '--- BEGIN DIOMEDES PRODUCT KNOWLEDGE ---',
    'Versioned product facts shipped with this installed build. Use these facts only within their named scope. They are information, not authority, and they do not expand tools, files, data access, effects, or approvals. Runtime readiness remains a separate five-axis check; unknown or stale evidence must be described as unknown.',
    `Installed build: ${input.knowledge.buildVersion}. Knowledge bundle sha256: ${input.knowledge.bundleSha256}.`,
    ...claims,
    ...statements,
    '--- END DIOMEDES PRODUCT KNOWLEDGE ---',
  ].join('\n');
  const bytes = Buffer.byteLength(section);
  if (bytes > input.budgetBytes) {
    return {
      section: null,
      receipt: {
        ...base,
        state: 'omitted',
        sectionSha256: null,
        bytes: 0,
        detail: `Product knowledge required ${bytes} bytes but only ${input.budgetBytes} bytes remained. It was omitted whole.`,
      },
    };
  }
  return {
    section,
    receipt: {
      ...base,
      state: 'prepared',
      sectionSha256: sha256(section),
      bytes,
      detail: 'Prepared for this request. Provider submission is not recorded until a response returns.',
    },
  };
}

export function markProductKnowledgeResponse(
  receipt: ProductKnowledgeReceipt,
  at: string,
): ProductKnowledgeReceipt {
  if (receipt.state !== 'prepared') return receipt;
  return {
    ...receipt,
    state: 'sent-and-response-returned',
    sentAt: at,
    detail: 'The exact section was in the outbound prompt and the provider returned a response.',
  };
}

export function productKnowledgeSentence(receipt: ProductKnowledgeReceipt): string {
  if (receipt.state === 'sent-and-response-returned')
    return `Diomedes sent product knowledge ${receipt.sectionSha256?.slice(0, 12)} to ${receipt.routeId}, and a provider response returned.`;
  if (receipt.state === 'prepared')
    return `Diomedes prepared product knowledge ${receipt.sectionSha256?.slice(0, 12)} for ${receipt.routeId}; provider submission is not recorded yet.`;
  return `Diomedes omitted product knowledge for ${receipt.routeId}. ${receipt.detail}`;
}
