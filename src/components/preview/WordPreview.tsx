import React, { useEffect, useState, useRef } from 'react';
import { Spin, Alert } from 'antd';
import mammoth from 'mammoth';
import { readFile } from '@tauri-apps/plugin-fs';
import { useThemeColors } from '../../hooks';

interface WordPreviewProps {
  filePath: string;
}

export const WordPreview: React.FC<WordPreviewProps> = ({ filePath }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const abortRef = useRef(false);
  const colors = useThemeColors();

  useEffect(() => {
    abortRef.current = false;
    
    const loadWord = async () => {
      setLoading(true);
      setError(null);
      setHtmlContent('');

      try {
        // Read file as binary
        const data = await readFile(filePath);
        
        if (abortRef.current) return;
        
        const arrayBuffer = data.buffer;

        // Convert to HTML using mammoth
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        if (abortRef.current) return;
        
        setHtmlContent(result.value);

        if (result.messages.length > 0) {
          console.warn('Mammoth warnings:', result.messages);
        }
      } catch (err) {
        if (abortRef.current) return;
        console.error('Failed to load Word document:', err);
        setError('无法加载 Word 文档');
      } finally {
        if (!abortRef.current) {
          setLoading(false);
        }
      }
    };

    loadWord();
    
    return () => {
      abortRef.current = true;
    };
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
        background: colors.bgSecondary,
        borderRadius: 8,
        padding: 20,
        maxHeight: 450,
        overflow: 'auto',
        color: colors.textPrimary,
      }}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
};
