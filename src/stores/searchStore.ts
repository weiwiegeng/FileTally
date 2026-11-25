import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { useSettingsStore } from './settingsStore';
import { mapBackendError } from '../utils/backendError';
import { makeTaskId, useTaskStore } from './taskStore';
import { cancelJob as cancelBackendJob, prepareJob } from '../utils/jobs';

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
  cancelled?: boolean;
  truncated?: boolean;
}

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
  cancelled?: boolean;
  truncated?: boolean;
}

export interface SearchOptions {
  search_content: boolean;
  search_filename: boolean;
  case_sensitive: boolean;
  include_hidden: boolean;
  file_extensions?: string[];
  max_pdf_size_mb?: number;
  max_text_size_mb?: number;
  max_concurrency?: number;
}

export type SearchMode = 'normal' | 'keyword-check';
export type SearchStatusKind = 'none' | 'error' | 'cancelled' | 'timeout' | 'truncated';

interface SearchState {
  mode: SearchMode;
  query: string;
  results: SearchResult[];
  unmatchedFiles: UnmatchedFile[];
  loading: boolean;
  error: string | null;
  statusKind: SearchStatusKind;
  searchPaths: string[];
  options: SearchOptions;
  requestId: number;
  truncated: boolean;

  keywordCheckResults: KeywordCheckResult[];
  keywordCheckKeywords: string[];

  totalScanned: number;
  matchedFiles: number;
  unmatchedCount: number;
  totalMatches: number;

  setMode: (mode: SearchMode) => void;
  setQuery: (query: string) => void;
  setSearchPaths: (paths: string[]) => void;
  addSearchPath: (path: string) => void;
  removeSearchPath: (path: string) => void;
  setOptions: (options: Partial<SearchOptions>) => void;
  syncOptionsFromSettings: () => void;
  search: () => Promise<void>;
  checkKeywords: () => Promise<void>;
  cancelSearch: () => Promise<void>;
  clearResults: () => void;
}

const SEARCH_CACHE_KEY = 'filetally-search-cache';

/** Module-level timer so overlapping runs / cancel can't leave stale timeouts. */
let activeTimeoutId: number | null = null;
let activeTimeoutRequestId = 0;
/** Backend job id for the in-flight search; timeouts cancel only this id. */
let activeSearchJobId = 0;

const clearActiveTimeout = () => {
  if (activeTimeoutId != null) {
    window.clearTimeout(activeTimeoutId);
    activeTimeoutId = null;
  }
};

const cancelSearchBackend = async (jobId: number) => {
  if (jobId <= 0) return;
  try {
    await cancelBackendJob(jobId, 'search');
  } catch {
    // ignore
  }
};

const optionsFromSettings = (): SearchOptions => {
  const { settings } = useSettingsStore.getState();
  return {
    search_content: settings.defaultSearchContent,
    search_filename: settings.defaultSearchFilename,
    case_sensitive: settings.defaultCaseSensitive,
    include_hidden: settings.showHiddenFiles,
    file_extensions: undefined,
    max_pdf_size_mb: settings.maxPdfSizeMB,
    max_text_size_mb: settings.maxTextSizeMB,
    max_concurrency: settings.maxConcurrentSearches,
  };
};

const buildOptionsWithSettings = (options: SearchOptions): SearchOptions => {
  const { settings } = useSettingsStore.getState();
  return {
    ...options,
    max_pdf_size_mb: options.max_pdf_size_mb ?? settings.maxPdfSizeMB,
    max_text_size_mb: options.max_text_size_mb ?? settings.maxTextSizeMB,
    max_concurrency: options.max_concurrency ?? settings.maxConcurrentSearches,
  };
};

const truncatedHint = (truncated?: boolean) =>
  truncated ? ` ${i18n.t('search.store.truncatedHint')}` : '';

const readCache = (key: string): SearchResponse | null => {
  try {
    const raw = localStorage.getItem(SEARCH_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { ts: number; data: SearchResponse }>;
    const hit = map[key];
    if (!hit) return null;
    // Keep cache short so deletes/renames don't linger as false hits.
    if (Date.now() - hit.ts > 60 * 1000) return null;
    return hit.data;
  } catch {
    return null;
  }
};

const writeCache = (key: string, data: SearchResponse) => {
  try {
    const raw = localStorage.getItem(SEARCH_CACHE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[key] = { ts: Date.now(), data };
    const keys = Object.keys(map);
    if (keys.length > 30) {
      keys
        .sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
        .slice(0, keys.length - 30)
        .forEach((k) => delete map[k]);
    }
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
};

export const useSearchStore = create<SearchState>((set, get) => ({
  mode: 'normal',
  query: '',
  results: [],
  unmatchedFiles: [],
  loading: false,
  error: null,
  statusKind: 'none',
  searchPaths: [],
  options: optionsFromSettings(),
  requestId: 0,
  truncated: false,

  keywordCheckResults: [],
  keywordCheckKeywords: [],

  totalScanned: 0,
  matchedFiles: 0,
  unmatchedCount: 0,
  totalMatches: 0,

  setMode: (mode) => set({
    mode,
    results: [],
    unmatchedFiles: [],
    keywordCheckResults: [],
    keywordCheckKeywords: [],
    error: null,
    statusKind: 'none',
    truncated: false,
    totalScanned: 0,
    matchedFiles: 0,
    unmatchedCount: 0,
    totalMatches: 0,
  }),

  setQuery: (query) => set({ query }),

  setSearchPaths: (paths) => set({ searchPaths: paths }),

  addSearchPath: (path) => set((state) => ({
    searchPaths: state.searchPaths.includes(path)
      ? state.searchPaths
      : [...state.searchPaths, path],
  })),

  removeSearchPath: (path) => set((state) => ({
    searchPaths: state.searchPaths.filter((p) => p !== path),
  })),

  setOptions: (newOptions) => set((state) => ({
    options: { ...state.options, ...newOptions },
  })),

  syncOptionsFromSettings: () => {
    const fromSettings = optionsFromSettings();
    set((state) => ({
      options: {
        ...state.options,
        search_content: fromSettings.search_content,
        search_filename: fromSettings.search_filename,
        case_sensitive: fromSettings.case_sensitive,
        include_hidden: fromSettings.include_hidden,
        max_pdf_size_mb: fromSettings.max_pdf_size_mb,
        max_text_size_mb: fromSettings.max_text_size_mb,
        max_concurrency: fromSettings.max_concurrency,
      },
    }));
  },

  search: async () => {
    const { query, searchPaths, options } = get();

    if (!query.trim() || searchPaths.length === 0) {
      set({ error: i18n.t('search.store.needQueryAndPath'), statusKind: 'error' });
      return;
    }

    clearActiveTimeout();
    const prevJobId = activeSearchJobId;
    await cancelSearchBackend(prevJobId);

    const requestId = get().requestId + 1;
    set({
      loading: true,
      error: null,
      statusKind: 'none',
      results: [],
      unmatchedFiles: [],
      truncated: false,
      requestId,
    });

    const mergedOptions = buildOptionsWithSettings(options);
    const { settings } = useSettingsStore.getState();
    const cacheKey = JSON.stringify({
      type: 'search',
      paths: searchPaths,
      query: query.trim(),
      options: mergedOptions,
    });

    if (settings.enableSearchCache) {
      const cached = readCache(cacheKey);
      if (cached) {
        if (get().requestId !== requestId) return;
        const totalMatches = cached.matched.reduce((sum, r) => sum + r.matchCount, 0);
        set({
          results: cached.matched,
          unmatchedFiles: cached.unmatched,
          loading: false,
          totalScanned: cached.totalScanned,
          matchedFiles: cached.matched.length,
          unmatchedCount: cached.unmatched.length,
          totalMatches,
          truncated: !!cached.truncated,
          error: cached.truncated ? i18n.t('search.store.truncatedHint') : null,
          statusKind: cached.truncated ? 'truncated' : 'none',
        });
        return;
      }
    }

    const searchRetryPayload = {
      action: 'search' as const,
      query: query.trim(),
      searchPaths: [...searchPaths],
      mode: get().mode,
    };

    let jobId = 0;
    let taskId = '';
    try {
      jobId = await prepareJob('search');
      activeSearchJobId = jobId;
      taskId = makeTaskId('search', jobId);
      useTaskStore.getState().upsertTask({
        id: taskId,
        kind: 'search',
        title: query.trim(),
        status: 'running',
        backendJobId: jobId,
        progress: { current: 0, total: 0, percentage: 0 },
        startedAt: Date.now(),
        cancellable: true,
        retryPayload: searchRetryPayload,
      });
    } catch (err) {
      set({ error: mapBackendError(err), statusKind: 'error', loading: false });
      return;
    }

    const timeoutMs = Math.max(10, settings.searchTimeout) * 1000;
    let timedOut = false;
    activeTimeoutRequestId = requestId;
    activeTimeoutId = window.setTimeout(() => {
      if (activeTimeoutRequestId !== requestId) return;
      timedOut = true;
      cancelSearchBackend(jobId);
    }, timeoutMs);

    try {
      // Filename-only local search: prefer SQLite index (skip remote roots in index path).
      const useIndex =
        mergedOptions.search_filename &&
        !mergedOptions.search_content &&
        searchPaths.some((p) => !p.startsWith('remote://'));

      let response: SearchResponse;
      if (useIndex) {
        const localRoots = searchPaths.filter((p) => !p.startsWith('remote://'));
        const remoteRoots = searchPaths.filter((p) => p.startsWith('remote://'));
        const indexed = await invoke<SearchResponse>('search_index_filename', {
          query: query.trim(),
          roots: localRoots,
          limit: 5000,
        });
        if (remoteRoots.length > 0) {
          const remote = await invoke<SearchResponse>('search_files', {
            paths: remoteRoots,
            query: query.trim(),
            options: { ...mergedOptions, search_content: false },
            jobId,
          });
          response = {
            matched: [...indexed.matched, ...remote.matched],
            unmatched: [...(indexed.unmatched || []), ...(remote.unmatched || [])],
            totalScanned: (indexed.totalScanned || 0) + (remote.totalScanned || 0),
            cancelled: Boolean(indexed.cancelled || remote.cancelled),
            truncated: Boolean(indexed.truncated || remote.truncated),
          };
        } else {
          response = indexed;
        }
      } else {
        response = await invoke<SearchResponse>('search_files', {
          paths: searchPaths,
          query: query.trim(),
          options: mergedOptions,
          jobId,
        });
      }

      if (get().requestId !== requestId) return;

      const totalMatches = response.matched.reduce((sum, r) => sum + r.matchCount, 0);

      if (settings.enableSearchCache && !response.cancelled) {
        writeCache(cacheKey, response);
      }

      const hasPartial =
        response.matched.length > 0 || response.unmatched.length > 0;
      let error: string | null = null;
      let statusKind: SearchStatusKind = 'none';
      if (response.cancelled) {
        if (timedOut) {
          statusKind = 'timeout';
          error = hasPartial
            ? i18n.t('search.store.searchTimeoutPartial', { seconds: settings.searchTimeout })
            : i18n.t('search.store.searchTimeout', { seconds: settings.searchTimeout });
        } else {
          statusKind = 'cancelled';
          error = i18n.t('search.store.searchCancelled');
        }
      } else if (response.truncated) {
        statusKind = 'truncated';
        error = i18n.t('search.store.truncatedHint');
      }

      set({
        results: response.matched,
        unmatchedFiles: response.unmatched,
        loading: false,
        totalScanned: response.totalScanned,
        matchedFiles: response.matched.length,
        unmatchedCount: response.unmatched.length,
        totalMatches,
        truncated: !!response.truncated,
        statusKind,
        error: error ? error + (response.cancelled ? truncatedHint(response.truncated) : '') : null,
      });
      if (taskId) {
        useTaskStore
          .getState()
          .completeTask(
            taskId,
            response.cancelled ? 'cancelled' : 'completed',
            undefined,
            searchRetryPayload
          );
      }
    } catch (err) {
      if (taskId) {
        useTaskStore
          .getState()
          .completeTask(
            taskId,
            timedOut ? 'cancelled' : 'failed',
            mapBackendError(err),
            searchRetryPayload
          );
      }
      if (get().requestId !== requestId) return;
      set({
        error: timedOut
          ? i18n.t('search.store.searchTimeout', { seconds: settings.searchTimeout })
          : mapBackendError(err),
        statusKind: timedOut ? 'timeout' : 'error',
        loading: false,
      });
    } finally {
      if (activeSearchJobId === jobId) {
        activeSearchJobId = 0;
      }
      if (activeTimeoutRequestId === requestId) {
        clearActiveTimeout();
      }
    }
  },

  checkKeywords: async () => {
    const { query, searchPaths, options } = get();

    if (!query.trim() || searchPaths.length === 0) {
      set({ error: i18n.t('search.store.needKeywordsAndPath'), statusKind: 'error' });
      return;
    }

    const keywords = query.split(/[,，]/).map((k) => k.trim()).filter((k) => k.length > 0);

    if (keywords.length === 0) {
      set({ error: i18n.t('search.store.needAtLeastOneKeyword'), statusKind: 'error' });
      return;
    }

    clearActiveTimeout();
    await cancelSearchBackend(activeSearchJobId);

    const requestId = get().requestId + 1;
    set({
      loading: true,
      error: null,
      statusKind: 'none',
      keywordCheckResults: [],
      keywordCheckKeywords: [],
      truncated: false,
      requestId,
    });

    const mergedOptions = buildOptionsWithSettings(options);
    const { settings } = useSettingsStore.getState();

    const checkRetryPayload = {
      action: 'checkKeywords' as const,
      query: query.trim(),
      searchPaths: [...searchPaths],
      keywords,
    };

    let jobId = 0;
    let taskId = '';
    try {
      jobId = await prepareJob('search');
      activeSearchJobId = jobId;
      taskId = makeTaskId('search', jobId);
      useTaskStore.getState().upsertTask({
        id: taskId,
        kind: 'search',
        title: query.trim(),
        status: 'running',
        backendJobId: jobId,
        progress: { current: 0, total: 0, percentage: 0 },
        startedAt: Date.now(),
        cancellable: true,
        retryPayload: checkRetryPayload,
      });
    } catch (err) {
      set({ error: mapBackendError(err), statusKind: 'error', loading: false });
      return;
    }

    const timeoutMs = Math.max(10, settings.searchTimeout) * 1000;
    let timedOut = false;
    activeTimeoutRequestId = requestId;
    activeTimeoutId = window.setTimeout(() => {
      if (activeTimeoutRequestId !== requestId) return;
      timedOut = true;
      cancelSearchBackend(jobId);
    }, timeoutMs);

    try {
      const response = await invoke<KeywordCheckResponse>('check_keywords', {
        paths: searchPaths,
        keywords,
        options: mergedOptions,
        jobId,
      });

      if (get().requestId !== requestId) return;

      const hasPartial = response.results.length > 0;
      let error: string | null = null;
      let statusKind: SearchStatusKind = 'none';
      if (response.cancelled) {
        if (timedOut) {
          statusKind = 'timeout';
          error = hasPartial
            ? i18n.t('search.store.checkTimeoutPartial', { seconds: settings.searchTimeout })
            : i18n.t('search.store.checkTimeout', { seconds: settings.searchTimeout });
        } else {
          statusKind = 'cancelled';
          error = i18n.t('search.store.checkCancelled');
        }
      } else if (response.truncated) {
        statusKind = 'truncated';
        error = i18n.t('search.store.truncatedHint');
      }

      set({
        keywordCheckResults: response.results,
        keywordCheckKeywords: response.keywords,
        loading: false,
        totalScanned: response.totalScanned,
        unmatchedCount: response.totalWithMissing,
        matchedFiles: Math.max(0, response.totalScanned - response.totalWithMissing),
        totalMatches: 0,
        truncated: !!response.truncated,
        statusKind,
        error: error ? error + (response.cancelled ? truncatedHint(response.truncated) : '') : null,
      });
      if (taskId) {
        useTaskStore
          .getState()
          .completeTask(
            taskId,
            response.cancelled ? 'cancelled' : 'completed',
            undefined,
            checkRetryPayload
          );
      }
    } catch (err) {
      if (taskId) {
        useTaskStore
          .getState()
          .completeTask(
            taskId,
            timedOut ? 'cancelled' : 'failed',
            mapBackendError(err),
            checkRetryPayload
          );
      }
      if (get().requestId !== requestId) return;
      set({
        error: timedOut
          ? i18n.t('search.store.checkTimeout', { seconds: settings.searchTimeout })
          : mapBackendError(err),
        statusKind: timedOut ? 'timeout' : 'error',
        loading: false,
      });
    } finally {
      if (activeSearchJobId === jobId) {
        activeSearchJobId = 0;
      }
      if (activeTimeoutRequestId === requestId) {
        clearActiveTimeout();
      }
    }
  },

  cancelSearch: async () => {
    // Keep requestId so the in-flight cancelled response can land with partial results.
    const jobId = activeSearchJobId;
    clearActiveTimeout();
    set({
      loading: false,
      statusKind: 'cancelled',
      error: get().mode === 'keyword-check'
        ? i18n.t('search.store.checkCancelled')
        : i18n.t('search.store.searchCancelled'),
    });
    await cancelSearchBackend(jobId);
    if (activeSearchJobId === jobId) {
      activeSearchJobId = 0;
    }
  },

  clearResults: () => set({
    results: [],
    unmatchedFiles: [],
    keywordCheckResults: [],
    keywordCheckKeywords: [],
    error: null,
    statusKind: 'none',
    truncated: false,
    totalScanned: 0,
    matchedFiles: 0,
    unmatchedCount: 0,
    totalMatches: 0,
  }),
}));

// Sync only the settings fields that actually changed — avoid wiping panel toggles
// when the user only adjusts PDF size / concurrency / etc.
useSettingsStore.subscribe((state, prev) => {
  const s = state.settings;
  const p = prev.settings;
  const updates: Partial<SearchOptions> = {};

  if (s.defaultSearchContent !== p.defaultSearchContent) {
    updates.search_content = s.defaultSearchContent;
  }
  if (s.defaultSearchFilename !== p.defaultSearchFilename) {
    updates.search_filename = s.defaultSearchFilename;
  }
  if (s.defaultCaseSensitive !== p.defaultCaseSensitive) {
    updates.case_sensitive = s.defaultCaseSensitive;
  }
  if (s.showHiddenFiles !== p.showHiddenFiles) {
    updates.include_hidden = s.showHiddenFiles;
  }
  if (s.maxPdfSizeMB !== p.maxPdfSizeMB) {
    updates.max_pdf_size_mb = s.maxPdfSizeMB;
  }
  if (s.maxTextSizeMB !== p.maxTextSizeMB) {
    updates.max_text_size_mb = s.maxTextSizeMB;
  }
  if (s.maxConcurrentSearches !== p.maxConcurrentSearches) {
    updates.max_concurrency = s.maxConcurrentSearches;
  }

  if (Object.keys(updates).length > 0) {
    useSearchStore.getState().setOptions(updates);
  }
});
