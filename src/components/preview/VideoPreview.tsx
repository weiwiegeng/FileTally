import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface VideoPreviewProps {
  filePath: string;
}

export const VideoPreview: React.FC<VideoPreviewProps> = ({ filePath }) => {
  const videoSrc = convertFileSrc(filePath);

  return (
    <div style={{ textAlign: 'center' }}>
      <video
        src={videoSrc}
        controls
        style={{
          maxWidth: '100%',
          maxHeight: 450,
          borderRadius: 8,
        }}
      />
    </div>
  );
};
