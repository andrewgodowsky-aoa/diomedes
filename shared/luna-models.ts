/**
 * One table from each served Luna model id to the names people see. Every Luna label and
 * capability name reads from here, so a route never shows one model while sending another.
 * Adding a model id here is the only way to give it a label.
 */
export const LUNA_MODELS = {
  'us.openai.gpt-5.6-luna': { label: 'GPT-5.6 Luna', capabilityName: 'AWS Bedrock, GPT-5.6 Luna, company AWS account' },
  'us.openai.gpt-6-luna': { label: 'GPT-6 Luna', capabilityName: 'AWS Bedrock, GPT-6 Luna, company AWS account' },
  'gpt-6-luna': { label: 'GPT-6 Luna', capabilityName: 'Azure OpenAI, GPT-6 Luna' },
} as const;

export type LunaModelId = keyof typeof LUNA_MODELS;

export const lunaLabel = (model: LunaModelId): string => LUNA_MODELS[model].label;
export const lunaCapabilityName = (model: LunaModelId): string => LUNA_MODELS[model].capabilityName;
