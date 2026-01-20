import React from 'react';
import {
  FolderOutlined,
  FolderOpenOutlined,
  FileOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileZipOutlined,
  PlayCircleOutlined,
  SoundOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import { getFileCategory } from '../../utils';

interface FileIconProps {
  isDir: boolean;
  extension: string;
  isOpen?: boolean;
  size?: number;
}

export const FileIcon: React.FC<FileIconProps> = ({
  isDir,
  extension,
  isOpen = false,
  size = 16,
}) => {
  const style = { fontSize: size };

  if (isDir) {
    return isOpen ? (
      <FolderOpenOutlined style={{ ...style, color: '#faad14' }} />
    ) : (
      <FolderOutlined style={{ ...style, color: '#faad14' }} />
    );
  }

  const category = getFileCategory(extension);

  switch (category) {
    case 'image':
      return <FileImageOutlined style={{ ...style, color: '#52c41a' }} />;
    case 'document':
      return <FilePdfOutlined style={{ ...style, color: '#ff4d4f' }} />;
    case 'text':
      return <FileTextOutlined style={{ ...style, color: '#1890ff' }} />;
    case 'code':
      return <CodeOutlined style={{ ...style, color: '#722ed1' }} />;
    case 'video':
      return <PlayCircleOutlined style={{ ...style, color: '#eb2f96' }} />;
    case 'audio':
      return <SoundOutlined style={{ ...style, color: '#13c2c2' }} />;
    case 'archive':
      return <FileZipOutlined style={{ ...style, color: '#fa8c16' }} />;
    default:
      return <FileOutlined style={{ ...style, color: '#8c8c8c' }} />;
  }
};
