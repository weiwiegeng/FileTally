import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 完整性检查 / 名单核对配置（可命名方案）
export interface IntegrityCheckConfig {
  id: string;
  name: string;
  targetFolder: string;
  templates: string[];
  namePattern: string;
  /** Excel match mode: exact | contains | startsWith */
  matchMode?: string;
  excelPath?: string;
  matchColumn?: number;
  kind?: 'integrity' | 'match';
  createdAt: number;
  updatedAt: number;
}

interface CheckConfigState {
  // 配置列表
  configs: IntegrityCheckConfig[];
  
  // 当前选中的配置 ID
  selectedConfigId: string | null;
  
  // 添加配置
  addConfig: (config: Omit<IntegrityCheckConfig, 'id' | 'createdAt' | 'updatedAt'>) => string;
  
  // 更新配置
  updateConfig: (id: string, config: Partial<Omit<IntegrityCheckConfig, 'id' | 'createdAt' | 'updatedAt'>>) => void;
  
  // 删除配置
  deleteConfig: (id: string) => void;
  
  // 选择配置
  selectConfig: (id: string | null) => void;
  
  // 获取当前选中的配置
  getSelectedConfig: () => IntegrityCheckConfig | null;
  
  // 根据 ID 获取配置
  getConfigById: (id: string) => IntegrityCheckConfig | undefined;
}

// 生成唯一 ID
const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

export const useCheckConfigStore = create<CheckConfigState>()(
  persist(
    (set, get) => ({
      configs: [],
      selectedConfigId: null,
      
      addConfig: (configData) => {
        const id = generateId();
        const now = Date.now();
        const newConfig: IntegrityCheckConfig = {
          ...configData,
          id,
          createdAt: now,
          updatedAt: now,
        };
        
        set((state) => ({
          configs: [...state.configs, newConfig],
        }));
        
        return id;
      },
      
      updateConfig: (id, configData) => {
        set((state) => ({
          configs: state.configs.map((config) =>
            config.id === id
              ? { ...config, ...configData, updatedAt: Date.now() }
              : config
          ),
        }));
      },
      
      deleteConfig: (id) => {
        set((state) => ({
          configs: state.configs.filter((config) => config.id !== id),
          selectedConfigId: state.selectedConfigId === id ? null : state.selectedConfigId,
        }));
      },
      
      selectConfig: (id) => {
        set({ selectedConfigId: id });
      },
      
      getSelectedConfig: () => {
        const state = get();
        if (!state.selectedConfigId) return null;
        return state.configs.find((c) => c.id === state.selectedConfigId) || null;
      },
      
      getConfigById: (id) => {
        return get().configs.find((c) => c.id === id);
      },
    }),
    {
      name: 'filetally-check-configs',
    }
  )
);
