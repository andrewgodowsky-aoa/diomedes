// Tool names and mailbox semantics follow iOfficeAI/AionCore v0.2.1 crates/aionui-team (Apache-2.0); reimplemented for Diomedes.
import { identifier, now } from '../store.js';
import type { MailboxMessage, Slot } from '../../shared/types.js';

export interface SendMailboxInput {
  to: Slot;
  from: Slot;
  type: MailboxMessage['type'];
  content: string;
  summary?: string;
  files?: string[];
  threadId: string | null;
  runId?: string | null;
  approvalId?: string | null;
}

export function deliverMessage(messages: MailboxMessage[], input: SendMailboxInput): MailboxMessage {
  const message: MailboxMessage = {
    id: identifier('M'),
    to: input.to,
    from: input.from,
    type: input.type,
    content: input.content,
    summary: input.summary,
    files: input.files,
    read: false,
    createdAt: now(),
    threadId: input.threadId,
    runId: input.runId ?? null,
    approvalId: input.approvalId ?? null,
  };
  messages.push(message);
  return message;
}

export function unreadForSlot(messages: MailboxMessage[], slotId: Slot): MailboxMessage[] {
  return messages.filter((m) => m.to === slotId && !m.read);
}

export function peekForSlot(
  messages: MailboxMessage[],
  slotId: Slot,
  sinceMessageId?: string,
): MailboxMessage[] {
  const owned = messages.filter((m) => m.to === slotId);
  if (!sinceMessageId) return [...owned];
  const index = owned.findIndex((m) => m.id === sinceMessageId);
  if (index === -1) return [...owned];
  return owned.slice(index + 1);
}

export function acknowledge(messages: MailboxMessage[], ids: string[]): void {
  const wanted = new Set(ids);
  for (const message of messages) {
    if (wanted.has(message.id)) message.read = true;
  }
}

export function hasPendingShutdown(messages: MailboxMessage[], slotId: Slot): boolean {
  return messages.some(
    (m) => m.to === slotId && m.type === 'shutdown_request' && !m.read,
  );
}
