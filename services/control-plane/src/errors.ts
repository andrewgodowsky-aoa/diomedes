/** Portable HTTP refusal. No platform imports and no credential-bearing causes. */
export class AccountError extends Error {
  readonly status: number;
  /**
   * A stable name for the refusal, sent beside the sentence so a client can tell it from other
   * refusals with the same status without reading the words (`not_a_member`). Most refusals have none.
   */
  readonly code?: string;
  /**
   * The request body fields the refusal names, as dotted paths (`binding.price.validUntil`), sent
   * beside the sentence so a form can mark each one. Only route saving names fields today.
   */
  readonly fields?: readonly string[];
  constructor(status: number, message: string, code?: string, fields?: readonly string[]) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}
