import { AIConfig, AIProvider } from '../stores/settingsStore';
import i18n from '../i18n';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// OpenAI 兼容格式的请求
interface OpenAIRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

// Claude 格式的请求
interface ClaudeRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature?: number;
}

// Ollama 格式的请求
interface OllamaRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

export class AIService {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  // 更新配置
  updateConfig(config: AIConfig) {
    this.config = config;
  }

  // 发送聊天请求
  async chat(messages: ChatMessage[]): Promise<AIResponse> {
    switch (this.config.provider) {
      case 'openai':
      case 'custom':
        return this.chatOpenAI(messages);
      case 'claude':
        return this.chatClaude(messages);
      case 'ollama':
        return this.chatOllama(messages);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  // OpenAI API 调用
  private async chatOpenAI(messages: ChatMessage[]): Promise<AIResponse> {
    const request: OpenAIRequest = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: false,
    };

    const response = await fetch(`${this.config.apiEndpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0]?.message?.content || '',
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  // Claude API 调用
  private async chatClaude(messages: ChatMessage[]): Promise<AIResponse> {
    // 分离 system 消息
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const request: ClaudeRequest = {
      model: this.config.model,
      messages: chatMessages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };

    const body: any = request;
    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await fetch(`${this.config.apiEndpoint}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      content: data.content[0]?.text || '',
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
    };
  }

  // Ollama API 调用
  private async chatOllama(messages: ChatMessage[]): Promise<AIResponse> {
    const request: OllamaRequest = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: this.config.temperature,
        num_predict: this.config.maxTokens,
      },
    };

    const response = await fetch(`${this.config.apiEndpoint}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      content: data.message?.content || '',
      usage: data.eval_count ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      } : undefined,
    };
  }

  // 生成文档摘要
  async summarizeDocument(content: string, fileName: string): Promise<string> {
    const truncated =
      content.slice(0, 15000) +
      (content.length > 15000 ? i18n.t('ai.prompts.contentTruncated') : '');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: i18n.t('ai.prompts.summarizeSystem'),
      },
      {
        role: 'user',
        content: i18n.t('ai.prompts.summarizeUser', {
          fileName,
          content: truncated,
        }),
      },
    ];

    const response = await this.chat(messages);
    return response.content;
  }

  // 回答关于文档的问题
  async askAboutDocument(content: string, fileName: string, question: string): Promise<string> {
    const truncated =
      content.slice(0, 15000) +
      (content.length > 15000 ? i18n.t('ai.prompts.contentTruncated') : '');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: i18n.t('ai.prompts.askSystem'),
      },
      {
        role: 'user',
        content: i18n.t('ai.prompts.askUser', {
          fileName,
          content: truncated,
          question,
        }),
      },
    ];

    const response = await this.chat(messages);
    return response.content;
  }
}

// 单例实例
let aiServiceInstance: AIService | null = null;

export const getAIService = (config: AIConfig): AIService => {
  if (!aiServiceInstance) {
    aiServiceInstance = new AIService(config);
  } else {
    aiServiceInstance.updateConfig(config);
  }
  return aiServiceInstance;
};
