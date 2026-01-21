import React, { useState, useRef, useEffect } from 'react';
import { Typography, Descriptions, Empty, Spin, Tag, Input, Button, message, Tooltip, List } from 'antd';
import { EditOutlined, CheckOutlined, CloseOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons';
import { FileIcon } from './FileIcon';
import { useFileStore } from '../../stores';
import { useThemeColors } from '../../hooks';
import {
  PdfPreview,
  ExcelPreview,
  WordPreview,
  ImagePreview,
  VideoPreview,
  AudioPreview,
  TextPreview,
} from '../preview';

const { Text } = Typography;

// 格式化文件大小
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Get preview type based on file extension
const getPreviewType = (extension: string): string => {
  const ext = extension.toLowerCase();
  
  const typeMap: Record<string, string[]> = {
    pdf: ['pdf'],
    excel: ['xls', 'xlsx', 'csv'],
    word: ['doc', 'docx'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
    video: ['mp4', 'webm', 'mov', 'avi', 'mkv'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
    text: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log'],
    code: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'html', 'css', 'scss', 'less', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'],
  };
  
  for (const [type, extensions] of Object.entries(typeMap)) {
    if (extensions.includes(ext)) {
      return type;
    }
  }
  
  return 'unsupported';
};

export const FilePreview: React.FC = () => {
  const { selectedFile, previewInfo, previewLoading, renameFile } = useFileStore();
  const colors = useThemeColors();
  
  // 重命名状态
  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<any>(null);

  // 当选中文件变化时，重置编辑状态
  useEffect(() => {
    setIsEditing(false);
    setNewName('');
  }, [selectedFile?.path]);

  // 进入编辑模式时聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      // 选中文件名（不包括扩展名）
      const dotIndex = newName.lastIndexOf('.');
      if (dotIndex > 0 && !selectedFile?.is_dir) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [isEditing]);

  // 开始编辑
  const handleStartEdit = () => {
    if (selectedFile) {
      setNewName(selectedFile.name);
      setIsEditing(true);
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setIsEditing(false);
    setNewName('');
  };

  // 确认重命名
  const handleConfirmRename = async () => {
    if (!selectedFile || !newName.trim()) {
      handleCancelEdit();
      return;
    }

    // 名称未改变
    if (newName === selectedFile.name) {
      handleCancelEdit();
      return;
    }

    setRenaming(true);
    const result = await renameFile(selectedFile.path, newName.trim());
    setRenaming(false);

    if (result.success) {
      message.success('重命名成功');
      setIsEditing(false);
    } else {
      message.error(result.error || '重命名失败');
    }
  };

  // 键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  if (!selectedFile) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: colors.textSecondary,
        }}
      >
        <Empty
          description="选择文件查看详情"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  if (previewLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
        }}
      >
        <Spin tip="加载预览..." />
      </div>
    );
  }

  const previewType = getPreviewType(selectedFile.extension);

  // 选中文件夹内的项目
  const handleSelectChild = (child: typeof selectedFile) => {
    if (child) {
      useFileStore.getState().selectFile(child);
    }
  };

  const renderPreviewContent = () => {
    if (selectedFile.is_dir) {
      const children = selectedFile.children || [];
      
      // 如果没有子内容
      if (children.length === 0) {
        return (
          <div
            style={{
              background: colors.bgSecondary,
              borderRadius: 8,
              padding: 40,
              textAlign: 'center',
            }}
          >
            <FileIcon isDir={true} extension="" size={48} isOpen={true} />
            <div style={{ marginTop: 16, color: colors.textSecondary }}>空文件夹</div>
          </div>
        );
      }

      // 分离文件夹和文件，文件夹排前面
      const folders = children.filter(c => c.is_dir);
      const files = children.filter(c => !c.is_dir);
      const sortedChildren = [...folders, ...files];

      return (
        <div
          style={{
            background: colors.bgSecondary,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {/* 文件夹统计信息 */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${colors.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <FileIcon isDir={true} extension="" size={24} isOpen={true} />
            <div>
              <Text style={{ color: colors.textPrimary }}>
                共 {children.length} 个项目
              </Text>
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                ({folders.length} 个文件夹, {files.length} 个文件)
              </Text>
            </div>
          </div>
          
          {/* 子内容列表 */}
          <List
            dataSource={sortedChildren}
            style={{ maxHeight: 400, overflow: 'auto' }}
            renderItem={(item) => (
              <List.Item
                onClick={() => handleSelectChild(item)}
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.bgHover || 'rgba(0,0,0,0.04)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
                  <FileIcon
                    isDir={item.is_dir}
                    extension={item.extension}
                    size={20}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        color: colors.textPrimary,
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.name}
                    </Text>
                  </div>
                  {/* 如果是文件夹且有子内容，显示数量 */}
                  {item.is_dir && item.children_count !== null && item.children_count > 0 && (
                    <Tag color="blue" style={{ marginRight: 0 }}>
                      {item.children_count} 项
                    </Tag>
                  )}
                  {/* 文件显示大小 */}
                  {!item.is_dir && item.size > 0 && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatFileSize(item.size)}
                    </Text>
                  )}
                </div>
              </List.Item>
            )}
          />
        </div>
      );
    }

    switch (previewType) {
      case 'pdf':
        return <PdfPreview filePath={selectedFile.path} />;

      case 'excel':
        return <ExcelPreview filePath={selectedFile.path} />;

      case 'word':
        return <WordPreview filePath={selectedFile.path} />;

      case 'image':
        return (
          <ImagePreview
            filePath={selectedFile.path}
            fileName={selectedFile.name}
          />
        );

      case 'video':
        return <VideoPreview filePath={selectedFile.path} />;

      case 'audio':
        return <AudioPreview filePath={selectedFile.path} />;

      case 'text':
      case 'code':
        return (
          <TextPreview
            filePath={selectedFile.path}
            extension={selectedFile.extension}
          />
        );

      default:
        return (
          <div
            style={{
              background: colors.bgSecondary,
              borderRadius: 8,
              padding: 40,
              textAlign: 'center',
            }}
          >
            <FileIcon
              isDir={false}
              extension={selectedFile.extension}
              size={64}
            />
            <div style={{ marginTop: 20, color: colors.textSecondary }}>
              不支持预览此文件格式
            </div>
            <div style={{ marginTop: 8, color: colors.textSecondary, fontSize: 12 }}>
              {selectedFile.extension.toUpperCase() || '未知'} 格式
            </div>
          </div>
        );
    }
  };

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      {/* File Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 20,
          gap: 12,
        }}
      >
        <FileIcon
          isDir={selectedFile.is_dir}
          extension={selectedFile.extension}
          size={32}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {isEditing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                ref={inputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  // 延迟处理，避免点击按钮时立即失焦
                  setTimeout(() => {
                    if (isEditing && !renaming) {
                      handleCancelEdit();
                    }
                  }, 200);
                }}
                style={{ flex: 1 }}
                disabled={renaming}
              />
              <Button
                type="primary"
                size="small"
                icon={<CheckOutlined />}
                onClick={handleConfirmRename}
                loading={renaming}
              />
              <Button
                size="small"
                icon={<CloseOutlined />}
                onClick={handleCancelEdit}
                disabled={renaming}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text
                strong
                style={{
                  color: colors.textPrimary,
                  fontSize: 16,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedFile.name}
              </Text>
              <Tooltip title="重命名">
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={handleStartEdit}
                  style={{ color: colors.textSecondary }}
                />
              </Tooltip>
            </div>
          )}
          <Text
            type="secondary"
            style={{
              fontSize: 12,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 4,
            }}
          >
            {selectedFile.path}
          </Text>
        </div>
      </div>

      {/* Preview Content */}
      {renderPreviewContent()}

      {/* File Info */}
      {previewInfo && !selectedFile.is_dir && (
        <Descriptions
          column={1}
          size="small"
          style={{ marginTop: 20 }}
        >
          <Descriptions.Item label={<Text style={{ color: colors.textSecondary }}>大小</Text>}>
            <Text style={{ color: colors.textPrimary }}>
              {previewInfo.metadata.size_formatted || '-'}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label={<Text style={{ color: colors.textSecondary }}>类型</Text>}>
            <Tag color="blue">{previewInfo.metadata.extension || '未知'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={<Text style={{ color: colors.textSecondary }}>MIME 类型</Text>}>
            <Text style={{ color: colors.textPrimary }}>
              {previewInfo.metadata.mime_type || '-'}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label={<Text style={{ color: colors.textSecondary }}>修改时间</Text>}>
            <Text style={{ color: colors.textPrimary }}>
              {previewInfo.metadata.modified_time || '-'}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label={<Text style={{ color: colors.textSecondary }}>创建时间</Text>}>
            <Text style={{ color: colors.textPrimary }}>
              {previewInfo.metadata.created_time || '-'}
            </Text>
          </Descriptions.Item>
        </Descriptions>
      )}
    </div>
  );
};
