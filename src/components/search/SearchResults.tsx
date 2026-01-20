import React, { useState } from 'react';
import {
  List,
  Typography,
  Tag,
  Empty,
  Spin,
  Alert,
  Collapse,
  Space,
  Tooltip,
  Tabs,
  Badge,
  Table,
} from 'antd';
import {
  FileTextOutlined,
  FilePdfOutlined,
  FileExcelOutlined,
  FileWordOutlined,
  FileImageOutlined,
  FileOutlined,
  FolderOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useSearchStore, SearchResult, SearchMatch, UnmatchedFile, KeywordCheckResult } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Text, Paragraph } = Typography;

// 文件类型图标映射
const getFileIcon = (fileType: string) => {
  const iconStyle = { fontSize: 20 };
  switch (fileType) {
    case 'pdf':
      return <FilePdfOutlined style={{ ...iconStyle, color: '#ff4d4f' }} />;
    case 'word':
      return <FileWordOutlined style={{ ...iconStyle, color: '#1890ff' }} />;
    case 'excel':
      return <FileExcelOutlined style={{ ...iconStyle, color: '#52c41a' }} />;
    case 'text':
      return <FileTextOutlined style={{ ...iconStyle, color: '#faad14' }} />;
    case 'image':
      return <FileImageOutlined style={{ ...iconStyle, color: '#eb2f96' }} />;
    default:
      return <FileOutlined style={{ ...iconStyle, color: '#8c8c8c' }} />;
  }
};

// 高亮匹配文本
const HighlightText: React.FC<{ 
  content: string; 
  matchStart: number; 
  matchEnd: number;
  query: string;
}> = ({ content, matchStart, matchEnd, query }) => {
  if (matchStart === 0 && matchEnd === 0) {
    // 文件名匹配，尝试高亮整个查询词
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerContent.indexOf(lowerQuery);
    
    if (index !== -1) {
      return (
        <Text>
          {content.substring(0, index)}
          <Text mark strong>{content.substring(index, index + query.length)}</Text>
          {content.substring(index + query.length)}
        </Text>
      );
    }
    return <Text>{content}</Text>;
  }
  
  // 截取上下文，最多显示前后50个字符
  const contextBefore = Math.max(0, matchStart - 50);
  const contextAfter = Math.min(content.length, matchEnd + 50);
  
  const before = content.substring(contextBefore, matchStart);
  const match = content.substring(matchStart, matchEnd);
  const after = content.substring(matchEnd, contextAfter);
  
  return (
    <Text>
      {contextBefore > 0 && '...'}
      {before}
      <Text mark strong style={{ background: '#faad14', padding: '0 2px' }}>
        {match}
      </Text>
      {after}
      {contextAfter < content.length && '...'}
    </Text>
  );
};

// 单个匹配项
const MatchItem: React.FC<{ match: SearchMatch; query: string }> = ({ match, query }) => {
  const isFilenameMatch = match.lineNumber === 0;
  
  return (
    <div
      style={{
        padding: '8px 12px',
        background: 'rgba(24, 144, 255, 0.05)',
        borderRadius: 4,
        marginBottom: 4,
        borderLeft: `3px solid ${isFilenameMatch ? '#52c41a' : '#1890ff'}`,
      }}
    >
      <Space size="small">
        {isFilenameMatch ? (
          <Tag color="green" icon={<FolderOutlined />}>文件名</Tag>
        ) : (
          <Tag color="blue">行 {match.lineNumber}</Tag>
        )}
        <HighlightText
          content={match.content}
          matchStart={match.matchStart}
          matchEnd={match.matchEnd}
          query={query}
        />
      </Space>
    </div>
  );
};

// 搜索结果项
const SearchResultItem: React.FC<{ result: SearchResult; query: string }> = ({ result, query }) => {
  // 分离文件名匹配和内容匹配
  const filenameMatches = result.matches.filter(m => m.lineNumber === 0);
  const contentMatches = result.matches.filter(m => m.lineNumber !== 0);
  
  return (
    <Collapse
      ghost
      items={[
        {
          key: result.filePath,
          label: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {getFileIcon(result.fileType)}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text strong ellipsis style={{ maxWidth: 300 }}>
                    {result.fileName}
                  </Text>
                  <Tag color="purple">{result.matchCount} 处匹配</Tag>
                  {filenameMatches.length > 0 && (
                    <Tooltip title="文件名匹配">
                      <CheckCircleOutlined style={{ color: '#52c41a' }} />
                    </Tooltip>
                  )}
                  {contentMatches.length > 0 && (
                    <Tooltip title="内容匹配">
                      <InfoCircleOutlined style={{ color: '#1890ff' }} />
                    </Tooltip>
                  )}
                </div>
                <Paragraph
                  type="secondary"
                  ellipsis
                  style={{ margin: 0, fontSize: 12 }}
                >
                  {result.filePath}
                </Paragraph>
              </div>
            </div>
          ),
          children: (
            <div style={{ maxHeight: 300, overflow: 'auto', paddingRight: 8 }}>
              {result.matches.map((match, index) => (
                <MatchItem key={index} match={match} query={query} />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
};

// 未匹配文件列表组件
const UnmatchedFileList: React.FC<{ files: UnmatchedFile[] }> = ({ files }) => {
  if (files.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="所有扫描的文件都匹配到了关键词"
        style={{ padding: 40 }}
      />
    );
  }

  return (
    <List
      size="small"
      dataSource={files}
      renderItem={(file) => (
        <List.Item
          style={{
            padding: '8px 12px',
            background: 'rgba(255, 77, 79, 0.05)',
            marginBottom: 4,
            borderRadius: 4,
            borderLeft: '3px solid #ff4d4f',
          }}
        >
          <Space>
            {getFileIcon(file.fileType)}
            <div>
              <Text ellipsis style={{ maxWidth: 300 }}>
                {file.fileName}
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                {file.filePath}
              </Text>
            </div>
          </Space>
          <Tag color="red" icon={<CloseCircleOutlined />}>
            未匹配
          </Tag>
        </List.Item>
      )}
    />
  );
};

// 关键词检查结果列表
const KeywordCheckResultList: React.FC<{ results: KeywordCheckResult[] }> = ({ results }) => {
  const colors = useThemeColors();
  
  if (results.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="所有文件都包含所有关键词"
        style={{ padding: 40 }}
      />
    );
  }

  const columns = [
    {
      title: '文件名',
      dataIndex: 'fileName',
      key: 'fileName',
      width: 250,
      ellipsis: true,
      render: (name: string, record: KeywordCheckResult) => (
        <Space>
          {getFileIcon(record.fileType)}
          <Tooltip title={record.filePath}>
            <Text ellipsis style={{ maxWidth: 200 }}>{name}</Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '文件路径',
      dataIndex: 'filePath',
      key: 'filePath',
      ellipsis: true,
      render: (path: string) => (
        <Tooltip title={path}>
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{path}</Text>
        </Tooltip>
      ),
    },
    {
      title: '缺失关键词',
      dataIndex: 'missingKeywords',
      key: 'missingKeywords',
      width: 300,
      render: (keywords: string[]) => (
        <Space wrap>
          {keywords.map((kw, idx) => (
            <Tag key={idx} color="red" icon={<WarningOutlined />}>
              {kw}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <Table
      dataSource={results}
      columns={columns}
      rowKey="filePath"
      size="small"
      pagination={{ pageSize: 20 }}
      scroll={{ y: 'calc(100vh - 380px)' }}
    />
  );
};

export const SearchResults: React.FC = () => {
  const { mode, results, unmatchedFiles, keywordCheckResults, loading, error, query, matchedFiles, unmatchedCount } = useSearchStore();
  const [activeTab, setActiveTab] = useState('matched');

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 60,
          gap: 16,
        }}
      >
        <Spin size="large" />
        <Text type="secondary">正在搜索文件内容...</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          搜索 PDF 等大文件可能需要一些时间
        </Text>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="error"
          message="搜索失败"
          description={error}
          showIcon
        />
      </div>
    );
  }

  if (mode === 'normal' && results.length === 0 && unmatchedFiles.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space direction="vertical" align="center">
            <Text type="secondary">输入关键词开始搜索</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持搜索文件名和文件内容（文本文件、PDF）
            </Text>
          </Space>
        }
        style={{ padding: 60 }}
      />
    );
  }
  
  if (mode === 'keyword-check' && keywordCheckResults.length === 0 && matchedFiles === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space direction="vertical" align="center">
            <Text type="secondary">输入多个关键词开始检查</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              用逗号分隔多个关键词，检查文件是否缺失关键词
            </Text>
          </Space>
        }
        style={{ padding: 60 }}
      />
    );
  }
  
  // 关键词检查模式
  if (mode === 'keyword-check') {
    return (
      <div style={{ height: '100%', padding: '16px 24px' }}>
        <KeywordCheckResultList results={keywordCheckResults} />
      </div>
    );
  }

  const tabItems = [
    {
      key: 'matched',
      label: (
        <Badge count={matchedFiles} offset={[10, 0]} color="#52c41a">
          <span style={{ paddingRight: 16 }}>匹配文件</span>
        </Badge>
      ),
      children: (
        <div style={{ padding: '0 24px', overflow: 'auto', height: 'calc(100vh - 320px)' }}>
          {results.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space direction="vertical" align="center">
                  <Text type="secondary">未找到匹配的文件</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    关键词 "{query}" 在选定目录中没有找到匹配结果
                  </Text>
                </Space>
              }
              style={{ padding: 40 }}
            />
          ) : (
            <List
              dataSource={results}
              renderItem={(result) => (
                <List.Item style={{ padding: '8px 0', border: 'none' }}>
                  <div style={{ width: '100%' }}>
                    <SearchResultItem result={result} query={query} />
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
      ),
    },
    {
      key: 'unmatched',
      label: (
        <Badge count={unmatchedCount} offset={[10, 0]} color="#ff4d4f">
          <span style={{ paddingRight: 16 }}>未匹配文件</span>
        </Badge>
      ),
      children: (
        <div style={{ padding: '0 24px', overflow: 'auto', height: 'calc(100vh - 320px)' }}>
          <UnmatchedFileList files={unmatchedFiles} />
        </div>
      ),
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        style={{ padding: '0 24px' }}
      />
    </div>
  );
};
