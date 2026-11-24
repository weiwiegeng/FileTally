import React, { useState, useEffect } from 'react';
import {
  Button,
  Space,
  Typography,
  Table,
  Progress,
  Card,
  Statistic,
  Row,
  Col,
  Empty,
  Spin,
  Tooltip,
  Tag,
  Dropdown,
  message,
} from 'antd';
import { mapBackendError } from '../../utils/backendError';
import {
  FolderOpenOutlined,
  FileOutlined,
  CloudServerOutlined,
  DownOutlined,
  ThunderboltOutlined,
  CopyOutlined,
  ClockCircleOutlined,
  PieChartOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useAnalysisStore, useRemoteStore, useSettingsStore, FolderAnalysisResult } from '../../stores';
import { useThemeColors } from '../../hooks';
import { useTranslation } from 'react-i18next';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';
import { isRemotePath, getPathName } from '../../utils/format';
import { getAIService } from '../../services/aiService';
import { AiInsightCard } from './AiInsightCard';

const { Text, Title } = Typography;

interface AnalysisProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

export const FolderAnalysisTab: React.FC = () => {
  const {
    folderAnalysis,
    folderAnalysisLoading,
    folderAnalysisPath,
    setFolderAnalysisPath,
    clearFolderAnalysis,
  } = useAnalysisStore();
  const { connections } = useRemoteStore();
  const { settings } = useSettingsStore();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [aiInsight, setAiInsight] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const isAIConfigured = Boolean(
    settings.aiConfig.apiKey || settings.aiConfig.provider === 'ollama'
  );

  // 监听分析进度事件
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    
    const setupListener = async () => {
      unlisten = await listen<AnalysisProgress>('analysis-progress', (event) => {
        const payload = event.payload;
        const stageKey = `progress.${payload.stage}`;
        setProgress({
          ...payload,
          message: t(stageKey, { defaultValue: payload.message }),
        });
      });
    };
    
    setupListener();
    
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [t]);

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('analysis.folder.dialogSelectFolder'),
      });
      
      if (selected) {
        setFolderAnalysisPath(selected as string);
      }
    } catch (err) {
      console.error('select directory failed:', err);
    }
  };

  const [activeJobId, setActiveJobId] = useState(0);
  const [verifyByHash, setVerifyByHash] = useState<
    Record<string, { confirmed: boolean; hash: string; loading?: boolean }>
  >({});

  const runFolderAnalysis = useAnalysisStore((s) => s.runFolderAnalysis);

  const handleAnalyze = async () => {
    if (!folderAnalysisPath) return;

    setProgress(null);
    setAiInsight('');
    try {
      await runFolderAnalysis();
      setProgress(null);
      setActiveJobId(0);
      const result = useAnalysisStore.getState().folderAnalysis;
      if (result?.truncated) {
        message.warning(t('analysis.folder.truncatedWarning'));
      }
    } catch (err) {
      console.error('analyze failed:', err);
      setProgress(null);
      setActiveJobId(0);
      message.error(t('analysis.folder.analyzeFailed', { error: mapBackendError(err) }));
    }
  };

  const handleCancelAnalyze = async () => {
    try {
      await invoke('cancel_analysis', { jobId: activeJobId > 0 ? activeJobId : null });
    } catch {
      // ignore
    }
  };

  const buildFolderStatsPayload = (result: FolderAnalysisResult) => {
    const reclaimableFromDupes = result.duplicateGroups.reduce(
      (sum, g) => sum + g.size * Math.max(0, g.files.length - 1),
      0
    );
    return {
      path: result.path,
      totalSize: result.totalSizeFormatted,
      totalFiles: result.totalFiles,
      totalDirs: result.totalDirs,
      truncated: Boolean(result.truncated),
      topFileTypes: result.fileTypeStats.slice(0, 8).map((s) => ({
        extension: s.extension,
        count: s.count,
        totalSize: s.totalSize,
      })),
      largeFiles: result.largeFiles.slice(0, 8).map((f) => ({
        name: f.name,
        size: f.sizeFormatted,
      })),
      duplicateGroups: result.duplicateGroups.slice(0, 8).map((g) => ({
        copies: g.files.length,
        size: g.sizeFormatted,
        samplePaths: g.files.slice(0, 3),
      })),
      estimatedDuplicateWasteBytes: reclaimableFromDupes,
      oldFiles: result.oldFiles.slice(0, 8).map((f) => ({
        name: f.name,
        size: f.sizeFormatted,
        daysUnmodified: f.lastModifiedDays ?? f.lastAccessedDays ?? 0,
      })),
    };
  };

  const handleAiInsight = async () => {
    if (!folderAnalysis) return;
    if (!isAIConfigured) {
      message.error(t('analysis.folder.aiInsightNeedConfig'));
      return;
    }
    setAiLoading(true);
    try {
      const ai = getAIService(settings.aiConfig);
      const text = await ai.interpretFolderAnalysis(
        JSON.stringify(buildFolderStatsPayload(folderAnalysis), null, 2)
      );
      setAiInsight(text);
    } catch (err) {
      message.error(
        t('analysis.folder.aiInsightFailed', { error: mapBackendError(err) })
      );
    } finally {
      setAiLoading(false);
    }
  };

  // 类型分布表格列
  const typeColumns = [
    {
      title: t('analysis.folder.colFileType'),
      dataIndex: 'extension',
      key: 'extension',
      render: (ext: string) => (
        <Tag color={colors.accentBlue}>.{ext}</Tag>
      ),
    },
    {
      title: t('analysis.folder.colFileCount'),
      dataIndex: 'count',
      key: 'count',
      sorter: (a: any, b: any) => a.count - b.count,
    },
    {
      title: t('analysis.folder.colSpaceUsed'),
      dataIndex: 'totalSize',
      key: 'totalSize',
      render: (size: number) => formatSize(size),
      sorter: (a: any, b: any) => a.totalSize - b.totalSize,
    },
  ];

  // 大文件表格列
  const largeFileColumns = [
    {
      title: t('analysis.folder.colFileName'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, record: any) => (
        <Tooltip title={record.path}>
          <Text ellipsis style={{ maxWidth: 200 }}>{name}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('analysis.folder.colSize'),
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
  ];

  // 重复文件表格列
  const handleVerifyGroup = async (hash: string, paths: string[]) => {
    setVerifyByHash((m) => ({ ...m, [hash]: { confirmed: false, hash: '', loading: true } }));
    try {
      const result = await invoke<{ confirmed: boolean; hash: string }>('verify_duplicate_files', {
        paths,
      });
      setVerifyByHash((m) => ({
        ...m,
        [hash]: { confirmed: result.confirmed, hash: result.hash, loading: false },
      }));
      message.success(
        result.confirmed
          ? t('analysis.folder.verifyConfirmed')
          : t('analysis.folder.verifyMismatch')
      );
    } catch (err) {
      setVerifyByHash((m) => {
        const next = { ...m };
        delete next[hash];
        return next;
      });
      message.error(mapBackendError(err));
    }
  };

  const duplicateColumns = [
    {
      title: t('analysis.folder.colDuplicateSize'),
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
    {
      title: t('analysis.folder.colDuplicateCount'),
      dataIndex: 'files',
      key: 'count',
      render: (files: string[]) => (
        <Tag color="orange">{t('analysis.folder.duplicateCountTag', { count: files.length })}</Tag>
      ),
    },
    {
      title: t('analysis.folder.colReclaimable'),
      key: 'waste',
      render: (_: any, record: any) => (
        <Text type="danger">
          {formatSize(record.size * (record.files.length - 1))}
        </Text>
      ),
    },
    {
      title: t('analysis.folder.colVerify'),
      key: 'verify',
      width: 200,
      render: (_: unknown, record: { hash: string; files: string[] }) => {
        const v = verifyByHash[record.hash];
        return (
          <Space direction="vertical" size={2}>
            <Button
              size="small"
              loading={v?.loading}
              onClick={() => void handleVerifyGroup(record.hash, record.files)}
            >
              {t('analysis.folder.verifyHashes')}
            </Button>
            {v && !v.loading ? (
              <Tag color={v.confirmed ? 'success' : 'error'}>
                {v.confirmed
                  ? t('analysis.folder.verifyConfirmedShort')
                  : t('analysis.folder.verifyMismatchShort')}
              </Tag>
            ) : null}
          </Space>
        );
      },
    },
  ];

  // 旧文件表格列
  const oldFileColumns = [
    {
      title: t('analysis.folder.colFileName'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, record: any) => (
        <Tooltip title={record.path}>
          <Text ellipsis style={{ maxWidth: 200 }}>{name}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('analysis.folder.colSize'),
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
    {
      title: t('analysis.folder.colDaysUnmodified'),
      dataIndex: 'lastModifiedDays',
      key: 'days',
      render: (days: number, record: { lastModifiedDays?: number; lastAccessedDays?: number }) => {
        const value = days ?? record.lastModifiedDays ?? record.lastAccessedDays ?? 0;
        return (
          <Tag color={value > 365 ? 'red' : 'orange'}>{t('analysis.folder.daysTag', { days: value })}</Tag>
        );
      },
    },
  ];

  const formatSize = (size: number) => {
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    
    if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
    if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
    if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
    return `${size} B`;
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      {/* 操作栏 */}
      <Space style={{ marginBottom: 24 }} size="middle">
        <Dropdown
          menu={{
            items: [
              {
                key: 'local',
                label: t('analysis.folder.localFolder'),
                icon: <FolderOpenOutlined />,
                onClick: handleSelectFolder,
              },
              {
                key: 'remote',
                label: t('analysis.folder.remoteFolder'),
                icon: <CloudServerOutlined />,
                onClick: () => setShowRemoteSelector(true),
                disabled: connections.length === 0,
              },
            ],
          }}
        >
          <Button size="large">
            <Space>
              {folderAnalysisPath ? (
                isRemotePath(folderAnalysisPath) ? (
                  <CloudServerOutlined style={{ color: colors.accentPurple }} />
                ) : (
                  <FolderOpenOutlined style={{ color: colors.accentOrange }} />
                )
              ) : (
                <FolderOpenOutlined />
              )}
              {folderAnalysisPath ? (
                <Text ellipsis style={{ maxWidth: 200 }}>
                  {getPathName(folderAnalysisPath)}
                </Text>
              ) : (
                t('analysis.folder.selectFolder')
              )}
              <DownOutlined style={{ fontSize: 10 }} />
            </Space>
          </Button>
        </Dropdown>
        
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          size="large"
          onClick={handleAnalyze}
          loading={folderAnalysisLoading}
          disabled={!folderAnalysisPath}
        >
          {t('analysis.folder.startAnalyze')}
        </Button>

        {folderAnalysisLoading && (
          <Button danger onClick={() => void handleCancelAnalyze()}>
            {t('common.cancel')}
          </Button>
        )}
        
        {folderAnalysis && (
          <Button
            onClick={() => {
              setAiInsight('');
              clearFolderAnalysis();
            }}
          >
            {t('analysis.folder.clearResults')}
          </Button>
        )}
      </Space>

      {/* 分析结果 */}
      {folderAnalysisLoading ? (
        <Card
          style={{
            textAlign: 'center',
            padding: '60px 40px',
            background: colors.bgCard,
          }}
        >
          <LoadingOutlined style={{ fontSize: 48, color: colors.accentBlue, marginBottom: 24 }} />
          <div style={{ marginBottom: 24 }}>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {progress?.message || t('analysis.folder.progressDefault')}
            </Title>
          </div>
          {progress && progress.total > 0 && (
            <div style={{ maxWidth: 400, margin: '0 auto' }}>
              <Progress
                percent={Math.round((progress.current / progress.total) * 100)}
                status="active"
                strokeColor={{
                  '0%': colors.accentBlue,
                  '100%': colors.accentGreen,
                }}
              />
              <Text type="secondary" style={{ marginTop: 8, display: 'block' }}>
                {t('analysis.folder.progressFiles', {
                  current: progress.current.toLocaleString(),
                  total: progress.total.toLocaleString(),
                })}
              </Text>
            </div>
          )}
          {(!progress || progress.total === 0) && (
            <Text type="secondary">{t('analysis.folder.countingFiles')}</Text>
          )}
        </Card>
      ) : folderAnalysis ? (
        <div>
          {/* 总览统计 */}
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title={t('analysis.folder.statTotalSize')}
                  value={folderAnalysis.totalSizeFormatted}
                  prefix={<PieChartOutlined style={{ color: colors.accentBlue }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title={t('analysis.folder.statFileCount')}
                  value={folderAnalysis.totalFiles}
                  prefix={<FileOutlined style={{ color: colors.accentGreen }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title={t('analysis.folder.statFolderCount')}
                  value={folderAnalysis.totalDirs}
                  prefix={<FolderOpenOutlined style={{ color: colors.accentOrange }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title={t('analysis.folder.statDuplicateGroups')}
                  value={folderAnalysis.duplicateGroups.length}
                  prefix={<CopyOutlined style={{ color: colors.accentPurple }} />}
                />
              </Card>
            </Col>
          </Row>

          <AiInsightCard
            i18nPrefix="analysis.folder"
            isConfigured={isAIConfigured}
            loading={aiLoading}
            insight={aiInsight}
            onGenerate={handleAiInsight}
          />

          {/* 详细分析表格 */}
          <Row gutter={16}>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <PieChartOutlined style={{ color: colors.accentBlue }} />
                    <span>{t('analysis.folder.sectionTypeDistribution')}</span>
                  </Space>
                }
                style={{ marginBottom: 16, background: colors.bgCard }}
                size="small"
              >
                <Table
                  dataSource={folderAnalysis.fileTypeStats.slice(0, 10)}
                  columns={typeColumns}
                  pagination={false}
                  size="small"
                  rowKey="extension"
                />
              </Card>
            </Col>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <ThunderboltOutlined style={{ color: colors.accentOrange }} />
                    <span>{t('analysis.folder.sectionLargeFiles')}</span>
                  </Space>
                }
                style={{ marginBottom: 16, background: colors.bgCard }}
                size="small"
              >
                <Table
                  dataSource={folderAnalysis.largeFiles.slice(0, 10)}
                  columns={largeFileColumns}
                  pagination={false}
                  size="small"
                  rowKey="path"
                />
              </Card>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <CopyOutlined style={{ color: colors.accentPurple }} />
                    <Tooltip title={t('analysis.folder.duplicateHeuristicHint')}>
                      <span>{t('analysis.folder.sectionDuplicates')}</span>
                    </Tooltip>
                  </Space>
                }
                style={{ marginBottom: 16, background: colors.bgCard }}
                size="small"
              >
                {folderAnalysis.duplicateGroups.length > 0 ? (
                  <Table
                    dataSource={folderAnalysis.duplicateGroups.slice(0, 10)}
                    columns={duplicateColumns}
                    pagination={false}
                    size="small"
                    rowKey="hash"
                    expandable={{
                      expandedRowRender: (record) => (
                        <div style={{ padding: '8px 0' }}>
                          {record.files.map((file: string, index: number) => (
                            <div key={index}>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {file}
                              </Text>
                            </div>
                          ))}
                        </div>
                      ),
                    }}
                  />
                ) : (
                  <Empty description={t('analysis.folder.emptyNoDuplicates')} />
                )}
              </Card>
            </Col>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <ClockCircleOutlined style={{ color: colors.accentGreen }} />
                    <span>{t('analysis.folder.sectionOldFiles')}</span>
                  </Space>
                }
                style={{ marginBottom: 16, background: colors.bgCard }}
                size="small"
              >
                {folderAnalysis.oldFiles.length > 0 ? (
                  <Table
                    dataSource={folderAnalysis.oldFiles.slice(0, 10)}
                    columns={oldFileColumns}
                    pagination={false}
                    size="small"
                    rowKey="path"
                  />
                ) : (
                  <Empty description={t('analysis.folder.emptyNoOldFiles')} />
                )}
              </Card>
            </Col>
          </Row>
        </div>
      ) : (
        <Empty
          image={<PieChartOutlined style={{ fontSize: 64, color: colors.border }} />}
          description={
            <Space direction="vertical">
              <Text type="secondary">{t('analysis.folder.emptySelectFolder')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('analysis.folder.emptyHint')}
              </Text>
            </Space>
          }
          style={{ padding: 80 }}
        />
      )}

      {/* 远程目录选择器 */}
      <RemoteFolderSelector
        open={showRemoteSelector}
        onClose={() => setShowRemoteSelector(false)}
        onSelect={(path) => setFolderAnalysisPath(path)}
      />
    </div>
  );
};
