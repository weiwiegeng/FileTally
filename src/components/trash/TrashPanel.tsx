import React, { useCallback, useEffect, useState } from 'react';
import {
  Typography,
  Space,
  Button,
  Table,
  Empty,
  message,
  Popconfirm,
  Tooltip,
} from 'antd';
import { DeleteOutlined, RestOutlined, ReloadOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';
import { formatSize } from '../../utils/format';

const { Title, Text } = Typography;

export interface TrashItem {
  id: string;
  originalPath: string;
  name: string;
  size: number;
  deletedAt: number;
  trashedPath: string;
}

export const TrashPanel: React.FC = () => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<TrashItem[]>('list_trash');
      setItems(list);
    } catch (err) {
      message.error(mapBackendError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (id: string) => {
    try {
      await invoke('restore_trash_item', { id });
      message.success(t('trash.restoreOk'));
      await refresh();
    } catch (err) {
      message.error(mapBackendError(err));
    }
  };

  const emptyAll = async () => {
    try {
      const count = await invoke<number>('empty_trash');
      message.success(t('trash.emptyOk', { count }));
      await refresh();
    } catch (err) {
      message.error(mapBackendError(err));
    }
  };

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
          <DeleteOutlined style={{ fontSize: 24, color: colors.accentOrange }} />
          <div>
            <Title level={4} style={{ margin: 0, color: colors.textPrimary }}>
              {t('trash.title')}
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {t('trash.hint')}
            </Text>
          </div>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            {t('trash.refresh')}
          </Button>
          <Popconfirm
            title={t('trash.emptyConfirm')}
            onConfirm={() => void emptyAll()}
            disabled={items.length === 0}
          >
            <Button danger icon={<DeleteOutlined />} disabled={items.length === 0}>
              {t('trash.emptyAll')}
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: 24, overflow: 'hidden' }}>
        {items.length === 0 && !loading ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('trash.empty')}
            style={{ marginTop: 80 }}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={items}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ y: 'calc(100vh - 220px)' }}
            style={{
              background: colors.bgCard,
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
            }}
            columns={[
              {
                title: t('trash.colName'),
                dataIndex: 'name',
                ellipsis: true,
              },
              {
                title: t('trash.colOriginal'),
                dataIndex: 'originalPath',
                ellipsis: true,
                render: (p: string) => (
                  <Tooltip title={p}>
                    <Text ellipsis style={{ maxWidth: 280 }}>
                      {p}
                    </Text>
                  </Tooltip>
                ),
              },
              {
                title: t('trash.colSize'),
                dataIndex: 'size',
                width: 100,
                render: (s: number) => formatSize(s),
              },
              {
                title: t('trash.colDeletedAt'),
                dataIndex: 'deletedAt',
                width: 160,
                render: (ts: number) => new Date(ts * 1000).toLocaleString(),
              },
              {
                title: t('trash.colActions'),
                width: 100,
                render: (_: unknown, row: TrashItem) => (
                  <Button
                    size="small"
                    icon={<RestOutlined />}
                    onClick={() => void restore(row.id)}
                  >
                    {t('trash.restore')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
};