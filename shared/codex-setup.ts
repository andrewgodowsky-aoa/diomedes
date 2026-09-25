import type { IntegrationStatus } from './types';

export interface CodexSetupView {
  supported: boolean;
  installed: boolean;
  login: 'idle' | 'waiting' | 'finished' | 'cancelled' | 'failed';
  authUrl: string | null;
  detail: string;
  integration: IntegrationStatus | null;
}
