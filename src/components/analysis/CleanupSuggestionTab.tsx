import React from 'react';
import {
  Button,
  Space,
  Typography,
  Table,
  Card,
  Statistic,
  Row,
  Col,
  Empty,
  Spin,
  Tooltip,
  Tag,
  List,
  Collapse,
} from 'antd';
import {
  DeleteOutlined,
  ThunderboltOutlined,
  FolderOutlined,
  FileOutlined,
  DownloadOutlined,
  FileTextOutlined,
  ClearOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useAnalysisStore, CleanupSuggestion, CleanupItem } from '../../stores';
import { useThemeColors } from '../../hooks';

const { Text, Title } = Typography;

export const CleanupSuggestionTab: React.FC = () => {
  const {
    cleanupSuggestion,
    cleanupLoading,
    scanCleanupStart,
    scanCleanupSuccess,
    scanCleanupError,
    clearCleanupSuggestion,
  } = useAnalysisStore();
  const colors = useThemeColors();

  const handleScan = async () => {
    scanCleanupStart();
    try {
      const result = await invoke<CleanupSuggestion>('scan_cleanup_suggestions');
      scanCleanupSuccess(result);
    } catch (err) {
      console.error('扫描失败:', err);
      scanCleanupError();
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'cache':
        return <FolderOutlined style={{ color: colors.accentBlue }} />;
      case 'temp':
        return <DeleteOutlined style={{ color: colors.accentOrange }} />;
      case 'download':
        return <DownloadOutlined style={{ color: colors.accentGreen }} />;
      case 'log':
        return <FileTextOutlined style={{ color: colors.accentPurple }} />;
      default:
        return <FileOutlined />;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'cache':
        return colors.accentBlue;
      case 'temp':
        return colors.accentOrange;
      case 'download':
        return colors.accentGreen;
      case 'log':
        return colors.accentPurple;
      default:
        return colors.textSecondary;
    }
  };

  const calculateCategorySize = (items: CleanupItem[]) => {
    return items.reduce((sum, item) => sum + item.size, 0);
  };

  const formatSize = (size: number) => {
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    
    if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
    if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
    if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
    return `${size} B`;
  };

  const renderCleanupList = (items: CleanupItem[], category: string, title: string, icon: React.ReactNode) => {
    if (items.length === 0) return null;
    
    const totalSize = calculateCategorySize(items);
    
    return (
      <Card
        title={
          <Space>
            {icon}
            <span>{title}</span>
            <Tag color={getCategoryColor(category)}>{formatSize(totalSize)}</Tag>
          </Space>
        }
        style={{ marginBottom: 16, background: colors.bgCard }}
        size="small"
      >
        <List
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{
                padding: '8px 0',
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <List.Item.Meta
                avatar={getCategoryIcon(item.category)}
                title={
                  <Tooltip title={item.path}>
                    <Text ellipsis style={{ maxWidth: 300 }}>{item.name}</Text>
                  </Tooltip>
                }
                description={
                  <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {item.description}
                    </Text>
                    <Tag>{item.sizeFormatted}</Tag>
                  </Space>
                }
              />
            </List.Item>
          )}
          size="small"
        />
      </Card>
    );
  };

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      {/* 操作栏 */}
      <Space style={{ marginBottom: 24 }} size="middle">
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          size="large"
          onClick={handleScan}
          loading={cleanupLoading}
        >
          扫描系统
        </Button>
        
        {cleanupSuggestion && (
          <>
            <Button icon={<ReloadOutlined />} onClick={handleScan}>
              重新扫描
            </Button>
            <Button onClick={clearCleanupSuggestion}>
              清除结果
            </Button>
          </>
        )}
      </Space>

      {/* 扫描结果 */}
      {cleanupLoading ? (
        <div style={{ textAlign: 'center', padding: 100 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">正在扫描系统，请稍候...</Text>
          </div>
        </div>
      ) : cleanupSuggestion ? (
        <div>
          {/* 总览 */}
          <Card
            style={{
              marginBottom: 24,
              background: `linear-gradient(135deg, ${colors.accentGreen}22, ${colors.accentBlue}22)`,
              border: `1px solid ${colors.accentGreen}44`,
            }}
          >
            <Row gutter={16} align="middle">
              <Col span={8}>
                <Statistic
                  title={<Text style={{ color: colors.textSecondary }}>预计可释放空间</Text>}
                  value={cleanupSuggestion.totalCleanableSizeFormatted}
                  valueStyle={{ color: colors.accentGreen, fontSize: 32 }}
                  prefix={<ClearOutlined />}
                />
              </Col>
              <Col span={16}>
                <Row gutter={16}>
                  <Col span={6}>
                    <Statistic
                      title="缓存文件"
                      value={cleanupSuggestion.cacheFiles.length}
                      suffix="项"
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="临时文件"
                      value={cleanupSuggestion.tempFiles.length}
                      suffix="项"
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="下载残留"
                      value={cleanupSuggestion.downloadFiles.length}
                      suffix="项"
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="日志文件"
                      value={cleanupSuggestion.logFiles.length}
                      suffix="项"
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                </Row>
              </Col>
            </Row>
          </Card>

          {/* 注意提示 */}
          <Card
            style={{
              marginBottom: 24,
              background: colors.isDark ? 'rgba(250, 173, 20, 0.1)' : 'rgba(250, 173, 20, 0.05)',
              border: `1px solid rgba(250, 173, 20, 0.3)`,
            }}
            size="small"
          >
            <Text type="warning">
              注意：清理操作需谨慎，建议先查看文件内容确认后再手动删除。部分缓存文件删除后可能需要重新下载。
            </Text>
          </Card>

          {/* 分类列表 */}
          <Row gutter={16}>
            <Col span={12}>
              {renderCleanupList(
                cleanupSuggestion.cacheFiles,
                'cache',
                '应用缓存',
                <FolderOutlined style={{ color: colors.accentBlue }} />
              )}
              {renderCleanupList(
                cleanupSuggestion.tempFiles,
                'temp',
                '临时文件 / 废纸篓',
                <DeleteOutlined style={{ color: colors.accentOrange }} />
              )}
            </Col>
            <Col span={12}>
              {renderCleanupList(
                cleanupSuggestion.downloadFiles,
                'download',
                '下载文件夹 (30天未修改)',
                <DownloadOutlined style={{ color: colors.accentGreen }} />
              )}
              {renderCleanupList(
                cleanupSuggestion.logFiles,
                'log',
                '日志文件',
                <FileTextOutlined style={{ color: colors.accentPurple }} />
              )}
            </Col>
          </Row>

          {cleanupSuggestion.cacheFiles.length === 0 &&
           cleanupSuggestion.tempFiles.length === 0 &&
           cleanupSuggestion.downloadFiles.length === 0 &&
           cleanupSuggestion.logFiles.length === 0 && (
            <Empty description="系统很干净，没有发现需要清理的文件" />
          )}
        </div>
      ) : (
        <Empty
          image={<ClearOutlined style={{ fontSize: 64, color: colors.border }} />}
          description={
            <Space direction="vertical">
              <Text type="secondary">点击"扫描系统"开始检测可清理文件</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                检测缓存、临时文件、下载残留、日志等
              </Text>
            </Space>
          }
          style={{ padding: 80 }}
        />
      )}
    </div>
  );
};
