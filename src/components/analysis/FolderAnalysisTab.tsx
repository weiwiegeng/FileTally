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
} from 'antd';
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
import { useAnalysisStore, useRemoteStore, FolderAnalysisResult } from '../../stores';
import { useThemeColors } from '../../hooks';
import { RemoteFolderSelector } from '../search/RemoteFolderSelector';

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
    analyzeFolderStart,
    analyzeFolderSuccess,
    analyzeFolderError,
    clearFolderAnalysis,
  } = useAnalysisStore();
  const { connections } = useRemoteStore();
  const colors = useThemeColors();
  const [showRemoteSelector, setShowRemoteSelector] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);

  // 监听分析进度事件
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    
    const setupListener = async () => {
      unlisten = await listen<AnalysisProgress>('analysis-progress', (event) => {
        setProgress(event.payload);
      });
    };
    
    setupListener();
    
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择要分析的文件夹',
      });
      
      if (selected) {
        setFolderAnalysisPath(selected as string);
      }
    } catch (err) {
      console.error('选择目录失败:', err);
    }
  };

  const handleAnalyze = async () => {
    if (!folderAnalysisPath) return;
    
    setProgress(null);
    analyzeFolderStart();
    try {
      const result = await invoke<FolderAnalysisResult>('analyze_folder', {
        path: folderAnalysisPath,
        largeFileThresholdMb: 100, // 100MB以上算大文件
        oldFileDays: 180, // 180天未修改算旧文件
      });
      analyzeFolderSuccess(result);
      setProgress(null);
    } catch (err) {
      console.error('分析失败:', err);
      analyzeFolderError();
      setProgress(null);
    }
  };

  // 类型分布表格列
  const typeColumns = [
    {
      title: '文件类型',
      dataIndex: 'extension',
      key: 'extension',
      render: (ext: string) => (
        <Tag color={colors.accentBlue}>.{ext}</Tag>
      ),
    },
    {
      title: '文件数量',
      dataIndex: 'count',
      key: 'count',
      sorter: (a: any, b: any) => a.count - b.count,
    },
    {
      title: '占用空间',
      dataIndex: 'totalSize',
      key: 'totalSize',
      render: (size: number) => formatSize(size),
      sorter: (a: any, b: any) => a.totalSize - b.totalSize,
    },
  ];

  // 大文件表格列
  const largeFileColumns = [
    {
      title: '文件名',
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
      title: '大小',
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
  ];

  // 重复文件表格列
  const duplicateColumns = [
    {
      title: '文件大小',
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
    {
      title: '重复数量',
      dataIndex: 'files',
      key: 'count',
      render: (files: string[]) => (
        <Tag color="orange">{files.length} 份</Tag>
      ),
    },
    {
      title: '可释放空间',
      key: 'waste',
      render: (_: any, record: any) => (
        <Text type="danger">
          {formatSize(record.size * (record.files.length - 1))}
        </Text>
      ),
    },
  ];

  // 旧文件表格列
  const oldFileColumns = [
    {
      title: '文件名',
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
      title: '大小',
      dataIndex: 'sizeFormatted',
      key: 'size',
    },
    {
      title: '未修改天数',
      dataIndex: 'lastAccessedDays',
      key: 'days',
      render: (days: number) => (
        <Tag color={days > 365 ? 'red' : 'orange'}>{days} 天</Tag>
      ),
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
                label: '本地文件夹',
                icon: <FolderOpenOutlined />,
                onClick: handleSelectFolder,
              },
              {
                key: 'remote',
                label: '远程文件夹',
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
                folderAnalysisPath.startsWith('/Volumes/') ? (
                  <CloudServerOutlined style={{ color: colors.accentPurple }} />
                ) : (
                  <FolderOpenOutlined style={{ color: colors.accentOrange }} />
                )
              ) : (
                <FolderOpenOutlined />
              )}
              {folderAnalysisPath ? (
                <Text ellipsis style={{ maxWidth: 200 }}>
                  {folderAnalysisPath.split('/').pop()}
                </Text>
              ) : (
                '选择文件夹'
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
          开始分析
        </Button>
        
        {folderAnalysis && (
          <Button onClick={clearFolderAnalysis}>
            清除结果
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
              {progress?.message || '正在分析文件夹...'}
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
                已处理 {progress.current.toLocaleString()} / {progress.total.toLocaleString()} 个文件
              </Text>
            </div>
          )}
          {(!progress || progress.total === 0) && (
            <Text type="secondary">正在统计文件数量...</Text>
          )}
        </Card>
      ) : folderAnalysis ? (
        <div>
          {/* 总览统计 */}
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title="总大小"
                  value={folderAnalysis.totalSizeFormatted}
                  prefix={<PieChartOutlined style={{ color: colors.accentBlue }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title="文件数量"
                  value={folderAnalysis.totalFiles}
                  prefix={<FileOutlined style={{ color: colors.accentGreen }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title="文件夹数量"
                  value={folderAnalysis.totalDirs}
                  prefix={<FolderOpenOutlined style={{ color: colors.accentOrange }} />}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card style={{ background: colors.bgCard }}>
                <Statistic
                  title="重复文件组"
                  value={folderAnalysis.duplicateGroups.length}
                  prefix={<CopyOutlined style={{ color: colors.accentPurple }} />}
                />
              </Card>
            </Col>
          </Row>

          {/* 详细分析表格 */}
          <Row gutter={16}>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <PieChartOutlined style={{ color: colors.accentBlue }} />
                    <span>文件类型分布</span>
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
                    <span>大文件 TOP 10</span>
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
                    <span>重复文件</span>
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
                  <Empty description="未发现重复文件" />
                )}
              </Card>
            </Col>
            <Col span={12}>
              <Card
                title={
                  <Space>
                    <ClockCircleOutlined style={{ color: colors.accentGreen }} />
                    <span>长期未修改文件</span>
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
                  <Empty description="没有超过180天未修改的文件" />
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
              <Text type="secondary">选择一个文件夹开始分析</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                分析文件类型分布、大文件、重复文件、旧文件等
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
