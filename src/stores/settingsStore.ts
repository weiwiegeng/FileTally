import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// AI 模型提供商类型
export type AIProvider = 'openai' | 'claude' | 'ollama' | 'custom';

// AI 配置
export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  apiEndpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface AppSettings {
  // 通用设置
  language: 'zh-CN' | 'en-US';
  theme: 'dark' | 'light' | 'system';
  defaultPage: 'disk' | 'browser' | 'search' | 'remote';
  
  // 文件浏览设置
  showHiddenFiles: boolean;
  defaultExpandLevel: number;       // 默认展开层级
  sortBy: 'name' | 'size' | 'date' | 'type';
  sortOrder: 'asc' | 'desc';
  previewPanelPosition: 'right' | 'bottom';
  
  // 搜索设置
  defaultSearchContent: boolean;
  defaultSearchFilename: boolean;
  defaultCaseSensitive: boolean;
  maxPdfSizeMB: number;            // PDF 最大处理大小 (MB)
  searchTimeout: number;           // 搜索超时 (秒)
  
  // 性能设置
  maxConcurrentSearches: number;   // 最大并发搜索数
  enableSearchCache: boolean;
  
  // AI 设置
  aiConfig: AIConfig;
}

interface SettingsState {
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

const defaultSettings: AppSettings = {
  // 通用设置
  language: 'zh-CN',
  theme: 'dark',
  defaultPage: 'disk',
  
  // 文件浏览设置
  showHiddenFiles: false,
  defaultExpandLevel: 2,
  sortBy: 'name',
  sortOrder: 'asc',
  previewPanelPosition: 'right',
  
  // 搜索设置
  defaultSearchContent: true,
  defaultSearchFilename: true,
  defaultCaseSensitive: false,
  maxPdfSizeMB: 30,
  searchTimeout: 60,
  
  // 性能设置
  maxConcurrentSearches: 4,
  enableSearchCache: true,
  
  // AI 设置
  aiConfig: {
    provider: 'openai',
    apiKey: '',
    apiEndpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxTokens: 4096,
    temperature: 0.7,
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: defaultSettings,
      
      updateSettings: (updates) => {
        set((state) => ({
          settings: { ...state.settings, ...updates },
        }));
      },
      
      resetSettings: () => {
        set({ settings: defaultSettings });
      },
    }),
    {
      name: 'filetally-settings',
      // 处理旧版本数据迁移，确保新字段有默认值
      merge: (persistedState: any, currentState) => {
        const persisted = persistedState as SettingsState;
        return {
          ...currentState,
          settings: {
            ...defaultSettings,
            ...persisted?.settings,
            // 确保 aiConfig 存在且完整
            aiConfig: {
              ...defaultSettings.aiConfig,
              ...persisted?.settings?.aiConfig,
            },
          },
        };
      },
    }
  )
);
