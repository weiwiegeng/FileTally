import React from 'react';
import { Empty, Spin, Typography, Divider } from 'antd';
import { FolderOpenOutlined, CloudServerOutlined } from '@ant-design/icons';
import { FileTreeNode } from './FileTreeNode';
import { useFileStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import { isRemotePath } from '../../utils/format';

const { Text } = Typography;

export const FileTree: React.FC = () => {
  const { currentPaths, nodesMap, loading, loadingPaths, showHidden } = useFileStore();
  const colors = useThemeColors();

  // 获取文件夹名称
  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  };

  if (loading && currentPaths.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip="加载中..." />
      </div>
    );
  }

  if (currentPaths.length === 0) {
    return (
      <Empty
        description="请选择文件夹"
        style={{ padding: 40 }}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      {currentPaths.map((rootPath, index) => {
        const nodes = nodesMap[rootPath] || [];
        const isLoading = loadingPaths.has(rootPath);
        const isRemote = isRemotePath(rootPath);
        
        const filteredNodes = showHidden
          ? nodes
          : nodes.filter((node) => !node.is_hidden);

        return (
          <div key={rootPath}>
            {/* 根目录标题 */}
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

            {/* 文件内容 */}
            {isLoading ? (
              <div style={{ padding: 20, textAlign: 'center' }}>
                <Spin size="small" />
              </div>
            ) : filteredNodes.length === 0 ? (
              <div style={{ padding: '12px 24px', color: colors.textSecondary }}>
                空文件夹
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

            {/* 分隔线 */}
            {index < currentPaths.length - 1 && (
              <Divider style={{ margin: '8px 0' }} />
            )}
          </div>
        );
      })}
    </div>
  );
};
