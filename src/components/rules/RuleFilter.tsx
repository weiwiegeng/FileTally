import React, { useMemo, useState } from 'react';
import {
  Typography,
  Space,
  Button,
  Input,
  InputNumber,
  Segmented,
  Table,
  message,
  Card,
  Form,
  Row,
  Col,
  Statistic,
  Empty,
  Tag,
} from 'antd';
import {
  FilterOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';
import { makeTaskId, useTaskStore } from '../../stores/taskStore';
import { persist } from 'zustand/middleware';
import { create } from 'zustand';
import { formatSize } from '../../utils/format';

const { Title, Text } = Typography;

interface FilteredFile {
  path: string;
  name: string;
  size: number;
  modified: number;
}

interface SavedRule {
  id: string;
  name: string;
  extensions: string;
  minSizeMb?: number;
  maxSizeMb?: number;
  modifiedWithinDays: number;
  pathRegex: string;
  logic: string;
}

const useSavedRules = create<{
  rules: SavedRule[];
  add: (r: Omit<SavedRule, 'id'>) => void;
  remove: (id: string) => void;
}>()(
  persist(
    (set) => ({
      rules: [],
      add: (r) =>
        set((s) => ({
          rules: [{ ...r, id: Math.random().toString(36).slice(2, 9) }, ...s.rules],
        })),
      remove: (id) => set((s) => ({ rules: s.rules.filter((x) => x.id !== id) })),
    }),
    { name: 'filetally-saved-rules' }
  )
);

export const RuleFilter: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { rules, add, remove } = useSavedRules();
  const { upsertTask, completeTask } = useTaskStore();

  const [root, setRoot] = useState('');
  const [extensions, setExtensions] = useState('pdf,docx,xlsx');
  const [minSizeMb, setMinSizeMb] = useState<number | null>(null);
  const [maxSizeMb, setMaxSizeMb] = useState<number | null>(null);
  const [modifiedWithinDays, setModifiedWithinDays] = useState(0);
  const [pathRegex, setPathRegex] = useState('');
  const [logic, setLogic] = useState<'and' | 'or'>('and');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<FilteredFile[]>([]);
  const [jobId, setJobId] = useState(0);

  const totalSize = useMemo(
    () => results.reduce((sum, r) => sum + (r.size || 0), 0),
    [results]
  );

  const pickRoot = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setRoot(selected);
  };

  const run = async () => {
    if (!root) {
      message.warning(t('rules.rootPath'));
      return;
    }
    setLoading(true);
    let taskId = '';
    try {
      const jid = await invoke<number>('prepare_rule_filter');
      setJobId(jid);
      taskId = makeTaskId('rules', jid);
      upsertTask({
        id: taskId,
        kind: 'rules',
        title: root,
        status: 'running',
        backendJobId: jid,
        progress: { current: 0, total: 0, percentage: 0 },
        startedAt: Date.now(),
        cancellable: true,
      });
      const rows = await invoke<FilteredFile[]>('filter_files_by_rules', {
        root,
        options: {
          extensions,
          minSizeBytes: minSizeMb != null ? Math.round(minSizeMb * 1024 * 1024) : null,
          maxSizeBytes: maxSizeMb != null ? Math.round(maxSizeMb * 1024 * 1024) : null,
          modifiedWithinDays,
          pathRegex: pathRegex || null,
          logic,
        },
        jobId: jid,
      });
      setResults(rows);
      completeTask(taskId, 'completed');
      message.success(t('rules.doneCount', { count: rows.length }));
    } catch (e) {
      if (taskId) completeTask(taskId, 'failed', mapBackendError(e));
      message.error(mapBackendError(e));
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    try {
      await invoke('cancel_rule_filter', { jobId: jobId || null });
    } catch {
      // ignore
    }
  };

  const pageShell: React.CSSProperties = {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: colors.bgPrimary,
  };

  return (
    <div style={pageShell}>
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexShrink: 0,
        }}
      >
        <Space>
          <FilterOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <div>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('rules.title')}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('rules.hint')}
            </Text>
          </div>
        </Space>
        <Space>
          {loading && (
            <Button danger icon={<StopOutlined />} onClick={() => void cancel()}>
              {t('rules.cancel')}
            </Button>
          )}
          <Button
            icon={<SaveOutlined />}
            onClick={() =>
              add({
                name: extensions || 'rule',
                extensions,
                minSizeMb: minSizeMb ?? undefined,
                maxSizeMb: maxSizeMb ?? undefined,
                modifiedWithinDays,
                pathRegex,
                logic,
              })
            }
          >
            {t('rules.saveRule')}
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={loading}
            onClick={() => void run()}
          >
            {t('rules.run')}
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
          styles={{ body: { padding: 16 } }}
          style={{
            background: colors.bgCard,
            borderColor: colors.border,
            flexShrink: 0,
          }}
        >
          <Form layout="vertical" size="middle">
            <Form.Item label={t('rules.rootPath')} style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder={t('rules.rootPath')}
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => void pickRoot()} />
              </Space.Compact>
            </Form.Item>

            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label={t('rules.extensions')} style={{ marginBottom: 12 }}>
                  <Input
                    value={extensions}
                    onChange={(e) => setExtensions(e.target.value)}
                    placeholder="pdf,docx,xlsx"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label={t('rules.pathRegex')} style={{ marginBottom: 12 }}>
                  <Input
                    value={pathRegex}
                    onChange={(e) => setPathRegex(e.target.value)}
                    placeholder={t('rules.pathRegex')}
                    allowClear
                  />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16}>
              <Col xs={12} md={6}>
                <Form.Item label={t('rules.minSizeMb')} style={{ marginBottom: 12 }}>
                  <InputNumber
                    value={minSizeMb}
                    onChange={(v) => setMinSizeMb(v)}
                    min={0}
                    style={{ width: '100%' }}
                    placeholder="0"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item label={t('rules.maxSizeMb')} style={{ marginBottom: 12 }}>
                  <InputNumber
                    value={maxSizeMb}
                    onChange={(v) => setMaxSizeMb(v)}
                    min={0}
                    style={{ width: '100%' }}
                    placeholder="0"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item label={t('rules.modifiedWithinDays')} style={{ marginBottom: 12 }}>
                  <InputNumber
                    value={modifiedWithinDays}
                    onChange={(v) => setModifiedWithinDays(v || 0)}
                    min={0}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item label=" " style={{ marginBottom: 12 }} colon={false}>
                  <Segmented
                    block
                    value={logic}
                    onChange={(v) => setLogic(v as 'and' | 'or')}
                    options={[
                      { value: 'and', label: t('rules.logicAnd') },
                      { value: 'or', label: t('rules.logicOr') },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Form>

          {rules.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('rules.savedRules')}
              </Text>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {rules.map((item) => (
                  <Tag
                    key={item.id}
                    closable
                    onClose={() => remove(item.id)}
                    style={{ cursor: 'pointer', padding: '4px 8px' }}
                    onClick={() => {
                      setExtensions(item.extensions);
                      setMinSizeMb(item.minSizeMb ?? null);
                      setMaxSizeMb(item.maxSizeMb ?? null);
                      setModifiedWithinDays(item.modifiedWithinDays);
                      setPathRegex(item.pathRegex);
                      setLogic(item.logic as 'and' | 'or');
                    }}
                  >
                    {item.name}
                  </Tag>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <span>{t('rules.results')}</span>
              {results.length > 0 && <Tag color="blue">{results.length}</Tag>}
            </Space>
          }
          extra={
            results.length > 0 ? (
              <Text type="secondary">{formatSize(totalSize)}</Text>
            ) : null
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
              padding: results.length ? 0 : 24,
              display: 'flex',
              flexDirection: 'column',
            },
          }}
        >
          {results.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('rules.empty')}
              style={{ margin: 'auto' }}
            />
          ) : (
            <>
              <Row gutter={16} style={{ padding: '12px 16px', borderBottom: `1px solid ${colors.border}` }}>
                <Col span={8}>
                  <Statistic title={t('rules.colName')} value={results.length} />
                </Col>
                <Col span={8}>
                  <Statistic title={t('rules.colSize')} value={formatSize(totalSize)} />
                </Col>
              </Row>
              <div style={{ flex: 1, minHeight: 0 }}>
                <Table
                  size="small"
                  rowKey="path"
                  dataSource={results}
                  pagination={{ pageSize: 50, showSizeChanger: true }}
                  scroll={{ y: 'calc(100vh - 520px)' }}
                  columns={[
                    { title: t('rules.colName'), dataIndex: 'name', width: 220, ellipsis: true },
                    { title: t('rules.colPath'), dataIndex: 'path', ellipsis: true },
                    {
                      title: t('rules.colSize'),
                      dataIndex: 'size',
                      width: 110,
                      render: (s: number) => formatSize(s || 0),
                    },
                  ]}
                />
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};
