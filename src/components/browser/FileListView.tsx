import React, { useEffect, useMemo, useState } from 'react';
import { Breadcrumb, Input, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import { useFileStore } from '../../stores';
import type { FileNode } from '../../types';
import { formatSize, formatDate, getPathName } from '../../utils/format';
import { fileService } from '../../services';
import { sortFileNodes } from '../../utils/sortFiles';
import { useBrowserPaneContext } from './BrowserPaneContext';
import { parentPath } from '../../utils/pathNav';

function flatten(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

interface FileListViewProps {
  rootPath?: string;
  listPath?: string;
}

export const FileListView: React.FC<FileListViewProps> = ({ rootPath, listPath: listPathProp }) => {
  const { t } = useTranslation();
  const {
    nodes,
    nodesMap,
    currentPaths,
    selectFile,
    selectedFile,
    showHidden,
    sortField,
    sortOrder,
  } = useFileStore();
  const paneCtx = useBrowserPaneContext();
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);

  const useShallowList = Boolean(paneCtx) || listPathProp !== undefined;
  const effectiveListPath =
    listPathProp ?? paneCtx?.cwd ?? rootPath ?? currentPaths[0] ?? '';

  useEffect(() => {
    if (!useShallowList || !effectiveListPath) return;
    // Empty dirs are valid cache hits — key presence matters, not length.
    if (Object.prototype.hasOwnProperty.call(nodesMap, effectiveListPath)) {
      setRows(nodesMap[effectiveListPath] || []);
      return;
    }
    setLoading(true);
    void fileService
      .scanDirectory(effectiveListPath)
      .then((nodes) => {
        setRows(nodes);
        useFileStore.setState((state) => ({
          nodesMap: { ...state.nodesMap, [effectiveListPath]: nodes },
        }));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [useShallowList, effectiveListPath, nodesMap]);

  const data = useMemo(() => {
    if (useShallowList) {
      let list = rows;
      if (!showHidden) list = list.filter((r) => !r.name.startsWith('.'));
      if (filter.trim()) {
        const q = filter.trim().toLowerCase();
        list = list.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.extension || '').toLowerCase().includes(q)
        );
      }
      return sortFileNodes(list, sortField, sortOrder);
    }
    const baseNodes = rootPath
      ? nodesMap[rootPath] || []
      : nodes || [];
    let list = flatten(baseNodes);
    if (!showHidden) list = list.filter((r) => !r.name.startsWith('.'));
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.extension || '').toLowerCase().includes(q)
      );
    }
    return sortFileNodes(list, sortField, sortOrder);
  }, [
    useShallowList,
    rows,
    nodes,
    nodesMap,
    rootPath,
    showHidden,
    filter,
    sortField,
    sortOrder,
    currentPaths,
  ]);

  const visiblePaths = useMemo(() => data.map((r) => r.path), [data]);

  useEffect(() => {
    paneCtx?.setVisiblePaths(visiblePaths);
  }, [paneCtx, visiblePaths]);

  const crumbs = useMemo(() => {
    if (!paneCtx || !rootPath || effectiveListPath === rootPath) return [];
    const parts: { title: string; path: string }[] = [];
    let cur: string | null = effectiveListPath;
    while (cur && cur !== rootPath) {
      parts.unshift({ title: getPathName(cur), path: cur });
      const parent = parentPath(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    parts.unshift({ title: getPathName(rootPath), path: rootPath });
    return parts;
  }, [paneCtx, rootPath, effectiveListPath]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {paneCtx && crumbs.length > 1 ? (
        <Breadcrumb
          style={{ marginBottom: 8, fontSize: 12 }}
          items={crumbs.map((c) => ({
            title: c.path === effectiveListPath ? c.title : (
              <a
                onClick={(e) => {
                  e.preventDefault();
                  paneCtx.enterFolder(c.path);
                }}
              >
                {c.title}
              </a>
            ),
          }))}
        />
      ) : null}
      <Input.Search
        allowClear
        placeholder={t('browser.fileBrowser.filterPlaceholder')}
        style={{ marginBottom: 8 }}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          loading={useShallowList ? loading : false}
          scroll={{ y: useShallowList ? '100%' : 520 }}
          dataSource={data}
          locale={{ emptyText: t('rules.empty') }}
          rowClassName={(r) =>
            paneCtx
              ? paneCtx.selectedPaths.includes(r.path)
                ? 'ant-table-row-selected'
                : ''
              : selectedFile?.id === r.id
                ? 'ant-table-row-selected'
                : ''
          }
          onRow={(r) => ({
            onClick: (e) => {
              if (paneCtx) {
                const additive = e.metaKey || e.ctrlKey;
                const range = e.shiftKey;
                paneCtx.onSelectPath(r.path, { additive, range, visiblePaths });
                if (paneCtx.previewActive) void selectFile(r);
                return;
              }
              void selectFile(r);
            },
            onDoubleClick: () => {
              if (paneCtx && r.is_dir) {
                paneCtx.enterFolder(r.path);
              }
            },
            draggable: Boolean(paneCtx?.enableDrag && paneCtx.selectedPaths.includes(r.path)),
            onDragStart: (e: React.DragEvent) => {
              if (!paneCtx?.selectedPaths.length) return;
              e.dataTransfer.setData(
                'application/json',
                JSON.stringify(paneCtx.selectedPaths)
              );
              e.dataTransfer.effectAllowed = 'copy';
            },
          })}
          columns={[
            { title: t('browser.fileBrowser.colName'), dataIndex: 'name', ellipsis: true },
            {
              title: t('browser.fileBrowser.colType'),
              dataIndex: 'extension',
              width: 80,
              render: (e: string, row: FileNode) =>
                row.is_dir ? t('browser.fileBrowser.typeDir') : e || '—',
            },
            {
              title: t('browser.fileBrowser.colSize'),
              dataIndex: 'size',
              width: 100,
              render: (s: number, row: FileNode) => (row.is_dir ? '—' : formatSize(s || 0)),
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