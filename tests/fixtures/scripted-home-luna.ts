import { AWS_LUNA_MODEL } from '../../server/engines/aws-bedrock';
import { scripted } from './scripted-conversation';
import { responsesEvents, sseResponse } from './model-api-streams.js';

// AWS Bedrock (Luna) answering by the same script the Claude fixture speaks, at the real
// provider boundary: the HTTPS call the model-API runtime makes. Everything above it is real:
// the Store, the Runtime, the interaction service, the model-session driver, the NativeAgent
// loop and both admissions. Nothing here reaches AWS or spends money.

export const AWS_TEST_KEY = 'test-only-bedrock-key-home-luna-never-real';
export const AWS_CONNECT_BODY = {
  accountId: '123456789012',
  region: 'us-east-1',
  model: AWS_LUNA_MODEL,
  apiKey: AWS_TEST_KEY,
  expiresAt: null,
  consent: true,
};

type Item = Record<string, unknown>;
export interface AwsCall {
  url: string;
  authorization: string | null;
  body: { input: Item[]; tools?: Item[]; store?: boolean; model?: string };
}
/** Every provider call, in order. */
export const seen: AwsCall[] = [];
/** True while a call the script told to hang is still on the wire. */
export const hang = { waiting: false };

const usage = {
  input_tokens: 1_400,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 220,
  output_tokens_details: { reasoning_tokens: 80 },
  total_tokens: 1_620,
};
const envelope = (output: Item[]) => ({
  id: `resp_${seen.length}`,
  object: 'response',
  created_at: 1_790_000_000,
  status: 'completed',
  model: AWS_LUNA_MODEL,
  output: [
    { type: 'reasoning', id: `rs_${seen.length}`, summary: [], encrypted_content: `enc-${seen.length}` },
    ...output,
  ],
  usage,
  incomplete_details: null,
  error: null,
});
const answer = (text: string): Item => ({
  type: 'message',
  id: `msg_${seen.length}`,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const userText = (body: AwsCall['body']) => {
  // The message this turn carries is the last user item: earlier items are this lineage's own
  // transcript, replayed for context, and answering one of those would answer a stale message.
  const user = body.input.filter((item) => item.role === 'user').at(-1);
  const content = user?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map((part) => String((part as Item).text ?? '')).join('')
    : '';
};

/**
 * The person's message is the last labelled block of the conversation prompt. `scripted` reads
 * the issued identity off its last line and answers like the Claude fixture does, so every
 * transcript assertion the page spec makes still holds. A message starting with SLOW hangs the
 * call the way a provider request still on the wire does.
 */
function respond(body: AwsCall['body']): Item[] | 'hang' {
  const text = userText(body);
  const message = text.split("The person's message:\n\n")[1] ?? text;
  if (message.split('\n\n[[diomedes')[0].startsWith('SLOW')) return 'hang';
  return [answer(scripted(message))];
}

/** The `modelApiTransport` `createApp` takes: the same shape as global fetch. */
export const awsTransport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headersIn = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body)) as AwsCall['body'];
  seen.push({ url: String(input), authorization: headersIn.get('authorization'), body });
  const output = respond(body);
  if (output === 'hang') {
    hang.waiting = true;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
        once: true,
      });
    });
  }
  return sseResponse(responsesEvents(envelope(output)), { 'x-amzn-requestid': `req-${seen.length}` });
}) as typeof globalThis.fetch;
