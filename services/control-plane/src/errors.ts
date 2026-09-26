/** Portable HTTP refusal. No platform imports and no credential-bearing causes. */
export class AccountError extends Error {
  readonly status: number;
  /**
   * A stable name for the refusal, sent beside the sentence so a client can tell it from other
   * refusals with the same status without reading the words (`not_a_member`). Most refusals have none.
   */
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
