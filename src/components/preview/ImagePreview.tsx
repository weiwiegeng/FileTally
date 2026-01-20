import React, { useState } from 'react';
import { Image, Spin } from 'antd';
import { convertFileSrc } from '@tauri-apps/api/core';

interface ImagePreviewProps {
  filePath: string;
  fileName: string;
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({ filePath, fileName }) => {
  const [loading, setLoading] = useState(true);

  const imageSrc = convertFileSrc(filePath);

  return (
    <div style={{ textAlign: 'center', position: 'relative' }}>
      {loading && (
        <div style={{ padding: 40 }}>
          <Spin tip="加载图片中..." />
        </div>
      )}
      <Image
        src={imageSrc}
        alt={fileName}
        style={{
          maxWidth: '100%',
          maxHeight: 450,
          objectFit: 'contain',
          borderRadius: 8,
          display: loading ? 'none' : 'block',
        }}
        onLoad={() => setLoading(false)}
        preview={{
          mask: '点击预览大图',
        }}
      />
    </div>
  );
};
