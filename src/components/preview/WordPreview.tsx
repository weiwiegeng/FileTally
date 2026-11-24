import React, { useEffect, useState, useRef } from 'react';
import { Spin, Alert } from 'antd';
import { useTranslation } from 'react-i18next';
import mammoth from 'mammoth';
import { readFile } from '@tauri-apps/plugin-fs';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';

interface WordPreviewProps {
  filePath: string;
}

export const WordPreview: React.FC<WordPreviewProps> = ({ filePath }) => {
  const { t } = useTranslation();
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
        const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
        const data = await readFile(filePath);

        if (abortRef.current) return;

        if (data.byteLength > MAX_PREVIEW_BYTES) {
          setError(
            t('preview.word.fileTooLarge', {
              maxMb: Math.floor(MAX_PREVIEW_BYTES / (1024 * 1024)),
            })
          );
          return;
        }

        const arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        );

        const result = await mammoth.convertToHtml({ arrayBuffer });

        if (abortRef.current) return;

        setHtmlContent(result.value);

        if (result.messages.length > 0) {
          console.warn('Mammoth warnings:', result.messages);
        }
      } catch (err) {
        if (abortRef.current) return;
        console.error('Failed to load Word document:', err);
        setError(t('preview.word.loadFailed', { error: mapBackendError(err) }));
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
  }, [filePath, t]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip={t('preview.word.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert message={t('preview.word.errorTitle')} description={error} type="error" showIcon />
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
