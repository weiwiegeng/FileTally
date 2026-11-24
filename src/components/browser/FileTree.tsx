import React, { useLayoutEffect, useRef, useState } from 'react';
import { Empty, Spin, Typography, Divider } from 'antd';
import { FolderOpenOutlined, CloudServerOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { List } from 'react-window';
import { FileTreeNode } from './FileTreeNode';
import { useFileStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import { isRemotePath } from '../../utils/format';
import { sortFileNodes } from '../../utils/sortFiles';
import type { FileNode } from '../../types';

const { Text } = Typography;

const ROW_HEIGHT = 34;

interface VirtualRootListProps {
  nodes: FileNode[];
  showHidden: boolean;
  listHeight: number;
}

const VirtualRootList: React.FC<VirtualRootListProps> = ({ nodes, showHidden, listHeight }) => {
  const height = Math.max(ROW_HEIGHT, Math.min(listHeight, nodes.length * ROW_HEIGHT));

  return (
    <List
      style={{ height, width: '100%' }}
      rowCount={nodes.length}
      rowHeight={ROW_HEIGHT}
      rowComponent={({ index, style }) => (
        <div style={style}>
          <FileTreeNode node={nodes[index]} level={0} showHidden={showHidden} />
        </div>
      )}
      rowProps={{}}
    />
  );
};

export const FileTree: React.FC = () => {
  const { t } = useTranslation();
  const { currentPaths, nodesMap, loading, loadingPaths, showHidden, sortField, sortOrder } = useFileStore();
  const colors = useThemeColors();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(480);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setPaneHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentPaths.length]);

  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  };

  if (loading && currentPaths.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip={t('browser.fileTree.loading')} />
      </div>
    );
  }

  if (currentPaths.length === 0) {
    return (
      <Empty
        description={t('browser.fileTree.selectFolderFirst')}
        style={{ padding: 40 }}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <div ref={scrollRef} style={{ overflow: 'auto', height: '100%' }}>
      {currentPaths.map((rootPath, index) => {
        const nodes = nodesMap[rootPath] || [];
        const isLoading = loadingPaths.has(rootPath);
        const isRemote = isRemotePath(rootPath);

        const visibleNodes = showHidden ? nodes : nodes.filter((node) => !node.is_hidden);
        const filteredNodes = sortFileNodes(visibleNodes, sortField, sortOrder);

        return (
          <div key={rootPath}>
            <div
              style={{
                padding: '8px 12px',
                background: colors.bgSecondary,
                borderRadius: 4,
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {isRemote ? (
                <CloudServerOutlined style={{ color: colors.accentPurple }} />
              ) : (
                <FolderOpenOutlined style={{ color: colors.accentOrange }} />
              )}
              <Text strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getFolderName(rootPath)}
              </Text>
              {isLoading && <Spin size="small" />}
            </div>

            {isLoading ? (
              <div style={{ padding: 20, textAlign: 'center' }}>
                <Spin size="small" />
              </div>
            ) : filteredNodes.length === 0 ? (
              <div style={{ padding: '12px 24px', color: colors.textSecondary }}>
                {t('browser.fileTree.emptyFolder')}
              </div>
            ) : (
              <div style={{ marginBottom: 8 }}>
                <VirtualRootList
                  nodes={filteredNodes}
                  showHidden={showHidden}
                  listHeight={paneHeight}
                />
              </div>
            )}

            {index < currentPaths.length - 1 && <Divider style={{ margin: '8px 0' }} />}
          </div>
        );
      })}
    </div>
  );
};