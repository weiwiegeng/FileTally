import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Input,
  Button,
  Space,
  Switch,
  Typography,
  Select,
  Tooltip,
  Badge,
  Dropdown,
  Segmented,
  message,
  Tag,
  Spin,
  Tree,
  Alert,
} from 'antd';
import type { TreeDataNode } from 'antd';
import {
  SearchOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  SettingOutlined,
  ClearOutlined,
  CloudServerOutlined,
  DownOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  PlusOutlined,
  FileOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import * as XLSX from 'xlsx';
import { useSearchStore, useSettingsStore, useRemoteStore, SearchMode } from '../../stores';
import { useThemeColors } from '../../hooks';
import { RemoteFolderSelector } from './RemoteFolderSelector';
import { isRemotePath, getPathName } from '../../utils/format';
import { mapBackendError } from '../../utils/backendError';

const { Text } = Typography;

// 文件夹内容类型（匹配后端 FileNode snake_case 字段）
interface FolderContent {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  children_count?: number | null;
}

// 文件夹内容缓存
interface FolderContentCache {
  [path: string]: {
    loading: boolean;
    contents: FolderContent[];
  };
}

export const SearchPanel: React.FC = () => {
  const { t } = useTranslation();
  const fileTypeOptions = useMemo(
    () => [
      { label: t('search.panel.fileTypeAll'), value: '' },
      { label: t('search.panel.fileTypePdf'), value: 'pdf' },
      { label: t('search.panel.fileTypeText'), value: 'txt,md,json,xml,html,css,js,ts' },
      { label: t('search.panel.fileTypeCode'), value: 'py,rs,go,java,c,cpp,h' },
      { label: t('search.panel.fileTypeConfig'), value: 'yaml,yml,toml,ini,conf' },
    ],
    [t]
  );
  const {
    mode,
    query,
    searchPaths,
    options,
    loading,
    totalScanned,
    matchedFiles,
    unmatchedCount,
    totalMatches,
    keywordCheckResults,
    keywordCheckKeywords,
    setMode,
    setQuery,
    addSearchPath,
    removeSearchPath,
    setSearchPaths,
    setOptions,
    search,
    checkKeywords,
    cancelSearch,
    clearResults,
  } = useSearchStore();
  const { settings } = useSettingsStore();
  const { connections } = useRemoteStore();
  const colors = useThemeColors();

  const [showOptions, setShowOptions] = useState(true);
  const [selectedFileTypes, setSelectedFileTypes] = useState<string>('');
  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [folderContents, setFolderContents] = useState<FolderContentCache>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const hasRemoteSearchPath = useMemo(
    () => searchPaths.some((p) => isRemotePath(p)),
    [searchPaths]
  );

  // 初次加载时应用设置中的默认值
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      setOptions({
        search_content: settings.defaultSearchContent,
        search_filename: settings.defaultSearchFilename,
        case_sensitive: settings.defaultCaseSensitive,
        max_pdf_size_mb: settings.maxPdfSizeMB,
        max_text_size_mb: settings.maxTextSizeMB,
        max_concurrency: settings.maxConcurrentSearches,
      });
    }
  }, []);

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: true,  // 支持多选
        title: t('search.panel.dialogSelectDirs'),
      });
      
      if (selected) {
        // selected 可能是单个字符串或数组
        const paths = Array.isArray(selected) ? selected : [selected];
        // 追加模式：保留已有目录
        const existing = new Set(useSearchStore.getState().searchPaths);
        const newPaths = paths.filter((p) => !existing.has(p));
        if (newPaths.length === 0) {
          return;
        }
        newPaths.forEach((p) => addSearchPath(p));
        
        // 设置新增路径为 loading 状态
        setLoadingPaths(new Set(newPaths));
        
        // 并行加载所有根目录，使用 Promise.all 等待全部完成
        const results = await Promise.all(
          newPaths.map(async (path) => {
            try {
              const contents = await invoke<FolderContent[]>('scan_directory', { path });
              return { path, contents, success: true };
            } catch (err) {
              console.error(`load folder contents failed: ${path}`, err);
              return { path, contents: [], success: false };
            }
          })
        );
        
        // 合并新增目录的缓存
        setFolderContents((prev) => {
          const next = { ...prev };
          results.forEach(({ path, contents }) => {
            next[path] = { loading: false, contents };
          });
          return next;
        });
        setLoadingPaths(new Set());
      }
    } catch (err) {
      console.error('select directory failed:', err);
    }
  };

  // 加载文件夹内容
  const loadFolderContents = async (folderPath: string) => {
    if (folderContents[folderPath]?.contents.length > 0) {
      return; // 已缓存
    }
    
    setLoadingPaths(prev => new Set(prev).add(folderPath));
    setFolderContents(prev => ({
      ...prev,
      [folderPath]: { loading: true, contents: [] }
    }));
    
    try {
      const contents = await invoke<FolderContent[]>('scan_directory', {
        path: folderPath
      });
      
      setFolderContents(prev => ({
        ...prev,
        [folderPath]: { loading: false, contents }
      }));
    } catch (err) {
      console.error('load folder contents failed:', err);
      setFolderContents(prev => ({
        ...prev,
        [folderPath]: { loading: false, contents: [] }
      }));
    } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev);
        next.delete(folderPath);
        return next;
      });
    }
  };

  // 构建树节点数据
  const buildTreeData = (rootPath: string): TreeDataNode[] => {
    const cache = folderContents[rootPath];
    if (!cache || cache.contents.length === 0) {
      if (cache?.loading || loadingPaths.has(rootPath)) {
        return [{ key: `${rootPath}-loading`, title: <Spin size="small" />, isLeaf: true }];
      }
      return [];
    }
    
    return cache.contents.map(item => {
      const node: TreeDataNode = {
        key: item.path,
        title: (
          <Space size={4}>
            <span>{item.name}</span>
            {item.is_dir && item.children_count != null && item.children_count > 0 && (
              <Tag color="blue" style={{ fontSize: 10, marginLeft: 4 }}>
                {t('search.panel.treeItemCount', { count: item.children_count })}
              </Tag>
            )}
          </Space>
        ),
        icon: item.is_dir ? (
          <FolderOutlined style={{ color: colors.accentOrange }} />
        ) : (
          <FileOutlined style={{ color: colors.textSecondary }} />
        ),
        isLeaf: !item.is_dir,
      };
      
      // 如果是文件夹且已加载子内容，递归构建
      if (item.is_dir) {
        const childCache = folderContents[item.path];
        if (childCache?.contents.length > 0) {
          node.children = buildTreeData(item.path);
        } else if (loadingPaths.has(item.path)) {
          node.children = [{ key: `${item.path}-loading`, title: <Spin size="small" />, isLeaf: true }];
        }
      }
      
      return node;
    });
  };

  // 异步加载子节点
  const onLoadData = async (treeNode: TreeDataNode): Promise<void> => {
    const path = treeNode.key as string;
    if (folderContents[path]?.contents.length > 0) {
      return;
    }
    await loadFolderContents(path);
  };

  const handleIndexRoots = async () => {
    if (searchPaths.length === 0) return;
    try {
      let total = 0;
      for (const root of searchPaths) {
        if (root.startsWith('remote://')) continue;
        const n = await invoke<number>('index_root_incremental', { root });
        total += n;
      }
      message.success(t('search.panel.indexDone', { count: total }));
    } catch (e) {
      message.error(mapBackendError(e));
    }
  };

  const handleSearch = () => {
    if (selectedFileTypes) {
      setOptions({ file_extensions: selectedFileTypes.split(',') });
    } else {
      setOptions({ file_extensions: undefined });
    }
    
    if (mode === 'normal') {
      search();
    } else {
      checkKeywords();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleSearch();
    }
  };

  // 导出 Excel
  const handleExportExcel = async () => {
    if (keywordCheckResults.length === 0) {
      message.warning(t('search.panel.exportNoData'));
      return;
    }

    setExporting(true);
    try {
      // 准备数据
      const exportData = keywordCheckResults.map(item => ({
        [t('search.panel.exportColFileName')]: item.fileName,
        [t('search.panel.exportColFilePath')]: item.filePath,
        [t('search.panel.exportColFileType')]: item.fileType,
        [t('search.panel.exportColMissingKeywords')]: item.missingKeywords.join(', '),
      }));

      // 创建工作薄
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, t('search.panel.exportSheetName'));

      // 设置列宽
      ws['!cols'] = [
        { wch: 30 },  // 文件名
        { wch: 60 },  // 文件路径
        { wch: 10 },  // 文件类型
        { wch: 40 },  // 缺失关键词
      ];

      // 生成文件内容
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

      // 选择保存路径
      const savePath = await save({
        defaultPath: t('search.panel.exportDefaultFileName', {
          date: new Date().toISOString().slice(0, 10),
        }),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });

      if (savePath) {
        await writeFile(savePath, new Uint8Array(excelBuffer));
        message.success(t('search.panel.exportSuccess'));
      }
    } catch (err) {
      console.error('export failed:', err);
      message.error(t('search.panel.exportFailed', { error: mapBackendError(err) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      style={{
        padding: '16px 24px',
        borderBottom: `1px solid ${colors.border}`,
        background: colors.bgSecondary,
      }}
    >
      {/* 搜索栏 */}
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {hasRemoteSearchPath && (
          <Alert
            type="info"
            showIcon
            message={t('search.panel.remoteScanNote')}
            closable
          />
        )}
        {/* 模式切换 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as SearchMode)}
            options={[
              { label: t('search.panel.modeNormal'), value: 'normal', icon: <SearchOutlined /> },
              { label: t('search.panel.modeKeywordCheck'), value: 'keyword-check', icon: <CheckCircleOutlined /> },
            ]}
          />
          {mode === 'keyword-check' && keywordCheckResults.length > 0 && (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={handleExportExcel}
              loading={exporting}
            >
              {t('search.panel.exportExcel')}
            </Button>
          )}
        </div>

        <Space.Compact style={{ width: '100%' }}>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'local',
                  label: t('search.panel.addDirLocal'),
                  icon: <FolderOpenOutlined />,
                  onClick: handleSelectFolder,
                },
                {
                  key: 'remote',
                  label: t('search.panel.addDirRemote'),
                  icon: <CloudServerOutlined />,
                  onClick: () => setShowRemoteSelector(true),
                  disabled: connections.length === 0,
                },
              ],
            }}
          >
            <Button style={{ minWidth: 160 }}>
              <Space>
                <PlusOutlined />
                <span>{t('search.panel.addDir')}</span>
                {searchPaths.length > 0 && (
                  <Badge count={searchPaths.length} style={{ marginLeft: 4 }} />
                )}
                <DownOutlined style={{ fontSize: 10 }} />
              </Space>
            </Button>
          </Dropdown>
          
          <Input
            placeholder={
              mode === 'normal'
                ? t('search.panel.placeholderNormal')
                : t('search.panel.placeholderKeyword')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            prefix={<SearchOutlined style={{ color: colors.textSecondary }} />}
            style={{ flex: 1 }}
            allowClear
          />
          
          <Button
            type="primary"
            icon={mode === 'normal' ? <SearchOutlined /> : <CheckCircleOutlined />}
            onClick={handleSearch}
            loading={loading}
            disabled={loading || !query.trim() || searchPaths.length === 0}
          >
            {mode === 'normal' ? t('search.panel.actionSearch') : t('search.panel.actionCheck')}
          </Button>

          <Tooltip title={t('search.panel.indexTooltip')}>
            <Button onClick={() => void handleIndexRoots()} disabled={searchPaths.length === 0}>
              {t('search.panel.index')}
            </Button>
          </Tooltip>

          {loading && (
            <Button danger onClick={() => cancelSearch()}>
              {t('search.panel.cancel')}
            </Button>
          )}
          
          <Tooltip title={t('search.panel.tooltipOptions')}>
            <Button
              icon={<SettingOutlined />}
              onClick={() => setShowOptions(!showOptions)}
              type={showOptions ? 'primary' : 'default'}
            />
          </Tooltip>
          
          <Tooltip title={t('search.panel.tooltipClearResults')}>
            <Button
              icon={<ClearOutlined />}
              onClick={clearResults}
            />
          </Tooltip>
        </Space.Compact>

        {/* 搜索选项 */}
        {showOptions && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              padding: '12px 16px',
              background: colors.bgHover,
              borderRadius: 8,
              flexWrap: 'wrap',
            }}
          >
            <Space>
              <FileTextOutlined style={{ color: colors.accentBlue }} />
              <Text type="secondary">{t('search.panel.optionSearchContent')}</Text>
              <Switch
                checked={options.search_content}
                onChange={(checked) => setOptions({ search_content: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">{t('search.panel.optionSearchFilename')}</Text>
              <Switch
                checked={options.search_filename}
                onChange={(checked) => setOptions({ search_filename: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">{t('search.panel.optionCaseSensitive')}</Text>
              <Switch
                checked={options.case_sensitive}
                onChange={(checked) => setOptions({ case_sensitive: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">{t('search.panel.optionHiddenFiles')}</Text>
              <Switch
                checked={options.include_hidden}
                onChange={(checked) => setOptions({ include_hidden: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">{t('search.panel.optionFileType')}</Text>
              <Select
                value={selectedFileTypes}
                onChange={setSelectedFileTypes}
                style={{ minWidth: 140 }}
                size="small"
                options={fileTypeOptions}
                placeholder={t('search.panel.placeholderSelectType')}
              />
            </Space>
          </div>
        )}

        {/* 搜索统计 */}
        {(totalScanned > 0 || loading) && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <Badge
              count={totalScanned}
              showZero
              color="#8c8c8c"
              overflowCount={9999}
            >
              <Text type="secondary" style={{ paddingRight: 8 }}>
                {t('search.panel.statScannedFiles')}
              </Text>
            </Badge>
            <Badge
              count={matchedFiles}
              showZero
              color="#52c41a"
              overflowCount={999}
            >
              <Text type="secondary" style={{ paddingRight: 8 }}>
                {mode === 'normal'
                  ? t('search.panel.statMatchedNormal')
                  : t('search.panel.statMatchedKeyword')}
              </Text>
            </Badge>
            <Badge
              count={unmatchedCount}
              showZero
              color="#ff4d4f"
              overflowCount={999}
            >
              <Text type="secondary" style={{ paddingRight: 8 }}>
                {mode === 'normal'
                  ? t('search.panel.statUnmatchedNormal')
                  : t('search.panel.statUnmatchedKeyword')}
              </Text>
            </Badge>
            {mode === 'normal' && (
              <Badge
                count={totalMatches}
                showZero
                color="#1890ff"
                overflowCount={9999}
              >
                <Text type="secondary" style={{ paddingRight: 8 }}>
                  {t('search.panel.statTotalMatches')}
                </Text>
              </Badge>
            )}
            {mode === 'keyword-check' && keywordCheckKeywords.length > 0 && (
              <Text type="secondary">
                {t('search.panel.statKeywords', { keywords: keywordCheckKeywords.join(', ') })}
              </Text>
            )}
            {searchPaths.length > 0 && (
              <Text type="secondary" ellipsis style={{ maxWidth: 300 }}>
                {t('search.panel.statPaths', { count: searchPaths.length })}
              </Text>
            )}
          </div>
        )}

        {/* 已选文件夹列表及内容预览 */}
        {searchPaths.length > 0 && (
          <div
            style={{
              background: colors.bgHover,
              borderRadius: 8,
              padding: 12,
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            {/* 标题栏：显示数量 + 清空按钮 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text type="secondary">
                {t('search.panel.selectedDirs', { count: searchPaths.length })}
              </Text>
              <Button
                type="link"
                size="small"
                danger
                onClick={() => {
                  setSearchPaths([]);
                  setFolderContents({});
                }}
              >
                {t('search.panel.clearAll')}
              </Button>
            </div>
            
            {/* 每个根目录一棵树 */}
            {searchPaths.map(rootPath => (
              <div key={rootPath} style={{ marginBottom: 8 }}>
                {/* 根目录标题 */}
                <div 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 8, 
                    padding: '4px 8px',
                    background: colors.bgSecondary,
                    borderRadius: 4,
                    marginBottom: 4,
                  }}
                >
                  {isRemotePath(rootPath) ? (
                    <CloudServerOutlined style={{ color: colors.accentPurple }} />
                  ) : (
                    <FolderOpenOutlined style={{ color: colors.accentOrange }} />
                  )}
                  <Text style={{ flex: 1 }} ellipsis title={rootPath}>
                    {getPathName(rootPath)}
                  </Text>
                  <Tooltip title={t('search.panel.tooltipRemove')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() => {
                        removeSearchPath(rootPath);
                        // 清理相关缓存
                        const newCache = { ...folderContents };
                        Object.keys(newCache).forEach(key => {
                          if (key === rootPath || key.startsWith(rootPath + '/') || key.startsWith(rootPath + '\\')) {
                            delete newCache[key];
                          }
                        });
                        setFolderContents(newCache);
                      }}
                      style={{ color: colors.textSecondary }}
                    />
                  </Tooltip>
                </div>
                
                {/* 树形内容 */}
                {loadingPaths.has(rootPath) ? (
                  <div style={{ textAlign: 'center', padding: 16 }}>
                    <Spin size="small" />
                    <Text type="secondary" style={{ marginLeft: 8 }}>
                      {t('search.panel.treeLoading')}
                    </Text>
                  </div>
                ) : buildTreeData(rootPath).length === 0 ? (
                  <Text type="secondary" style={{ padding: '8px 24px', display: 'block' }}>
                    {t('search.panel.treeEmpty')}
                  </Text>
                ) : (
                  <Tree
                    showIcon
                    showLine={{ showLeafIcon: false }}
                    treeData={buildTreeData(rootPath)}
                    loadData={onLoadData}
                    onExpand={(_, info) => {
                      // 展开时加载内容
                      if (info.expanded && info.node.key) {
                        loadFolderContents(info.node.key as string);
                      }
                    }}
                    style={{ background: 'transparent' }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Space>

      {/* 远程目录选择器 */}
      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path) => {
          addSearchPath(path);
          loadFolderContents(path);
        }}
      />
    </div>
  );
};
