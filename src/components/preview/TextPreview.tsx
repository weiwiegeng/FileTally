import React, { useEffect, useState } from 'react';
import { Spin, Alert } from 'antd';
import { useTranslation } from 'react-i18next';
import { readTextFile, stat } from '@tauri-apps/plugin-fs';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';

interface TextPreviewProps {
  filePath: string;
  extension: string;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_PREVIEW_LINES = 2000;

export const TextPreview: React.FC<TextPreviewProps> = ({ filePath, extension: _extension }) => {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadText = async () => {
      setLoading(true);
      setError(null);
      setTruncated(false);

      try {
        const info = await stat(filePath);
        if (cancelled) return;

        if (typeof info.size === 'number' && info.size > MAX_PREVIEW_BYTES) {
          setError(
            t('preview.text.fileTooLarge', {
              maxMb: Math.round(MAX_PREVIEW_BYTES / 1024 / 1024),
            })
          );
          setContent('');
          return;
        }

        const text = await readTextFile(filePath);
        if (cancelled) return;

        const lines = text.split('\n');
        if (lines.length > MAX_PREVIEW_LINES) {
          setContent(lines.slice(0, MAX_PREVIEW_LINES).join('\n'));
          setTruncated(true);
        } else {
          setContent(text);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load text file:', err);
        setError(t('preview.text.loadFailed', { error: mapBackendError(err) }));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadText();
    return () => {
      cancelled = true;
    };
  }, [filePath, t]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip={t('preview.text.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert message={t('preview.text.errorTitle')} description={error} type="error" showIcon />
    );
  }

  const lines = content.split('\n');
  const panelBg = colors.isDark ? '#1a1a2e' : '#fafafa';
  const gutterBg = colors.isDark ? '#16213e' : '#f0f0f0';
  const lineColor = colors.isDark ? '#d4d4d4' : '#262626';
  const gutterColor = colors.isDark ? '#6c6c8a' : '#8c8c8c';
  const gutterBorder = colors.border;

  return (
    <div
      style={{
        background: panelBg,
        borderRadius: 8,
        maxHeight: 450,
        overflow: 'auto',
        border: `1px solid ${colors.border}`,
      }}
    >
      {truncated && (
        <Alert
          type="warning"
          showIcon
          message={t('preview.text.truncated', { lines: MAX_PREVIEW_LINES })}
          style={{ marginBottom: 8 }}
        />
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td
                style={{
                  padding: '2px 12px',
                  textAlign: 'right',
                  color: gutterColor,
                  fontSize: 12,
                  fontFamily: 'Monaco, Menlo, monospace',
                  userSelect: 'none',
                  borderRight: `1px solid ${gutterBorder}`,
                  background: gutterBg,
                  minWidth: 50,
                }}
              >
                {index + 1}
              </td>
              <td
                style={{
                  padding: '2px 12px',
                  color: lineColor,
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
