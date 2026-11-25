import React from 'react';
import { Empty, Spin, Typography, Divider } from 'antd';
import { FolderOpenOutlined, CloudServerOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { FileTreeNode } from './FileTreeNode';
import { useFileStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import { isRemotePath } from '../../utils/format';
import { sortFileNodes } from '../../utils/sortFiles';

const { Text } = Typography;

interface FileTreeProps {
  rootPath?: string;
}

/**
 * Tree must NOT use fixed-row virtualization: expanding a folder renders nested
 * children inside the row, which a fixed-height list would clip.
 */
export const FileTree: React.FC<FileTreeProps> = ({ rootPath }) => {
  const { t } = useTranslation();
  const { currentPaths, nodesMap, loading, loadingPaths, showHidden, sortField, sortOrder } =
    useFileStore();
  const displayPaths = rootPath
    ? currentPaths.includes(rootPath)
      ? [rootPath]
      : [rootPath]
    : currentPaths;
  const colors = useThemeColors();

  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  };

  if (loading && displayPaths.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip={t('browser.fileTree.loading')} />
      </div>
    );
  }

  if (displayPaths.length === 0) {
    return (
      <Empty
        description={t('browser.fileTree.selectFolderFirst')}
        style={{ padding: 40 }}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      {displayPaths.map((pathKey, index) => {
        const nodes = nodesMap[pathKey] || [];
        const isLoading = loadingPaths.has(pathKey);
        const isRemote = isRemotePath(pathKey);

        const visibleNodes = showHidden ? nodes : nodes.filter((node) => !node.is_hidden);
        const filteredNodes = sortFileNodes(visibleNodes, sortField, sortOrder);

        return (
          <div key={pathKey}>
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
              <Text
                strong
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {getFolderName(pathKey)}
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
                {filteredNodes.map((node) => (
                  <FileTreeNode
                    key={node.id}
                    node={node}
                    level={0}
                    showHidden={showHidden}
                  />
                ))}
              </div>
            )}

            {index < displayPaths.length - 1 && <Divider style={{ margin: '8px 0' }} />}
          </div>
        );
      })}
    </div>
  );
};
