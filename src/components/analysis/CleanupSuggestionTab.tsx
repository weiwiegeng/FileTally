import React, { useState } from 'react';
import {
  Button,
  Space,
  Typography,
  Card,
  Statistic,
  Row,
  Col,
  Empty,
  Spin,
  Tooltip,
  Tag,
  List,
  message,
  Checkbox,
  Modal,
} from 'antd';
import { mapBackendError } from '../../utils/backendError';
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
import { useAnalysisStore, useSettingsStore, CleanupSuggestion, CleanupItem } from '../../stores';
import { useThemeColors } from '../../hooks';
import { useTranslation } from 'react-i18next';
import { getAIService } from '../../services/aiService';
import { AiInsightCard } from './AiInsightCard';

const { Text } = Typography;

export const CleanupSuggestionTab: React.FC = () => {
  const {
    cleanupSuggestion,
    cleanupLoading,
    scanCleanupStart,
    scanCleanupSuccess,
    scanCleanupError,
    clearCleanupSuggestion,
  } = useAnalysisStore();
  const { settings } = useSettingsStore();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [aiInsight, setAiInsight] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ toTrash: boolean } | null>(null);
  const isAIConfigured = Boolean(
    settings.aiConfig.apiKey || settings.aiConfig.provider === 'ollama'
  );

  const handleScan = async () => {
    setAiInsight('');
    scanCleanupStart();
    try {
      const result = await invoke<CleanupSuggestion>('scan_cleanup_suggestions');
      scanCleanupSuccess(result);
    } catch (err) {
      console.error('cleanup scan failed:', err);
      scanCleanupError();
      message.error(t('analysis.cleanup.scanFailed', { error: mapBackendError(err) }));
    }
  };

  const buildCleanupPayload = (result: CleanupSuggestion) => ({
    totalCleanableSize: result.totalCleanableSizeFormatted,
    cache: {
      count: result.cacheFiles.length,
      items: result.cacheFiles.slice(0, 8).map((i) => ({
        name: i.name,
        size: i.sizeFormatted,
        description: i.description,
      })),
    },
    temp: {
      count: result.tempFiles.length,
      items: result.tempFiles.slice(0, 8).map((i) => ({
        name: i.name,
        size: i.sizeFormatted,
        description: i.description,
      })),
    },
    downloads: {
      count: result.downloadFiles.length,
      items: result.downloadFiles.slice(0, 8).map((i) => ({
        name: i.name,
        size: i.sizeFormatted,
        description: i.description,
      })),
    },
    logs: {
      count: result.logFiles.length,
      items: result.logFiles.slice(0, 8).map((i) => ({
        name: i.name,
        size: i.sizeFormatted,
        description: i.description,
      })),
    },
  });

  const handleAiInsight = async () => {
    if (!cleanupSuggestion) return;
    if (!isAIConfigured) {
      message.error(t('analysis.cleanup.aiInsightNeedConfig'));
      return;
    }
    setAiLoading(true);
    try {
      const ai = getAIService(settings.aiConfig);
      const text = await ai.interpretCleanupSuggestion(
        JSON.stringify(buildCleanupPayload(cleanupSuggestion), null, 2)
      );
      setAiInsight(text);
    } catch (err) {
      message.error(
        t('analysis.cleanup.aiInsightFailed', { error: mapBackendError(err) })
      );
    } finally {
      setAiLoading(false);
    }
  };

  const describeItem = (description: string) => {
    const key = `analysis.cleanup.desc.${description}`;
    return t(key, { defaultValue: description });
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

  const togglePath = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const toggleCategoryAll = (items: CleanupItem[], checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      items.forEach((i) => {
        if (checked) next.add(i.path);
        else next.delete(i.path);
      });
      return next;
    });
  };

  const runDelete = async (toTrash: boolean) => {
    const paths = Array.from(selectedPaths);
    if (!paths.length) return;
    setDeleteLoading(true);
    try {
      const result = await invoke<{ deleted: number; failed: number; errors: string[] }>(
        'delete_cleanup_items',
        { paths, toTrash }
      );
      message.success(
        t('analysis.cleanup.deleteDone', { deleted: result.deleted, failed: result.failed })
      );
      setSelectedPaths(new Set());
      await handleScan();
    } catch (err) {
      message.error(mapBackendError(err));
    } finally {
      setDeleteLoading(false);
      setPendingDelete(null);
    }
  };

  const handleUndo = async () => {
    setDeleteLoading(true);
    try {
      const result = await invoke<{ restored: number; failed: number }>('undo_cleanup_delete');
      message.success(t('analysis.cleanup.undoDone', { restored: result.restored, failed: result.failed }));
      await handleScan();
    } catch (err) {
      message.error(mapBackendError(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  const renderCleanupList = (items: CleanupItem[], category: string, title: string, icon: React.ReactNode) => {
    if (items.length === 0) return null;
    
    const totalSize = calculateCategorySize(items);
    
    return (
      <Card
        title={
          <Space>
            <Checkbox
              checked={items.length > 0 && items.every((i) => selectedPaths.has(i.path))}
              indeterminate={
                items.some((i) => selectedPaths.has(i.path)) &&
                !items.every((i) => selectedPaths.has(i.path))
              }
              onChange={(e) => toggleCategoryAll(items, e.target.checked)}
            />
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
              <Checkbox
                checked={selectedPaths.has(item.path)}
                onChange={(e) => togglePath(item.path, e.target.checked)}
                style={{ marginRight: 8 }}
              />
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
                      {describeItem(item.description)}
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
          {t('analysis.cleanup.scanSystem')}
        </Button>
        
        {cleanupSuggestion && (
          <>
            <Button icon={<ReloadOutlined />} onClick={handleScan}>
              {t('analysis.cleanup.rescan')}
            </Button>
            <Button
              onClick={() => {
                setAiInsight('');
                setSelectedPaths(new Set());
                clearCleanupSuggestion();
              }}
            >
              {t('analysis.cleanup.clearResults')}
            </Button>
            <Button
              disabled={selectedPaths.size === 0}
              loading={deleteLoading}
              onClick={() => setPendingDelete({ toTrash: true })}
            >
              {t('analysis.cleanup.moveToTrash')}
            </Button>
            <Button
              danger
              disabled={selectedPaths.size === 0}
              loading={deleteLoading}
              onClick={() => setPendingDelete({ toTrash: false })}
            >
              {t('analysis.cleanup.deletePermanent')}
            </Button>
            <Button onClick={() => void handleUndo()} loading={deleteLoading}>
              {t('analysis.cleanup.undoLast')}
            </Button>
            {selectedPaths.size > 0 && (
              <Tag color="blue">
                {t('analysis.cleanup.selectedCount', { count: selectedPaths.size })}
              </Tag>
            )}
          </>
        )}
      </Space>

      <Modal
        open={pendingDelete !== null}
        title={
          pendingDelete?.toTrash
            ? t('analysis.cleanup.confirmTrashTitle')
            : t('analysis.cleanup.confirmPermanentTitle')
        }
        okText={t('analysis.cleanup.confirmOk')}
        cancelText={t('analysis.cleanup.confirmCancel')}
        okButtonProps={{ danger: !pendingDelete?.toTrash, loading: deleteLoading }}
        onCancel={() => setPendingDelete(null)}
        onOk={() => {
          if (pendingDelete) void runDelete(pendingDelete.toTrash);
        }}
      >
        <Text>
          {pendingDelete?.toTrash
            ? t('analysis.cleanup.confirmTrashBody', { count: selectedPaths.size })
            : t('analysis.cleanup.confirmPermanentBody', { count: selectedPaths.size })}
        </Text>
      </Modal>

      {/* 扫描结果 */}
      {cleanupLoading ? (
        <div style={{ textAlign: 'center', padding: 100 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">{t('analysis.cleanup.scanning')}</Text>
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
                  title={<Text style={{ color: colors.textSecondary }}>{t('analysis.cleanup.statReclaimable')}</Text>}
                  value={cleanupSuggestion.totalCleanableSizeFormatted}
                  valueStyle={{ color: colors.accentGreen, fontSize: 32 }}
                  prefix={<ClearOutlined />}
                />
              </Col>
              <Col span={16}>
                <Row gutter={16}>
                  <Col span={6}>
                    <Statistic
                      title={t('analysis.cleanup.statCache')}
                      value={cleanupSuggestion.cacheFiles.length}
                      suffix={t('analysis.cleanup.suffixItems')}
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title={t('analysis.cleanup.statTemp')}
                      value={cleanupSuggestion.tempFiles.length}
                      suffix={t('analysis.cleanup.suffixItems')}
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title={t('analysis.cleanup.statDownloads')}
                      value={cleanupSuggestion.downloadFiles.length}
                      suffix={t('analysis.cleanup.suffixItems')}
                      valueStyle={{ fontSize: 20 }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title={t('analysis.cleanup.statLogs')}
                      value={cleanupSuggestion.logFiles.length}
                      suffix={t('analysis.cleanup.suffixItems')}
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
              {t('analysis.cleanup.warning')}
            </Text>
          </Card>

          <AiInsightCard
            i18nPrefix="analysis.cleanup"
            isConfigured={isAIConfigured}
            loading={aiLoading}
            insight={aiInsight}
            onGenerate={handleAiInsight}
          />

          {/* 分类列表 */}
          <Row gutter={16}>
            <Col span={12}>
              {renderCleanupList(
                cleanupSuggestion.cacheFiles,
                'cache',
                t('analysis.cleanup.categoryCache'),
                <FolderOutlined style={{ color: colors.accentBlue }} />
              )}
              {renderCleanupList(
                cleanupSuggestion.tempFiles,
                'temp',
                t('analysis.cleanup.categoryTemp'),
                <DeleteOutlined style={{ color: colors.accentOrange }} />
              )}
            </Col>
            <Col span={12}>
              {renderCleanupList(
                cleanupSuggestion.downloadFiles,
                'download',
                t('analysis.cleanup.categoryDownloads'),
                <DownloadOutlined style={{ color: colors.accentGreen }} />
              )}
              {renderCleanupList(
                cleanupSuggestion.logFiles,
                'log',
                t('analysis.cleanup.categoryLogs'),
                <FileTextOutlined style={{ color: colors.accentPurple }} />
              )}
            </Col>
          </Row>

          {cleanupSuggestion.cacheFiles.length === 0 &&
           cleanupSuggestion.tempFiles.length === 0 &&
           cleanupSuggestion.downloadFiles.length === 0 &&
           cleanupSuggestion.logFiles.length === 0 && (
            <Empty description={t('analysis.cleanup.emptyClean')} />
          )}
        </div>
      ) : (
        <Empty
          image={<ClearOutlined style={{ fontSize: 64, color: colors.border }} />}
          description={
            <Space direction="vertical">
              <Text type="secondary">{t('analysis.cleanup.emptyStartTitle')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('analysis.cleanup.emptyStartHint')}
              </Text>
            </Space>
          }
          style={{ padding: 80 }}
        />
      )}
    </div>
  );
};
