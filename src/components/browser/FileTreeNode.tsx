import React from 'react';
import { RightOutlined, DownOutlined, LoadingOutlined } from '@ant-design/icons';
import { FileNode } from '../../types';
import { FileIcon } from './FileIcon';
import { useFileStore } from '../../stores';
import { formatSize, formatDate } from '../../utils';

interface FileTreeNodeProps {
  node: FileNode;
  level: number;
  showHidden: boolean;
}

export const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  node,
  level,
  showHidden,
}) => {
  const {
    expandedIds,
    toggleExpand,
    loadChildren,
    selectFile,
    selectedFile,
  } = useFileStore();

  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedFile?.id === node.id;
  const [isLoading, setIsLoading] = React.useState(false);

  // Filter hidden files
  if (!showHidden && node.is_hidden) {
    return null;
  }

  const handleClick = async () => {
    selectFile(node);
  };

  const handleExpand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    if (!node.is_dir) return;

    if (!node.is_loaded && !isExpanded) {
      setIsLoading(true);
      await loadChildren(node.path, node.id);
      setIsLoading(false);
    }
    toggleExpand(node.id);
  };

  const children = node.children || [];
  const filteredChildren = showHidden
    ? children
    : children.filter((child) => !child.is_hidden);

  return (
    <div>
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 8px',
          paddingLeft: level * 20 + 8,
          cursor: 'pointer',
          background: isSelected ? 'rgba(24, 144, 255, 0.15)' : 'transparent',
          borderRadius: 4,
          transition: 'background 0.2s',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'transparent';
          }
        }}
      >
        {/* Expand/Collapse Icon */}
        <span
          onClick={handleExpand}
          style={{
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 4,
            cursor: node.is_dir ? 'pointer' : 'default',
          }}
        >
          {node.is_dir && (
            isLoading ? (
              <LoadingOutlined style={{ fontSize: 10, color: '#1890ff' }} />
            ) : isExpanded ? (
              <DownOutlined style={{ fontSize: 10, color: '#8c8c8c' }} />
            ) : (
              <RightOutlined style={{ fontSize: 10, color: '#8c8c8c' }} />
            )
          )}
        </span>

        {/* File Icon */}
        <FileIcon
          isDir={node.is_dir}
          extension={node.extension}
          isOpen={isExpanded}
          size={16}
        />

        {/* File Name */}
        <span
          style={{
            marginLeft: 8,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: node.is_hidden ? '#8c8c8c' : '#fff',
            fontSize: 13,
          }}
        >
          {node.name}
        </span>

        {/* Size or Children Count */}
        <span
          style={{
            fontSize: 11,
            color: '#8c8c8c',
            marginLeft: 8,
          }}
        >
          {node.is_dir
            ? node.children_count !== null
              ? `${node.children_count} 项`
              : ''
            : formatSize(node.size)}
        </span>
      </div>

      {/* Children */}
      {isExpanded && node.is_loaded && (
        <div>
          {filteredChildren.map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              level={level + 1}
              showHidden={showHidden}
            />
          ))}
        </div>
      )}
    </div>
  );
};
