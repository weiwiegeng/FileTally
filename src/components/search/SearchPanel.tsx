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
} from 'antd';
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
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
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

export const SearchPanel: React.FC = () => {
  const {
    mode,
    query,
    searchPath,
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
    setSearchPath,
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
        multiple: false,
        title: '选择搜索目录',
      });
      
      if (selected) {
        setSearchPath(selected as string);
      }
    } catch (err) {
      console.error('选择目录失败:', err);
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
                {searchPath ? (
                  <>
                    {isRemotePath(searchPath) ? (
                      <CloudServerOutlined style={{ color: colors.accentPurple }} />
                    ) : (
                      <FolderOpenOutlined style={{ color: colors.accentOrange }} />
                    )}
                    <Text
                      ellipsis
                      style={{ maxWidth: 100, color: colors.accentBlue }}
                    >
                      {getPathName(searchPath)}
                    </Text>
                  </>
                ) : (
                  <>
                    <FolderOpenOutlined />
                    <span>选择目录</span>
                  </>
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
            disabled={!query.trim() || !searchPath}
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
            {searchPath && (
              <Text type="secondary" ellipsis style={{ maxWidth: 300 }}>
                搜索路径: {searchPath}
              </Text>
            )}
          </div>
        )}
      </Space>

      {/* 远程目录选择器 */}
      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path) => setSearchPath(path)}
      />
    </div>
  );
};
