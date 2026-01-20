import React, { useEffect, useState } from 'react';
import { Spin, Alert } from 'antd';
import mammoth from 'mammoth';
import { readFile } from '@tauri-apps/plugin-fs';

interface WordPreviewProps {
  filePath: string;
}

export const WordPreview: React.FC<WordPreviewProps> = ({ filePath }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    const loadWord = async () => {
      setLoading(true);
      setError(null);

      try {
        // Read file as binary
        const data = await readFile(filePath);
        const arrayBuffer = data.buffer;

        // Convert to HTML using mammoth
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setHtmlContent(result.value);

        if (result.messages.length > 0) {
          console.warn('Mammoth warnings:', result.messages);
        }
      } catch (err) {
        console.error('Failed to load Word document:', err);
        setError('无法加载 Word 文档');
      } finally {
        setLoading(false);
      }
    };

    loadWord();
  }, [filePath]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip="加载 Word 文档中..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message="Word 预览失败"
        description={error}
        type="error"
        showIcon
      />
    );
  }

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 8,
        padding: 20,
        maxHeight: 450,
        overflow: 'auto',
        color: '#333',
      }}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
};
