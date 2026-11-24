import React, { useEffect, useMemo, useState } from 'react';
import {
  Typography,
  Space,
  Button,
  Input,
  Switch,
  Table,
  message,
  Card,
  Form,
  Empty,
  Tag,
  Row,
  Col,
  Statistic,
} from 'antd';
import {
  SwapOutlined,
  FolderOpenOutlined,
  DiffOutlined,
  CloudSyncOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';
import { makeTaskId, useTaskStore } from '../../stores/taskStore';
import { formatSize } from '../../utils/format';

const { Title, Text } = Typography;

interface SyncFileEntry {
  relativePath: string;
  size: number;
  mtime: number;
}

interface SyncCompareResult {
  added: SyncFileEntry[];
  changed: SyncFileEntry[];
  extra: SyncFileEntry[];
}

export const SyncPanel: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { upsertTask, completeTask, updateProgress } = useTaskStore();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [deleteExtra, setDeleteExtra] = useState(false);
  const [diff, setDiff] = useState<SyncCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | 'added' | 'changed' | 'extra'>('all');
  const [comparedOnce, setComparedOnce] = useState(false);

  useEffect(() => {
    let u: UnlistenFn | undefined;
    void listen<{
      jobId: number;
      stage: string;
      current: number;
      total: number;
      message: string;
    }>('sync-progress', (e) => {
      const p = e.payload;
      const tasks = useTaskStore.getState().tasks;
      const task = tasks.find(
        (x) => x.kind === 'sync' && (x.backendJobId === p.jobId || x.status === 'running')
      );
      if (!task) return;
      if (p.stage === 'done' || p.stage === 'cancelled') {
        completeTask(task.id, p.stage === 'cancelled' ? 'cancelled' : 'completed');
        return;
      }
      updateProgress(task.id, {
        current: p.current,
        total: p.total,
        message: p.message,
        stage: p.stage,
        status: 'running',
      });
    }).then((fn) => {
      u = fn;
    });
    return () => {
      u?.();
    };
  }, [completeTask, updateProgress]);

  const pick = async (setter: (v: string) => void) => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setter(selected);
  };

  const compare = async () => {
    if (!source || !target) {
      message.warning(`${t('sync.source')} / ${t('sync.target')}`);
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<SyncCompareResult>('compare_sync', { source, dest: target });
      setDiff(result);
      setComparedOnce(true);
      setKindFilter('all');
    } catch (e) {
      message.error(mapBackendError(e));
    } finally {
      setLoading(false);
    }
  };

  const run = async () => {
    if (!source || !target) {
      message.warning(`${t('sync.source')} / ${t('sync.target')}`);
      return;
    }
    setLoading(true);
    let taskId = '';
    try {
      const jobId = await invoke<number>('prepare_sync');
      taskId = makeTaskId('sync', jobId);
      upsertTask({
        id: taskId,
        kind: 'sync',
        title: `${source} → ${target}`,
        status: 'running',
        backendJobId: jobId,
        progress: { current: 0, total: 0, percentage: 0 },
        startedAt: Date.now(),
        cancellable: true,
      });
      const result = await invoke<SyncCompareResult>('run_sync', {
        source,
        dest: target,
        deleteExtras: deleteExtra,
        jobId,
      });
      setDiff(result);
      completeTask(taskId, 'completed');
      message.success(t('sync.done'));
    } catch (e) {
      if (taskId) completeTask(taskId, 'failed', mapBackendError(e));
      message.error(mapBackendError(e));
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => {
    const all = [
      ...(diff?.added || []).map((x) => ({ ...x, kind: t('sync.added'), kindKey: 'added' as const })),
      ...(diff?.changed || []).map((x) => ({ ...x, kind: t('sync.changed'), kindKey: 'changed' as const })),
      ...(diff?.extra || []).map((x) => ({ ...x, kind: t('sync.extra'), kindKey: 'extra' as const })),
    ];
    if (kindFilter === 'all') return all;
    return all.filter((r) => r.kindKey === kindFilter);
  }, [diff, t, kindFilter]);

  const kindColor = (key: string) => {
    if (key === 'added') return 'green';
    if (key === 'changed') return 'gold';
    return 'red';
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: colors.bgPrimary }}>
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
          <SwapOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <div>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('sync.title')}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('sync.hint')}
            </Text>
          </div>
        </Space>
        <Space>
          <Button icon={<DiffOutlined />} loading={loading} onClick={() => void compare()}>
            {t('sync.compare')}
          </Button>
          <Button
            type="primary"
            icon={<CloudSyncOutlined />}
            loading={loading}
            onClick={() => void run()}
          >
            {t('sync.run')}
          </Button>
        </Space>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          overflow: 'hidden',
        }}
      >
        <Card
          size="small"
          style={{ background: colors.bgCard, borderColor: colors.border, flexShrink: 0 }}
          styles={{ body: { padding: 16 } }}
        >
          <Form layout="vertical">
            <Form.Item label={t('sync.source')} style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={t('sync.source')}
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => void pick(setSource)} />
              </Space.Compact>
            </Form.Item>
            <Form.Item label={t('sync.target')} style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder={t('sync.target')}
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => void pick(setTarget)} />
              </Space.Compact>
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Space>
                <Switch checked={deleteExtra} onChange={setDeleteExtra} />
                <Text>{t('sync.deleteExtra')}</Text>
              </Space>
            </Form.Item>
          </Form>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <span>{t('sync.compare')}</span>
              {rows.length > 0 && <Tag color="blue">{rows.length}</Tag>}
            </Space>
          }
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            background: colors.bgCard,
            borderColor: colors.border,
          }}
          styles={{
            body: {
              flex: 1,
              minHeight: 0,
              padding: rows.length ? 0 : 24,
              display: 'flex',
              flexDirection: 'column',
            },
          }}
        >
          {!comparedOnce ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('sync.emptyHint')}
              style={{ margin: 'auto' }}
            />
          ) : rows.length === 0 && kindFilter === 'all' && !diff?.added.length && !diff?.changed.length && !diff?.extra.length ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('sync.noDiff')}
              style={{ margin: 'auto' }}
            />
          ) : (
            <>
              <Row gutter={16} style={{ padding: '12px 16px', borderBottom: `1px solid ${colors.border}` }}>
                <Col span={8}>
                  <Statistic title={t('sync.added')} value={diff?.added.length || 0} />
                </Col>
                <Col span={8}>
                  <Statistic title={t('sync.changed')} value={diff?.changed.length || 0} />
                </Col>
                <Col span={8}>
                  <Statistic title={t('sync.extra')} value={diff?.extra.length || 0} />
                </Col>
              </Row>
              <div style={{ padding: '8px 16px', borderBottom: `1px solid ${colors.border}` }}>
                <Space wrap>
                  <Text type="secondary">{t('sync.filterKind')}</Text>
                  {(['all', 'added', 'changed', 'extra'] as const).map((k) => (
                    <Tag
                      key={k}
                      color={kindFilter === k ? 'blue' : 'default'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setKindFilter(k)}
                    >
                      {t(`sync.filter.${k}`)}
                    </Tag>
                  ))}
                </Space>
              </div>
              {rows.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('sync.filterEmpty')}
                  style={{ margin: '24px auto' }}
                />
              ) : (
                <Table
                  size="small"
                  rowKey={(r) => `${r.kindKey}-${r.relativePath}`}
                  dataSource={rows}
                  pagination={{ pageSize: 40, showSizeChanger: true }}
                  scroll={{ y: 'calc(100vh - 520px)' }}
                  columns={[
                    {
                      title: t('sync.colKind'),
                      dataIndex: 'kind',
                      width: 100,
                      render: (label: string, row: (typeof rows)[number]) => (
                        <Tag color={kindColor(row.kindKey)}>{label}</Tag>
                      ),
                    },
                    { title: t('sync.colPath'), dataIndex: 'relativePath', ellipsis: true },
                    {
                      title: t('sync.colSize'),
                      dataIndex: 'size',
                      width: 110,
                      render: (s: number) => formatSize(s || 0),
                    },
                  ]}
                />
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
};
