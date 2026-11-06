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
import { useTranslation } from 'react-i18next';
import { useSearchStore, SearchResult, SearchMatch, UnmatchedFile, KeywordCheckResult } from '../../stores';

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
  const { t } = useTranslation();
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
          <Tag color="green" icon={<FolderOutlined />}>
            {t('search.results.tagFilename')}
          </Tag>
        ) : (
          <Tag color="blue">{t('search.results.tagLine', { lineNumber: match.lineNumber })}</Tag>
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
  const { t } = useTranslation();
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
                  <Tag color="purple">
                    {t('search.results.matchCount', { count: result.matchCount })}
                  </Tag>
                  {filenameMatches.length > 0 && (
                    <Tooltip title={t('search.results.tooltipFilenameMatch')}>
                      <CheckCircleOutlined style={{ color: '#52c41a' }} />
                    </Tooltip>
                  )}
                  {contentMatches.length > 0 && (
                    <Tooltip title={t('search.results.tooltipContentMatch')}>
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
  const { t } = useTranslation();
  if (files.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('search.results.unmatchedAllMatched')}
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
            {t('search.results.tagUnmatched')}
          </Tag>
        </List.Item>
      )}
    />
  );
};

// 关键词检查结果列表
const KeywordCheckResultList: React.FC<{
  results: KeywordCheckResult[];
  incomplete?: boolean;
}> = ({ results, incomplete }) => {
  const { t } = useTranslation();

  if (results.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          incomplete
            ? t('search.results.keywordCheckIncomplete')
            : t('search.results.keywordAllPresent')
        }
        style={{ padding: 40 }}
      />
    );
  }

  const columns = [
    {
      title: t('search.results.colFileName'),
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
      title: t('search.results.colFilePath'),
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
      title: t('search.results.colMissingKeywords'),
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
  const { t } = useTranslation();
  const {
    mode,
    results,
    unmatchedFiles,
    keywordCheckResults,
    loading,
    error,
    statusKind,
    truncated,
    query,
    matchedFiles,
    unmatchedCount,
  } = useSearchStore();
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
        <Text type="secondary">{t('search.results.loadingPrimary')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('search.results.loadingHint')}
        </Text>
      </div>
    );
  }

  const hasNormalResults = results.length > 0 || unmatchedFiles.length > 0;
  const hasKeywordResults = keywordCheckResults.length > 0 || matchedFiles > 0;
  const hasResults = mode === 'keyword-check' ? hasKeywordResults : hasNormalResults;
  const isSoftStatus =
    statusKind === 'cancelled' || statusKind === 'timeout' || statusKind === 'truncated';
  const statusTitle =
    statusKind === 'cancelled'
      ? t('search.results.cancelledTitle')
      : statusKind === 'timeout'
        ? t('search.results.timeoutTitle')
        : hasResults || isSoftStatus
          ? t('search.results.statusWarningTitle')
          : t('search.results.errorTitle');
  const statusBanner =
    error || truncated ? (
      <Alert
        type={hasResults || isSoftStatus ? 'warning' : 'error'}
        message={statusTitle}
        description={error || t('search.store.truncatedHint')}
        showIcon
        style={{ marginBottom: 16 }}
      />
    ) : null;

  // Soft cancel/timeout/truncated with no rows — still show banner (not "failed")
  if (error && !hasResults) {
    return (
      <div style={{ padding: 24 }}>
        {statusBanner}
      </div>
    );
  }

  if (mode === 'normal' && results.length === 0 && unmatchedFiles.length === 0 && !error && !truncated) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space direction="vertical" align="center">
            <Text type="secondary">{t('search.results.emptyNormalTitle')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('search.results.emptyNormalHint')}
            </Text>
          </Space>
        }
        style={{ padding: 60 }}
      />
    );
  }
  
  if (mode === 'keyword-check' && keywordCheckResults.length === 0 && matchedFiles === 0 && !error && !truncated) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space direction="vertical" align="center">
            <Text type="secondary">{t('search.results.emptyKeywordTitle')}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('search.results.emptyKeywordHint')}
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
        {statusBanner}
        <KeywordCheckResultList
          results={keywordCheckResults}
          incomplete={isSoftStatus}
        />
      </div>
    );
  }

  const tabItems = [
    {
      key: 'matched',
      label: (
        <Badge count={matchedFiles} offset={[10, 0]} color="#52c41a">
          <span style={{ paddingRight: 16 }}>{t('search.results.tabMatched')}</span>
        </Badge>
      ),
      children: (
        <div style={{ padding: '0 24px', overflow: 'auto', height: 'calc(100vh - 320px)' }}>
          {results.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space direction="vertical" align="center">
                  <Text type="secondary">{t('search.results.noMatchTitle')}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('search.results.noMatchHint', { query })}
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
          <span style={{ paddingRight: 16 }}>{t('search.results.tabUnmatched')}</span>
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
      {statusBanner && <div style={{ padding: '16px 24px 0' }}>{statusBanner}</div>}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        style={{ padding: '0 24px' }}
      />
    </div>
  );
};
