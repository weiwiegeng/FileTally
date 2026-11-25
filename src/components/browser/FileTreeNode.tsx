import React, { useState, useRef, useEffect } from 'react';
import { RightOutlined, DownOutlined, LoadingOutlined, EditOutlined } from '@ant-design/icons';
import { Dropdown, Input, message } from 'antd';
import { useTranslation } from 'react-i18next';
import type { MenuProps } from 'antd';
import { FileNode } from '../../types';
import { FileIcon } from './FileIcon';
import { useFileStore } from '../../stores';
import { useBrowserPaneContext } from './BrowserPaneContext';
import { useThemeColors } from '../../hooks';
import { formatSize, formatDate, sortFileNodes, mapBackendError } from '../../utils';

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
  const { t } = useTranslation();
  const {
    expandedIds: globalExpanded,
    toggleExpand: globalToggleExpand,
    loadChildren,
    selectFile,
    selectedFile,
    renameFile,
    sortField,
    sortOrder,
  } = useFileStore();
  const paneCtx = useBrowserPaneContext();
  const colors = useThemeColors();

  const isExpanded = paneCtx
    ? paneCtx.expandedIds.includes(node.id)
    : globalExpanded.has(node.id);
  const isSelected = paneCtx
    ? paneCtx.selectedPaths.includes(node.path)
  : selectedFile?.id === node.id;
  const [isLoading, setIsLoading] = React.useState(false);
  
  // 重命名状态
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<any>(null);

  // 进入编辑模式时聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // 选中文件名（不包括扩展名）
      const dotIndex = newName.lastIndexOf('.');
      if (dotIndex > 0 && !node.is_dir) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [isEditing]);

  // 开始编辑
  const handleStartEdit = () => {
    setNewName(node.name);
    setIsEditing(true);
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setIsEditing(false);
    setNewName('');
  };

  // 确认重命名
  const handleConfirmRename = async () => {
    if (!newName.trim()) {
      handleCancelEdit();
      return;
    }

    // 名称未改变
    if (newName === node.name) {
      handleCancelEdit();
      return;
    }

    setRenaming(true);
    const result = await renameFile(node.path, newName.trim());
    setRenaming(false);

    if (result.success) {
      message.success(t('browser.fileTreeNode.renameSuccess'));
      setIsEditing(false);
    } else {
      message.error(result.error ? mapBackendError(result.error) : t('browser.fileTreeNode.renameFailed'));
    }
  };

  // 键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  // 右键菜单项
  const contextMenuItems: MenuProps['items'] = [
    {
      key: 'rename',
      label: t('browser.fileTreeNode.contextRename'),
      icon: <EditOutlined />,
      onClick: (e) => {
        e.domEvent.stopPropagation();
        handleStartEdit();
      },
    },
  ];

  // Filter hidden files
  if (!showHidden && node.is_hidden) {
    return null;
  }

  const handleExpand = async (e?: React.MouseEvent) => {
    e?.stopPropagation();

    if (!node.is_dir) return;

    if (!node.is_loaded && !isExpanded) {
      setIsLoading(true);
      try {
        await loadChildren(node.path, node.id);
      } finally {
        setIsLoading(false);
      }
    }
    if (paneCtx) {
      paneCtx.toggleExpand(node.id);
    } else {
      globalToggleExpand(node.id);
    }
  };

  const handleClick = async (e: React.MouseEvent) => {
    if (paneCtx) {
      paneCtx.onSelectPath(node.path, {
        additive: e.metaKey || e.ctrlKey,
        range: e.shiftKey,
      });
      if (paneCtx.previewActive) {
        await selectFile(node);
      }
      return;
    }
    await selectFile(node);
  };

  const handleDoubleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.is_dir) {
      await handleExpand();
    }
  };

  const children = node.children || [];
  const visibleChildren = showHidden
    ? children
    : children.filter((child) => !child.is_hidden);
  const filteredChildren = sortFileNodes(visibleChildren, sortField, sortOrder);

  return (
    <div>
      <Dropdown
        menu={{ items: contextMenuItems }}
        trigger={['contextMenu']}
        disabled={isEditing}
      >
        <div
          onClick={handleClick}
          onDoubleClick={(e) => void handleDoubleClick(e)}
          draggable={Boolean(paneCtx?.enableDrag && paneCtx.selectedPaths.includes(node.path))}
          onDragStart={(e) => {
            if (!paneCtx?.selectedPaths.length) return;
            e.dataTransfer.setData(
              'application/json',
              JSON.stringify(paneCtx.selectedPaths)
            );
            e.dataTransfer.effectAllowed = 'copy';
          }}
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
              e.currentTarget.style.background = colors.bgHover;
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
                <DownOutlined style={{ fontSize: 10, color: colors.textSecondary }} />
              ) : (
                <RightOutlined style={{ fontSize: 10, color: colors.textSecondary }} />
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

          {/* File Name - 编辑模式或普通显示 */}
          {isEditing ? (
            <Input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => {
                setTimeout(() => {
                  if (isEditing && !renaming) {
                    handleCancelEdit();
                  }
                }, 200);
              }}
              size="small"
              style={{
                marginLeft: 8,
                flex: 1,
                height: 22,
                fontSize: 13,
              }}
              disabled={renaming}
            />
          ) : (
            <span
              style={{
                marginLeft: 8,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: node.is_hidden ? colors.textSecondary : colors.textPrimary,
                fontSize: 13,
              }}
            >
              {node.name}
            </span>
          )}

          {/* Size or Children Count - 编辑模式时隐藏 */}
          {!isEditing && (
            <span
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                marginLeft: 8,
              }}
            >
              {node.is_dir
                ? node.children_count !== null
                  ? t('browser.fileTreeNode.childrenCount', { count: node.children_count })
                  : ''
                : formatSize(node.size)}
            </span>
          )}
        </div>
      </Dropdown>

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
