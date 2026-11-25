import React, { useState } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  Button,
  Space,
  Table,
  Tag,
  message,
  Typography,
} from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { mapBackendError } from '../../utils/backendError';
import { FolderOpenOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface BatchOpItem {
  path: string;
  op: string;
}

interface BatchOpPreviewEntry {
  sourcePath: string;
  destPath: string;
  op: string;
  existsAtDest: boolean;
}

interface BatchOpPreview {
  entries: BatchOpPreviewEntry[];
  unsupported: string[];
}

interface BatchOpApplyResult {
  applied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface BatchOpsModalProps {
  open: boolean;
  initialPaths: string[];
  onClose: () => void;
}

export const BatchOpsModal: React.FC<BatchOpsModalProps> = ({
  open: visible,
  initialPaths,
  onClose,
}) => {
  const { t } = useTranslation();
  const [pathsText, setPathsText] = useState(initialPaths.join('\n'));
  const [dest, setDest] = useState('');
  const [op, setOp] = useState<'copy' | 'move'>('copy');
  const [conflictResolution, setConflictResolution] = useState<'skip' | 'rename' | 'overwrite'>(
    'rename'
  );
  const [preview, setPreview] = useState<BatchOpPreview | null>(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (visible) {
      setPathsText(initialPaths.join('\n'));
      setPreview(null);
    }
  }, [visible, initialPaths]);

  const parsePaths = () =>
    pathsText
      .split(/\n|,/)
      .map((p) => p.trim())
      .filter(Boolean);

  const pickDest = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setDest(selected);
  };

  const buildItems = (): BatchOpItem[] =>
    parsePaths().map((path) => ({ path, op }));

  const handlePreview = async () => {
    const paths = parsePaths();
    if (!paths.length || !dest) {
      message.warning(t('batch.needPathsDest'));
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<BatchOpPreview>('preview_batch_ops', {
        items: buildItems(),
        dest,
      });
      setPreview(result);
    } catch (err) {
      message.error(mapBackendError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    const paths = parsePaths();
    if (!paths.length || !dest) {
      message.warning(t('batch.needPathsDest'));
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<BatchOpApplyResult>('apply_batch_ops', {
        items: buildItems(),
        dest,
        archiveZip: false,
        conflictResolution,
      });
      message.success(
        t('batch.applyResult', {
          applied: result.applied,
          skipped: result.skipped,
          failed: result.failed,
        })
      );
      if (result.failed > 0 && result.errors.length) {
        message.warning(result.errors.slice(0, 3).join('; '));
      }
      onClose();
    } catch (err) {
      message.error(mapBackendError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={t('batch.title')}
      open={visible}
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('batch.cancel')}
        </Button>,
        <Button key="preview" loading={loading} onClick={() => void handlePreview()}>
          {t('batch.preview')}
        </Button>,
        <Button
          key="apply"
          type="primary"
          loading={loading}
          disabled={!preview?.entries.length}
          onClick={() => void handleApply()}
        >
          {t('batch.apply')}
        </Button>,
      ]}
    >
      <Form layout="vertical">
        <Form.Item label={t('batch.paths')}>
          <Input.TextArea
            rows={4}
            value={pathsText}
            onChange={(e) => setPathsText(e.target.value)}
            placeholder={t('batch.pathsPlaceholder')}
          />
        </Form.Item>
        <Form.Item label={t('batch.operation')}>
          <Select
            value={op}
            onChange={setOp}
            options={[
              { value: 'copy', label: t('batch.opCopy') },
              { value: 'move', label: t('batch.opMove') },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('batch.dest')}>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={dest} onChange={(e) => setDest(e.target.value)} />
            <Button icon={<FolderOpenOutlined />} onClick={() => void pickDest()} />
          </Space.Compact>
        </Form.Item>
        <Form.Item
          label={t('batch.conflictStrategy')}
          extra={t('batch.conflictHint')}
        >
          <Select
            value={conflictResolution}
            onChange={setConflictResolution}
            options={[
              { value: 'rename', label: t('batch.conflictRename') },
              { value: 'overwrite', label: t('batch.conflictOverwrite') },
              { value: 'skip', label: t('batch.conflictSkip') },
            ]}
          />
        </Form.Item>
      </Form>

      {preview && (
        <>
          {preview.unsupported.length > 0 && (
            <Text type="warning">{t('batch.unsupported', { count: preview.unsupported.length })}</Text>
          )}
          <Table
            size="small"
            style={{ marginTop: 12 }}
            rowKey="sourcePath"
            pagination={{ pageSize: 8 }}
            dataSource={preview.entries}
            columns={[
              { title: t('batch.colSource'), dataIndex: 'sourcePath', ellipsis: true },
              { title: t('batch.colDest'), dataIndex: 'destPath', ellipsis: true },
              {
                title: t('batch.colConflict'),
                dataIndex: 'existsAtDest',
                width: 90,
                render: (v: boolean) =>
                  v ? <Tag color="warning">{t('batch.exists')}</Tag> : <Tag>{t('batch.ok')}</Tag>,
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
};