import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface SearchMatch {
  lineNumber: number;
  content: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResult {
  filePath: string;
  fileName: string;
  fileType: string;
  matches: SearchMatch[];
  matchCount: number;
}

export interface UnmatchedFile {
  filePath: string;
  fileName: string;
  fileType: string;
}

export interface SearchResponse {
  matched: SearchResult[];
  unmatched: UnmatchedFile[];
  totalScanned: number;
}

// 多关键词检查结果
export interface KeywordCheckResult {
  filePath: string;
  fileName: string;
  fileType: string;
  missingKeywords: string[];
}

export interface KeywordCheckResponse {
  results: KeywordCheckResult[];
  totalScanned: number;
  totalWithMissing: number;
  keywords: string[];
}

export interface SearchOptions {
  search_content: boolean;      // 是否搜索文件内容
  search_filename: boolean;     // 是否搜索文件名
  case_sensitive: boolean;      // 区分大小写
  include_hidden: boolean;      // 包含隐藏文件
  file_extensions?: string[];   // 文件扩展名过滤
  max_pdf_size_mb?: number;     // PDF 最大处理大小 (MB)
}

export type SearchMode = 'normal' | 'keyword-check';

interface SearchState {
  // 状态
  mode: SearchMode;
  query: string;
  results: SearchResult[];
  unmatchedFiles: UnmatchedFile[];
  loading: boolean;
  error: string | null;
  searchPath: string | null;
  options: SearchOptions;
  
  // 多关键词检查结果
  keywordCheckResults: KeywordCheckResult[];
  keywordCheckKeywords: string[];
  
  // 统计
  totalScanned: number;
  matchedFiles: number;
  unmatchedCount: number;
  totalMatches: number;
  
  // Actions
  setMode: (mode: SearchMode) => void;
  setQuery: (query: string) => void;
  setSearchPath: (path: string) => void;
  setOptions: (options: Partial<SearchOptions>) => void;
  search: () => Promise<void>;
  checkKeywords: () => Promise<void>;
  clearResults: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  // 初始状态
  mode: 'normal',
  query: '',
  results: [],
  unmatchedFiles: [],
  loading: false,
  error: null,
  searchPath: null,
  options: {
    search_content: true,
    search_filename: true,
    case_sensitive: false,
    include_hidden: false,
    file_extensions: undefined,
    max_pdf_size_mb: 30,
  },
  
  keywordCheckResults: [],
  keywordCheckKeywords: [],
  
  totalScanned: 0,
  matchedFiles: 0,
  unmatchedCount: 0,
  totalMatches: 0,
  
  setMode: (mode) => set({ 
    mode,
    // 切换模式时清空结果
    results: [],
    unmatchedFiles: [],
    keywordCheckResults: [],
    keywordCheckKeywords: [],
    error: null,
    totalScanned: 0,
    matchedFiles: 0,
    unmatchedCount: 0,
    totalMatches: 0,
  }),
  
  setQuery: (query) => set({ query }),
  
  setSearchPath: (path) => set({ searchPath: path }),
  
  setOptions: (newOptions) => set((state) => ({
    options: { ...state.options, ...newOptions }
  })),
  
  search: async () => {
    const { query, searchPath, options } = get();
    
    if (!query.trim() || !searchPath) {
      set({ error: '请输入搜索关键词并选择搜索目录' });
      return;
    }
    
    set({ loading: true, error: null, results: [], unmatchedFiles: [] });
    
    try {
      const response = await invoke<SearchResponse>('search_files', {
        path: searchPath,
        query: query.trim(),
        options,
      });
      
      const totalMatches = response.matched.reduce((sum, r) => sum + r.matchCount, 0);
      
      set({
        results: response.matched,
        unmatchedFiles: response.unmatched,
        loading: false,
        totalScanned: response.totalScanned,
        matchedFiles: response.matched.length,
        unmatchedCount: response.unmatched.length,
        totalMatches,
      });
    } catch (err) {
      set({
        error: String(err),
        loading: false,
      });
    }
  },
  
  checkKeywords: async () => {
    const { query, searchPath, options } = get();
    
    if (!query.trim() || !searchPath) {
      set({ error: '请输入关键词并选择搜索目录' });
      return;
    }
    
    // 解析关键词（逗号分隔）
    const keywords = query.split(/[,，]/).map(k => k.trim()).filter(k => k.length > 0);
    
    if (keywords.length === 0) {
      set({ error: '请输入至少一个关键词' });
      return;
    }
    
    set({ loading: true, error: null, keywordCheckResults: [], keywordCheckKeywords: [] });
    
    try {
      const response = await invoke<KeywordCheckResponse>('check_keywords', {
        path: searchPath,
        keywords,
        options,
      });
      
      set({
        keywordCheckResults: response.results,
        keywordCheckKeywords: response.keywords,
        loading: false,
        totalScanned: response.totalScanned,
        unmatchedCount: response.totalWithMissing,
        matchedFiles: response.totalScanned - response.totalWithMissing,
        totalMatches: 0,
      });
    } catch (err) {
      set({
        error: String(err),
        loading: false,
      });
    }
  },
  
  clearResults: () => set({
    results: [],
    unmatchedFiles: [],
    keywordCheckResults: [],
    keywordCheckKeywords: [],
    error: null,
    totalScanned: 0,
    matchedFiles: 0,
    unmatchedCount: 0,
    totalMatches: 0,
  }),
}));
