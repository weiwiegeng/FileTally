import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface AudioPreviewProps {
  filePath: string;
}

export const AudioPreview: React.FC<AudioPreviewProps> = ({ filePath }) => {
  const audioSrc = convertFileSrc(filePath);

  return (
    <div style={{ textAlign: 'center', padding: 20 }}>
      <audio
        src={audioSrc}
        controls
        style={{ width: '100%' }}
      />
    </div>
  );
};
