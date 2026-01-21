import React, { useState, useEffect, useRef } from 'react';
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

const { Text } = Typography;

const FILE_TYPE_OPTIONS = [
  { label: '全部', value: '' },
  { label: 'PDF 文档', value: 'pdf' },
  { label: '文本文件', value: 'txt,md,json,xml,html,css,js,ts' },
  { label: '代码文件', value: 'py,rs,go,java,c,cpp,h' },
  { label: '配置文件', value: 'yaml,yml,toml,ini,conf' },
];

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

  // 初次加载时应用设置中的默认值
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      setOptions({
        search_content: settings.defaultSearchContent,
        search_filename: settings.defaultSearchFilename,
        case_sensitive: settings.defaultCaseSensitive,
        max_pdf_size_mb: settings.maxPdfSizeMB,
      });
    }
  }, []);

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: true,  // 支持多选
        title: '选择搜索目录（可多选）',
      });
      
      if (selected) {
        // selected 可能是单个字符串或数组
        const paths = Array.isArray(selected) ? selected : [selected];
        
        // 替换模式：清空旧的，添加新的
        setSearchPaths(paths);
        setFolderContents({});
        
        // 设置所有路径为 loading 状态
        setLoadingPaths(new Set(paths));
        
        // 并行加载所有根目录，使用 Promise.all 等待全部完成
        const results = await Promise.all(
          paths.map(async (path) => {
            try {
              const contents = await invoke<FolderContent[]>('scan_directory', { path });
              return { path, contents, success: true };
            } catch (err) {
              console.error(`加载文件夹内容失败: ${path}`, err);
              return { path, contents: [], success: false };
            }
          })
        );
        
        // 一次性更新所有结果
        const newContents: FolderContentCache = {};
        results.forEach(({ path, contents }) => {
          newContents[path] = { loading: false, contents };
        });
        setFolderContents(newContents);
        setLoadingPaths(new Set());
      }
    } catch (err) {
      console.error('选择目录失败:', err);
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
      console.error('加载文件夹内容失败:', err);
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
                {item.children_count} 项
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
      message.warning('没有可导出的数据');
      return;
    }

    setExporting(true);
    try {
      // 准备数据
      const exportData = keywordCheckResults.map(item => ({
        '文件名': item.fileName,
        '文件路径': item.filePath,
        '文件类型': item.fileType,
        '缺失关键词': item.missingKeywords.join(', '),
      }));

      // 创建工作薄
      const ws = XLSX.utils.json_to_sheet(exportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '缺失关键词报告');

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
        defaultPath: `关键词检查报告_${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });

      if (savePath) {
        await writeFile(savePath, new Uint8Array(excelBuffer));
        message.success('导出成功!');
      }
    } catch (err) {
      console.error('导出失败:', err);
      message.error('导出失败: ' + String(err));
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
      {/* 模式切换 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as SearchMode)}
            options={[
              { label: '普通搜索', value: 'normal', icon: <SearchOutlined /> },
              { label: '关键词检查', value: 'keyword-check', icon: <CheckCircleOutlined /> },
            ]}
          />
          {mode === 'keyword-check' && keywordCheckResults.length > 0 && (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={handleExportExcel}
              loading={exporting}
            >
              导出 Excel
            </Button>
          )}
        </div>

        <Space.Compact style={{ width: '100%' }}>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'local',
                  label: '本地目录',
                  icon: <FolderOpenOutlined />,
                  onClick: handleSelectFolder,
                },
                {
                  key: 'remote',
                  label: '远程目录',
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
                <span>添加目录</span>
                {searchPaths.length > 0 && (
                  <Badge count={searchPaths.length} style={{ marginLeft: 4 }} />
                )}
                <DownOutlined style={{ fontSize: 10 }} />
              </Space>
            </Button>
          </Dropdown>
          
          <Input
            placeholder={mode === 'normal' 
              ? "输入搜索关键词（支持文件名和文件内容搜索）" 
              : "输入多个关键词（逗号分隔，如: 招标,供应商,合同）"
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
            disabled={!query.trim() || searchPaths.length === 0}
          >
            {mode === 'normal' ? '搜索' : '检查'}
          </Button>
          
          <Tooltip title="搜索选项">
            <Button
              icon={<SettingOutlined />}
              onClick={() => setShowOptions(!showOptions)}
              type={showOptions ? 'primary' : 'default'}
            />
          </Tooltip>
          
          <Tooltip title="清空结果">
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
              <Text type="secondary">搜索内容:</Text>
              <Switch
                checked={options.search_content}
                onChange={(checked) => setOptions({ search_content: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">搜索文件名:</Text>
              <Switch
                checked={options.search_filename}
                onChange={(checked) => setOptions({ search_filename: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">区分大小写:</Text>
              <Switch
                checked={options.case_sensitive}
                onChange={(checked) => setOptions({ case_sensitive: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">包含隐藏文件:</Text>
              <Switch
                checked={options.include_hidden}
                onChange={(checked) => setOptions({ include_hidden: checked })}
                size="small"
              />
            </Space>
            
            <Space>
              <Text type="secondary">文件类型:</Text>
              <Select
                value={selectedFileTypes}
                onChange={setSelectedFileTypes}
                style={{ minWidth: 140 }}
                size="small"
                options={FILE_TYPE_OPTIONS}
                placeholder="选择类型"
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
                扫描文件
              </Text>
            </Badge>
            <Badge
              count={matchedFiles}
              showZero
              color="#52c41a"
              overflowCount={999}
            >
              <Text type="secondary" style={{ paddingRight: 8 }}>
                {mode === 'normal' ? '匹配文件' : '完全匹配'}
              </Text>
            </Badge>
            <Badge
              count={unmatchedCount}
              showZero
              color="#ff4d4f"
              overflowCount={999}
            >
              <Text type="secondary" style={{ paddingRight: 8 }}>
                {mode === 'normal' ? '未匹配' : '缺失关键词'}
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
                  匹配总数
                </Text>
              </Badge>
            )}
            {mode === 'keyword-check' && keywordCheckKeywords.length > 0 && (
              <Text type="secondary">
                检查关键词: {keywordCheckKeywords.join(', ')}
              </Text>
            )}
            {searchPaths.length > 0 && (
              <Text type="secondary" ellipsis style={{ maxWidth: 300 }}>
                搜索路径: {searchPaths.length} 个目录
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
              <Text type="secondary">已选 {searchPaths.length} 个目录</Text>
              <Button
                type="link"
                size="small"
                danger
                onClick={() => {
                  setSearchPaths([]);
                  setFolderContents({});
                }}
              >
                清空全部
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
                  <Tooltip title="移除">
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
                    <Text type="secondary" style={{ marginLeft: 8 }}>加载中...</Text>
                  </div>
                ) : buildTreeData(rootPath).length === 0 ? (
                  <Text type="secondary" style={{ padding: '8px 24px', display: 'block' }}>
                    空文件夹
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
          // 替换模式
          setSearchPaths([path]);
          setFolderContents({});
          loadFolderContents(path);
        }}
      />
    </div>
  );
};
