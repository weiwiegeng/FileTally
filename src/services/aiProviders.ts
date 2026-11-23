import type { AICapability, AIProvider } from '../stores/settingsStore';

export interface AIModelOption {
  value: string;
  label: string;
  capability?: AICapability;
}

export interface AIProviderPreset {
  id: AIProvider;
  /** i18n key under settings.*, or literal label if starts without settings. */
  labelKey?: string;
  label?: string;
  defaultEndpoint: string;
  models: AIModelOption[];
  /** Protocol used by aiService */
  protocol: 'openai' | 'claude' | 'ollama';
}

/** Catalog of built-in providers (OpenAI-compatible CN clouds + majors). */
export const AI_PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1',
    protocol: 'openai',
    models: [
      { value: 'gpt-4o', label: 'GPT-4o', capability: 'multimodal' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini', capability: 'multimodal' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', capability: 'multimodal' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', capability: 'text' },
    ],
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    defaultEndpoint: 'https://api.anthropic.com',
    protocol: 'claude',
    models: [
      { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', capability: 'multimodal' },
      { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus', capability: 'multimodal' },
      { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku', capability: 'multimodal' },
    ],
  },
  {
    id: 'deepseek',
    labelKey: 'settings.providerDeepseek',
    defaultEndpoint: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat', capability: 'text' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', capability: 'text' },
    ],
  },
  {
    id: 'zhipu',
    labelKey: 'settings.providerZhipu',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [
      { value: 'glm-4-plus', label: 'GLM-4 Plus', capability: 'text' },
      { value: 'glm-4-flash', label: 'GLM-4 Flash', capability: 'text' },
      { value: 'glm-4v-plus', label: 'GLM-4V Plus', capability: 'vision' },
    ],
  },
  {
    id: 'qwen',
    labelKey: 'settings.providerQwen',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    models: [
      { value: 'qwen-plus', label: 'Qwen Plus', capability: 'text' },
      { value: 'qwen-turbo', label: 'Qwen Turbo', capability: 'text' },
      { value: 'qwen-max', label: 'Qwen Max', capability: 'text' },
      { value: 'qwen-vl-plus', label: 'Qwen-VL Plus', capability: 'vision' },
    ],
  },
  {
    id: 'kimi',
    labelKey: 'settings.providerKimi',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    models: [
      { value: 'moonshot-v1-8k', label: 'Moonshot v1 8K', capability: 'text' },
      { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K', capability: 'text' },
      { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K', capability: 'text' },
      { value: 'moonshot-v1-8k-vision-preview', label: 'Moonshot Vision', capability: 'vision' },
    ],
  },
  {
    id: 'hunyuan',
    labelKey: 'settings.providerHunyuan',
    defaultEndpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    protocol: 'openai',
    models: [
      { value: 'hunyuan-lite', label: 'Hunyuan Lite', capability: 'text' },
      { value: 'hunyuan-standard', label: 'Hunyuan Standard', capability: 'text' },
      { value: 'hunyuan-pro', label: 'Hunyuan Pro', capability: 'text' },
      { value: 'hunyuan-vision', label: 'Hunyuan Vision', capability: 'vision' },
    ],
  },
  {
    id: 'ollama',
    labelKey: 'settings.providerOllamaLocal',
    defaultEndpoint: 'http://localhost:11434',
    protocol: 'ollama',
    models: [
      { value: 'llama3.2', label: 'Llama 3.2', capability: 'text' },
      { value: 'qwen2.5', label: 'Qwen 2.5', capability: 'text' },
      { value: 'mistral', label: 'Mistral', capability: 'text' },
      { value: 'llava', label: 'LLaVA', capability: 'vision' },
      { value: 'deepseek-coder', label: 'DeepSeek Coder', capability: 'text' },
    ],
  },
  {
    id: 'custom',
    labelKey: 'settings.providerCustom',
    defaultEndpoint: '',
    protocol: 'openai',
    models: [],
  },
];

export function getProviderPreset(provider: AIProvider): AIProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === provider);
}

export function getDefaultEndpoint(provider: AIProvider): string {
  return getProviderPreset(provider)?.defaultEndpoint || '';
}

export function getModelOptions(provider: AIProvider): AIModelOption[] {
  return getProviderPreset(provider)?.models || [];
}

export function getProviderProtocol(provider: AIProvider): 'openai' | 'claude' | 'ollama' {
  return getProviderPreset(provider)?.protocol || 'openai';
}

export function inferCapability(
  provider: AIProvider,
  model: string,
  fallback: AICapability = 'text'
): AICapability {
  const hit = getModelOptions(provider).find((m) => m.value === model);
  if (hit?.capability) return hit.capability;

  const lower = model.toLowerCase();
  if (
    lower.includes('vision') ||
    lower.includes('-vl') ||
    lower.includes('4v') ||
    lower.includes('gpt-4o') ||
    lower.includes('llava')
  ) {
    return lower.includes('gpt-4o') || lower.includes('claude') ? 'multimodal' : 'vision';
  }
  return fallback;
}

export function capabilitySupportsVision(capability: AICapability): boolean {
  return capability === 'vision' || capability === 'multimodal';
}
