import React from 'react';
import { Empty, Spin } from 'antd';
import { FileTreeNode } from './FileTreeNode';
import { useFileStore } from '../../stores';

export const FileTree: React.FC = () => {
  const { nodes, loading, showHidden } = useFileStore();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip="加载中..." />
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <Empty
        description="文件夹为空"
        style={{ padding: 40 }}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  const filteredNodes = showHidden
    ? nodes
    : nodes.filter((node) => !node.is_hidden);

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      {filteredNodes.map((node) => (
        <FileTreeNode
          key={node.id}
          node={node}
          level={0}
          showHidden={showHidden}
        />
      ))}
    </div>
  );
};
