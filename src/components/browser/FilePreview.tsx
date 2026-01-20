import React from 'react';
import { Typography, Descriptions, Empty, Spin, Tag } from 'antd';
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
  const { selectedFile, previewInfo, previewLoading } = useFileStore();
  const colors = useThemeColors();

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

  const renderPreviewContent = () => {
    if (selectedFile.is_dir) {
      return (
        <div
          style={{
            background: colors.bgSecondary,
            borderRadius: 8,
            padding: 20,
            textAlign: 'center',
          }}
        >
          <FileIcon isDir={true} extension="" size={48} isOpen={true} />
          <div style={{ marginTop: 16, color: colors.textPrimary }}>文件夹</div>
          {selectedFile.children_count !== null && (
            <Text type="secondary">
              包含 {selectedFile.children_count} 个项目
            </Text>
          )}
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
          <Text
            strong
            style={{
              color: colors.textPrimary,
              fontSize: 16,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selectedFile.name}
          </Text>
          <Text
            type="secondary"
            style={{
              fontSize: 12,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
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
