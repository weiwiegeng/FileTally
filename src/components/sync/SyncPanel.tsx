import React, { useMemo, useState } from 'react';
import {
  Typography,
  Space,
  Button,
  Input,
  Switch,
  Select,
  InputNumber,
  Table,
  message,
  Card,
  Form,
  Empty,
  Tag,
  Row,
  Col,
  Statistic,
  Alert,
  List,
} from 'antd';
import {
  SwapOutlined,
  FolderOpenOutlined,
  DiffOutlined,
  CloudSyncOutlined,
  SaveOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';
import {
  makeTaskId,
  useSyncPresetsStore,
  useTaskStore,
  type SyncConflictResolution,
  type SyncMode,
} from '../../stores';
import { formatSize } from '../../utils/format';
import { withSyncLock } from '../../utils/syncLock';

const { Title, Text } = Typography;

interface SyncFileEntry {
  relativePath: string;
  size: number;
  modified: number;
}

interface SyncCompareResult {
  added: SyncFileEntry[];
  changed: SyncFileEntry[];
  extra: SyncFileEntry[];
  conflicts: SyncFileEntry[];
  mode: string;
}

export const SyncPanel: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { upsertTask, completeTask } = useTaskStore();
  const { presets, addPreset, removePreset, updatePreset } = useSyncPresetsStore();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [presetName, setPresetName] = useState('');
  const [deleteExtra, setDeleteExtra] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('one_way');
  const [conflictResolution, setConflictResolution] =
    useState<SyncConflictResolution>('skip');
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const [diff, setDiff] = useState<SyncCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<
    'all' | 'added' | 'changed' | 'extra' | 'conflicts'
  >('all');
  const [comparedOnce, setComparedOnce] = useState(false);

  const pick = async (setter: (v: string) => void) => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setter(selected);
  };

  const savePreset = () => {
    if (!source.trim() || !target.trim()) {
      message.warning(t('sync.presetNeedPaths'));
      return;
    }
    if (!presetName.trim()) {
      message.warning(t('sync.presetName'));
      return;
    }
    addPreset(
      presetName,
      source,
      target,
      syncMode,
      conflictResolution,
      intervalMinutes,
      deleteExtra
    );
    setPresetName('');
    message.success(t('sync.presetSaved'));
  };

  const loadPreset = (preset: (typeof presets)[number]) => {
    setSource(preset.source);
    setTarget(preset.dest);
    setSyncMode(preset.mode || 'one_way');
    setConflictResolution(preset.conflictResolution || 'skip');
    setIntervalMinutes(preset.intervalMinutes || 0);
    setDeleteExtra(preset.deleteExtras ?? false);
    setDiff(null);
    setComparedOnce(false);
  };

  const compare = async () => {
    if (!source || !target) {
      message.warning(`${t('sync.source')} / ${t('sync.target')}`);
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<SyncCompareResult>('compare_sync', {
        source,
        dest: target,
        mode: syncMode,
      });
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
      const result = await withSyncLock(async () => {
        const jobId = await (await import('../../utils/jobs')).prepareJob('sync');
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
        return invoke<SyncCompareResult>('run_sync', {
          source,
          dest: target,
          deleteExtras: deleteExtra,
          jobId,
          mode: syncMode,
          conflictResolution,
        });
      });
      setDiff(result);
      if (taskId) completeTask(taskId, 'completed');
      message.success(t('sync.done'));
      const match = presets.find((p) => p.source === source && p.dest === target);
      if (match) {
        updatePreset(match.id, {
          lastRunAt: Date.now(),
          lastRunOk: true,
          lastError: undefined,
        });
      }
    } catch (e) {
      const errText =
        e instanceof Error && e.message === 'sync_already_running'
          ? t('errors.sync_already_running')
          : mapBackendError(e);
      if (taskId) completeTask(taskId, 'failed', errText);
      message.error(errText);
      const match = presets.find((p) => p.source === source && p.dest === target);
      if (match) {
        updatePreset(match.id, {
          lastRunAt: Date.now(),
          lastRunOk: false,
          lastError: errText,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => {
    const all = [
      ...(diff?.added || []).map((x) => ({ ...x, kind: t('sync.added'), kindKey: 'added' as const })),
      ...(diff?.changed || []).map((x) => ({ ...x, kind: t('sync.changed'), kindKey: 'changed' as const })),
      ...(diff?.extra || []).map((x) => ({ ...x, kind: t('sync.extra'), kindKey: 'extra' as const })),
      ...(diff?.conflicts || []).map((x) => ({
        ...x,
        kind: t('sync.conflicts'),
        kindKey: 'conflicts' as const,
      })),
    ];
    if (kindFilter === 'all') return all;
    return all.filter((r) => r.kindKey === kindFilter);
  }, [diff, t, kindFilter]);

  const kindColor = (key: string) => {
    if (key === 'added') return 'green';
    if (key === 'changed') return 'gold';
    if (key === 'conflicts') return 'purple';
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
        <Alert type="info" showIcon message={t('sync.boundaryAlert')} style={{ flexShrink: 0 }} />

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
            <Form.Item label={t('sync.mode')} style={{ marginBottom: 12 }}>
              <Select
                value={syncMode}
                onChange={setSyncMode}
                options={[
                  { value: 'one_way', label: t('sync.modeOneWay') },
                  { value: 'two_way', label: t('sync.modeTwoWay') },
                ]}
              />
            </Form.Item>
            {syncMode === 'two_way' && (
              <Form.Item label={t('sync.conflictStrategy')} style={{ marginBottom: 12 }}>
                <Select
                  value={conflictResolution}
                  onChange={setConflictResolution}
                  options={[
                    { value: 'skip', label: t('sync.conflictSkip') },
                    { value: 'prefer_source', label: t('sync.conflictPreferSource') },
                    { value: 'prefer_dest', label: t('sync.conflictPreferDest') },
                  ]}
                />
              </Form.Item>
            )}
            <Form.Item style={{ marginBottom: 12 }}>
              <Space>
                <Switch checked={deleteExtra} onChange={setDeleteExtra} disabled={syncMode === 'two_way'} />
                <Text>{t('sync.deleteExtra')}</Text>
              </Space>
            </Form.Item>
            <Form.Item label={t('sync.intervalMinutes')} style={{ marginBottom: 12 }}>
              <InputNumber min={0} value={intervalMinutes} onChange={(v) => setIntervalMinutes(v || 0)} />
            </Form.Item>
            <Form.Item label={t('sync.savePreset')} style={{ marginBottom: 0 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder={t('sync.presetName')}
                />
                <Button icon={<SaveOutlined />} onClick={savePreset}>
                  {t('sync.savePreset')}
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Card>

        {presets.length > 0 && (
          <Card
            size="small"
            title={t('sync.presets')}
            style={{ background: colors.bgCard, borderColor: colors.border, flexShrink: 0 }}
            styles={{ body: { padding: '8px 16px' } }}
          >
            <List
              size="small"
              dataSource={presets}
              renderItem={(item) => (
                <List.Item
                  actions={[
                    <Button
                      key="load"
                      type="link"
                      size="small"
                      onClick={() => loadPreset(item)}
                    >
                      {t('sync.loadPreset')}
                    </Button>,
                    <Button
                      key="del"
                      type="link"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => removePreset(item.id)}
                    >
                      {t('sync.deletePreset')}
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={item.name}
                    description={
                      <>
                        <div>{`${item.source} → ${item.dest}`}</div>
                        {item.lastRunAt ? (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {item.lastRunOk
                              ? t('sync.presetLastRunOk', {
                                  time: new Date(item.lastRunAt).toLocaleString(),
                                })
                              : t('sync.presetLastRunFail', {
                                  time: new Date(item.lastRunAt).toLocaleString(),
                                  error: item.lastError || '—',
                                })}
                          </Text>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {t('sync.presetNeverRun')}
                          </Text>
                        )}
                      </>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        )}

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
                <Col span={6}>
                  <Statistic title={t('sync.added')} value={diff?.added.length || 0} />
                </Col>
                <Col span={6}>
                  <Statistic title={t('sync.changed')} value={diff?.changed.length || 0} />
                </Col>
                <Col span={6}>
                  <Statistic title={t('sync.extra')} value={diff?.extra.length || 0} />
                </Col>
                <Col span={6}>
                  <Statistic title={t('sync.conflicts')} value={diff?.conflicts.length || 0} />
                </Col>
              </Row>
              <div style={{ padding: '8px 16px', borderBottom: `1px solid ${colors.border}` }}>
                <Space wrap>
                  <Text type="secondary">{t('sync.filterKind')}</Text>
                  {(['all', 'added', 'changed', 'extra', 'conflicts'] as const).map((k) => (
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
