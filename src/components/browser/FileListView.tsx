import React, { useMemo, useState } from 'react';
import { Input, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import { useFileStore } from '../../stores';
import type { FileNode } from '../../types';
import { formatSize, formatDate } from '../../utils/format';

function flatten(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

export const FileListView: React.FC = () => {
  const { t } = useTranslation();
  const { nodes, selectFile, selectedFile, showHidden } = useFileStore();
  const [filter, setFilter] = useState('');

  const data = useMemo(() => {
    let rows = flatten(nodes || []);
    if (!showHidden) rows = rows.filter((r) => !r.name.startsWith('.'));
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.extension || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [nodes, showHidden, filter]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Input.Search
        allowClear
        placeholder={t('browser.fileBrowser.filterPlaceholder')}
        style={{ marginBottom: 8 }}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          virtual
          scroll={{ y: 520 }}
          dataSource={data}
          locale={{ emptyText: t('rules.empty') }}
          rowClassName={(r) => (selectedFile?.id === r.id ? 'ant-table-row-selected' : '')}
          onRow={(r) => ({
            onClick: () => {
              void selectFile(r);
            },
          })}
          columns={[
            { title: t('browser.fileBrowser.colName'), dataIndex: 'name', ellipsis: true },
            {
              title: t('browser.fileBrowser.colType'),
              dataIndex: 'extension',
              width: 80,
              render: (e: string, r: FileNode) =>
                r.is_dir ? t('browser.fileBrowser.typeDir') : e || '—',
            },
            {
              title: t('browser.fileBrowser.colSize'),
              dataIndex: 'size',
              width: 100,
              render: (s: number, r: FileNode) => (r.is_dir ? '—' : formatSize(s || 0)),
            },
            {
              title: t('browser.fileBrowser.colModified'),
              dataIndex: 'modified_time',
              width: 150,
              render: (ts: number) => formatDate(ts || 0),
            },
          ]}
        />
      </div>
    </div>
  );
};
