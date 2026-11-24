import React, { useMemo } from 'react';
import {
  Typography,
  Space,
  Button,
  Table,
  Tag,
  Progress,
  Empty,
  Tooltip,
} from 'antd';
import {
  UnorderedListOutlined,
  StopOutlined,
  DeleteOutlined,
  ClearOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useTaskStore, type AppTask, type TaskStatus } from '../../stores/taskStore';
import {
  useTransferStore,
  useSearchStore,
  useAnalysisStore,
  type ConflictResolution,
} from '../../stores';
import { useThemeColors } from '../../hooks';

const { Title, Text } = Typography;

const statusColor = (s: TaskStatus): string => {
  switch (s) {
    case 'running':
    case 'queued':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'default';
    default:
      return 'default';
  }
};

export const TaskCenter: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { tasks, cancelTask, clearFinished, removeTask } = useTaskStore();

  const activeCount = useMemo(
    () => tasks.filter((x) => x.status === 'running' || x.status === 'queued').length,
    [tasks]
  );

  const retryTask = (row: AppTask) => {
    const p = row.retryPayload;
    if (!p || typeof p.action !== 'string') return;

    switch (p.action) {
      case 'transfer': {
        const {
          setTargetPath,
          clearSourceItems,
          addSourceItems,
          startTransfer,
        } = useTransferStore.getState();
        if (typeof p.targetPath === 'string') {
          setTargetPath(p.targetPath);
        }
        if (Array.isArray(p.sourcePaths) && p.sourcePaths.length > 0) {
          clearSourceItems();
          addSourceItems(
            (p.sourcePaths as string[]).map((sourcePath) => {
              const name = sourcePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || sourcePath;
              return {
                id: Math.random().toString(36).slice(2, 11),
                sourcePath,
                fileName: name,
                fileType: 'file' as const,
                size: 0,
                sizeFormatted: '—',
              };
            })
          );
        }
        void startTransfer((p.resolution as ConflictResolution) || 'skip');
        break;
      }
      case 'search': {
        const store = useSearchStore.getState();
        if (typeof p.query === 'string') store.setQuery(p.query);
        if (Array.isArray(p.searchPaths)) store.setSearchPaths(p.searchPaths as string[]);
        store.setMode('normal');
        void store.search();
        break;
      }
      case 'checkKeywords': {
        const store = useSearchStore.getState();
        if (typeof p.query === 'string') store.setQuery(p.query);
        if (Array.isArray(p.searchPaths)) store.setSearchPaths(p.searchPaths as string[]);
        store.setMode('keyword-check');
        void store.checkKeywords();
        break;
      }
      case 'analyzeFolder': {
        const store = useAnalysisStore.getState();
        if (typeof p.path === 'string') store.setFolderAnalysisPath(p.path);
        void store.runFolderAnalysis();
        break;
      }
      default:
        break;
    }
  };

  const columns = [
    {
      title: t('tasks.colKind'),
      dataIndex: 'kind',
      width: 100,
      render: (kind: string) => t(`tasks.kind.${kind}`, { defaultValue: kind }),
    },
    {
      title: t('tasks.colTitle'),
      dataIndex: 'title',
      ellipsis: true,
    },
    {
      title: t('tasks.colStatus'),
      dataIndex: 'status',
      width: 110,
      render: (status: TaskStatus) => (
        <Tag color={statusColor(status)}>{t(`tasks.status.${status}`)}</Tag>
      ),
    },
    {
      title: t('tasks.colProgress'),
      width: 180,
      render: (_: unknown, row: AppTask) => {
        if (row.status === 'running' || row.status === 'queued') {
          const pct = row.progress.percentage || 0;
          return (
            <div>
              <Progress
                percent={pct}
                size="small"
                status={row.status === 'queued' ? 'normal' : 'active'}
              />
              {row.progress.message ? (
                <Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                  {row.progress.message}
                </Text>
              ) : null}
            </div>
          );
        }
        return row.progress.percentage ? `${row.progress.percentage}%` : '—';
      },
    },
    {
      title: t('tasks.colStarted'),
      dataIndex: 'startedAt',
      width: 150,
      render: (ts: number) => new Date(ts).toLocaleString(),
    },
    {
      title: t('tasks.colActions'),
      width: 150,
      render: (_: unknown, row: AppTask) => (
        <Space>
          {(row.status === 'running' || row.status === 'queued') && row.cancellable ? (
            <Tooltip title={t('tasks.cancel')}>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                onClick={() => void cancelTask(row.id)}
              />
            </Tooltip>
          ) : row.status === 'failed' && row.retryPayload ? (
            <>
              <Tooltip title={t('tasks.retry')}>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => retryTask(row)}
                />
              </Tooltip>
              <Tooltip title={t('tasks.remove')}>
                <Button
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => removeTask(row.id)}
                />
              </Tooltip>
            </>
          ) : (
            <Tooltip title={t('tasks.remove')}>
              <Button
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => removeTask(row.id)}
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bgPrimary,
      }}
    >
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <Space>
          <UnorderedListOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <div>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('tasks.title')}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('tasks.activeCount', { count: activeCount })}
            </Text>
          </div>
        </Space>
        <Button icon={<ClearOutlined />} onClick={clearFinished}>
          {t('tasks.clearFinished')}
        </Button>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: 24, overflow: 'hidden' }}>
        {tasks.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('tasks.empty')}
            style={{ marginTop: 80 }}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            dataSource={tasks}
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ y: 'calc(100vh - 220px)' }}
            style={{
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
            }}
          />
        )}
      </div>
    </div>
  );
};
