/**
 * What AI setup shows for the owner's Google Vertex AI route, computed from the
 * host's own view (`GET /api/ai/model-api/google-vertex`). Pure, so every
 * sentence here is testable without a browser.
 *
 * This route has no key. The computer's Google Application Default Credentials
 * are named, fingerprinted and checked by the host; the card shows where they
 * came from and whether they still match, never their contents. The owner's own
 * Google Cloud project pays, so the card says so plainly and keeps the gross
 * estimate, the expected promotion, confirmed credits, the customer debit and
 * the invoice apart.
 */
import type { VertexConnectionView } from '../shared/model-api';
import { usd } from './aws-bedrock-view';

/** Google's own rule, repeated only to say what is missing; the host decides. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface VertexStateRow {
  key: 'credential' | 'project' | 'price' | 'limit' | 'route';
  label: string;
  text: string;
  value: 'ok' | 'waiting' | 'blocked';
}

/** The five facts to check before sending, in the order they are set up. */
export function vertexStateRows(view: VertexConnectionView): VertexStateRow[] {
  const connection = view.connection;
  const spend = view.spend;
  const credential = connection?.credential ?? null;
  return [
    {
      key: 'credential',
      label: 'Google sign-in on this computer',
      text: !view.detected.adc
        ? 'None found: run gcloud auth application-default login'
        : credential
          ? credential.matches
            ? `Verified${credential.principal ? `: ${credential.principal}` : ''} (${credential.namedBy})`
            : 'Changed since it was verified: connect again'
          : `Found (${view.detected.namedBy ?? view.detected.source ?? 'default location'})${view.detected.quotaProject ? `, quota project ${view.detected.quotaProject}` : ', no quota project set'}`,
      value: !view.detected.adc ? 'waiting' : credential && !credential.matches ? 'blocked' : credential ? 'ok' : 'waiting',
    },
    {
      key: 'project',
      label: 'Billed project',
      text: connection ? `${connection.payer.projectId} · ${connection.model} · ${connection.location}` : 'Not connected',
      value: connection ? 'ok' : 'waiting',
    },
    {
      key: 'price',
      label: 'Price card',
      text: !connection
        ? 'Shown once connected'
        : connection.rateCard.stale
          ? (connection.rateCard.message ?? 'Needs re-checking against Google’s price page')
          : connection.rateCard.version,
      value: !connection ? 'waiting' : connection.rateCard.stale ? 'blocked' : 'ok',
    },
    {
      key: 'limit',
      label: 'Spend limit',
      text: !spend
        ? 'Not set'
        : spend.capMicroUsd === 0
          ? 'Not approved: nothing can be sent'
          : `${usd(spend.capMicroUsd)} approved, ${usd(spend.availableMicroUsd)} left`,
      value: !spend || spend.capMicroUsd === 0 ? 'waiting' : spend.availableMicroUsd > 0 ? 'ok' : 'blocked',
    },
    {
      key: 'route',
      label: 'Route',
      text: view.enabled ? 'On' : 'Off',
      value: view.enabled ? 'ok' : 'waiting',
    },
  ];
}

export interface VertexConnectInput {
  projectId: string;
  consent: boolean;
}

export type VertexConnectBody = { projectId: string; location: 'global'; model: 'gemini-3.8-flash'; consent: true };

/** The exact body the host accepts. Location and model are fixed: there is nothing else to choose. */
export function vertexConnectBody(input: VertexConnectInput): { ok: true; body: VertexConnectBody } | { ok: false; message: string } {
  const projectId = input.projectId.trim();
  if (!projectId) return { ok: false, message: 'Enter the Google Cloud project id that pays for these calls.' };
  if (!PROJECT.test(projectId))
    return { ok: false, message: 'A project id is 6 to 30 lowercase letters, digits and hyphens, starting with a letter.' };
  if (!input.consent) return { ok: false, message: 'Confirm that this project, and no other, is billed for every call.' };
  return { ok: true, body: { projectId, location: 'global', model: 'gemini-3.8-flash', consent: true } };
}

export interface VertexMoneyLine {
  key: 'payer' | 'gross' | 'unresolved' | 'promotion' | 'credits' | 'debit' | 'invoice';
  label: string;
  text: string;
}

/** Five cost figures, each labelled for what it is. Nothing here nets one against another. */
export function vertexMoneyLines(view: VertexConnectionView): VertexMoneyLine[] {
  const a = view.accounting;
  if (!a) return [];
  return [
    { key: 'payer', label: 'Paid by', text: `Your Google Cloud project ${a.payer.projectId}, not Nectovia credits` },
    { key: 'gross', label: 'Estimated cost, settled calls', text: `${usd(a.grossEstimateMicroUsd)} at Google’s standard rate` },
    {
      key: 'unresolved',
      label: 'Calls not yet settled',
      text: a.unresolvedEstimateMicroUsd > 0 ? `up to ${usd(a.unresolvedEstimateMicroUsd)} held` : 'none',
    },
    {
      key: 'promotion',
      label: 'Expected promotion',
      text: `${usd(a.expectedPromotion.expectedMicroUsd)} may come back as credit (${a.expectedPromotion.percent}% of net spend through ${a.expectedPromotion.appliesThrough}). Unconfirmed; may not apply on top of a free-trial credit.`,
    },
    { key: 'credits', label: 'Credits Google applied', text: `Not known here: see ${a.confirmedCredits.where}` },
    { key: 'debit', label: 'Nectovia credits used', text: usd(a.customerDebitMicroUsd) },
    { key: 'invoice', label: 'Invoice', text: `Google’s, not Nectovia’s: see ${a.invoice.where}` },
  ];
}
