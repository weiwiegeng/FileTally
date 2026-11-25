import React, { useState } from 'react';
import {
  Typography,
  Space,
  Button,
  Input,
  Segmented,
  Table,
  message,
  Card,
  Form,
  Empty,
  Tag,
  Alert,
} from 'antd';
import {
  RetweetOutlined,
  FolderOpenOutlined,
  EyeOutlined,
  CheckOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';

const { Title, Text } = Typography;

interface OrganizeChange {
  from: string;
  to: string;
  action: string;
}

export const OrganizePanel: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [root, setRoot] = useState('');
  const [mode, setMode] = useState<'rename' | 'by_ext' | 'empty_dirs'>('by_ext');
  const [pattern, setPattern] = useState('{name}_{index}{ext}');
  const [preview, setPreview] = useState<OrganizeChange[]>([]);
  const [loading, setLoading] = useState(false);
  const pickRoot = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setRoot(selected);
  };

  const doPreview = async () => {
    if (!root) {
      message.warning(t('organize.rootPath'));
      return;
    }
    setLoading(true);
    try {
      const rows = await invoke<OrganizeChange[]>('preview_organize', {
        root,
        options: { mode, pattern, removeEmpty: true },
      });
      setPreview(rows);
    } catch (e) {
      message.error(mapBackendError(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!root) {
      message.warning(t('organize.rootPath'));
      return;
    }
    setLoading(true);
    try {
      const rows = await invoke<OrganizeChange[]>('apply_organize', {
        root,
        options: { mode, pattern, removeEmpty: true },
      });
      setPreview(rows);
      message.success(t('organize.doneCount', { count: rows.length }));
    } catch (e) {
      message.error(mapBackendError(e));
    } finally {
      setLoading(false);
    }
  };

  const undo = async () => {
    try {
      const rows = await invoke<{ from: string; to: string; action: string }[]>('undo_organize');
      message.success(t('organize.doneCount', { count: rows.length }));
      setPreview([]);
    } catch (e) {
      message.error(mapBackendError(e));
    }
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
          <RetweetOutlined style={{ fontSize: 24, color: colors.accentPurple }} />
          <div>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('organize.title')}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('organize.hint')}
            </Text>
          </div>
        </Space>
        <Space>
          <Button icon={<UndoOutlined />} onClick={() => void undo()}>
            {t('organize.undo')}
          </Button>
          <Button icon={<EyeOutlined />} loading={loading} onClick={() => void doPreview()}>
            {t('organize.preview')}
          </Button>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            loading={loading}
            onClick={() => void apply()}
          >
            {t('organize.apply')}
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
            <Form.Item label={t('organize.rootPath')} style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder={t('organize.rootPath')}
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => void pickRoot()} />
              </Space.Compact>
            </Form.Item>

            <Form.Item label={t('organize.modeLabel')} style={{ marginBottom: mode === 'rename' ? 12 : 0 }}>
              <Segmented
                block
                value={mode}
                onChange={(v) => setMode(v as typeof mode)}
                options={[
                  { value: 'rename', label: t('organize.modeRename') },
                  { value: 'by_ext', label: t('organize.modeByExt') },
                  { value: 'empty_dirs', label: t('organize.modeEmpty') },
                ]}
              />
            </Form.Item>

            {mode === 'rename' && (
              <Form.Item label={t('organize.pattern')} style={{ marginBottom: 0 }}>
                <Input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="{name}_{index}{ext}"
                />
              </Form.Item>
            )}
          </Form>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message={t('organize.hint')}
          />
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <span>{t('organize.dryRun')}</span>
              {preview.length > 0 && <Tag color="blue">{preview.length}</Tag>}
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
              padding: preview.length ? 0 : 24,
              display: 'flex',
            },
          }}
        >
          {preview.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('rules.empty')}
              style={{ margin: 'auto' }}
            />
          ) : (
            <Table
              size="small"
              style={{ width: '100%' }}
              rowKey={(r) => `${r.from}->${r.to}`}
              dataSource={preview}
              pagination={{ pageSize: 40, showSizeChanger: true }}
              scroll={{ y: 'calc(100vh - 480px)' }}
              columns={[
                { title: t('organize.colAction'), dataIndex: 'action', width: 100 },
                { title: t('organize.colFrom'), dataIndex: 'from', ellipsis: true },
                { title: t('organize.colTo'), dataIndex: 'to', ellipsis: true },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
};
