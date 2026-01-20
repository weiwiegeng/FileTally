import React, { useEffect, useState } from 'react';
import { Spin, Alert } from 'antd';
import { readTextFile } from '@tauri-apps/plugin-fs';

interface TextPreviewProps {
  filePath: string;
  extension: string;
}

// Simple syntax highlighting for code
const getLanguageClass = (ext: string): string => {
  const langMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'javascript',
    tsx: 'typescript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    html: 'html',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
  };
  return langMap[ext.toLowerCase()] || 'plaintext';
};

export const TextPreview: React.FC<TextPreviewProps> = ({ filePath, extension }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');

  useEffect(() => {
    const loadText = async () => {
      setLoading(true);
      setError(null);

      try {
        const text = await readTextFile(filePath);
        setContent(text);
      } catch (err) {
        console.error('Failed to load text file:', err);
        setError('无法加载文本文件');
      } finally {
        setLoading(false);
      }
    };

    loadText();
  }, [filePath]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip="加载文本中..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message="文本预览失败"
        description={error}
        type="error"
        showIcon
      />
    );
  }

  const lines = content.split('\n');

  return (
    <div
      style={{
        background: '#1a1a2e',
        borderRadius: 8,
        maxHeight: 450,
        overflow: 'auto',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td
                style={{
                  padding: '2px 12px',
                  textAlign: 'right',
                  color: '#6c6c8a',
                  fontSize: 12,
                  fontFamily: 'Monaco, Menlo, monospace',
                  userSelect: 'none',
                  borderRight: '1px solid #303050',
                  background: '#16213e',
                  minWidth: 50,
                }}
              >
                {index + 1}
              </td>
              <td
                style={{
                  padding: '2px 12px',
                  color: '#d4d4d4',
                  fontSize: 13,
                  fontFamily: 'Monaco, Menlo, monospace',
                  whiteSpace: 'pre',
                }}
              >
                {line || ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
