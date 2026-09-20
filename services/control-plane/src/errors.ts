/** Portable HTTP refusal. No platform imports and no credential-bearing causes. */
export class AccountError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
  }
}
