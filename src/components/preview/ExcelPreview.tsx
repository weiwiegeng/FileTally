import React, { useEffect, useState, useRef } from 'react';
import { Table, Spin, Alert, Tabs } from 'antd';
import * as XLSX from 'xlsx';
import { readFile } from '@tauri-apps/plugin-fs';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../../hooks';
import { mapBackendError } from '../../utils/backendError';

interface ExcelPreviewProps {
  filePath: string;
}

interface SheetData {
  name: string;
  headers: string[];
  rows: Record<string, any>[];
}

export const ExcelPreview: React.FC<ExcelPreviewProps> = ({ filePath }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const abortRef = useRef(false);
  const colors = useThemeColors();

  useEffect(() => {
    abortRef.current = false;
    
    const loadExcel = async () => {
      setLoading(true);
      setError(null);
      setSheets([]);

      try {
        // Read file as binary
        const data = await readFile(filePath);
        
        if (abortRef.current) return;
        
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetsData: SheetData[] = [];

        for (const sheetName of workbook.SheetNames) {
          if (abortRef.current) return;
          
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

          if (jsonData.length === 0) {
            sheetsData.push({ name: sheetName, headers: [], rows: [] });
            continue;
          }

          // First row as headers
          const headers = (jsonData[0] || []).map((h, i) =>
            String(h || t('preview.excel.defaultColumn', { index: i + 1 }))
          );
          
          // Rest as data rows
          const rows = jsonData.slice(1).map((row, rowIndex) => {
            const rowData: Record<string, any> = { key: rowIndex };
            headers.forEach((header, colIndex) => {
              rowData[header] = row[colIndex] ?? '';
            });
            return rowData;
          });

          sheetsData.push({ name: sheetName, headers, rows });
        }

        if (!abortRef.current) {
          setSheets(sheetsData);
        }
      } catch (err) {
        if (abortRef.current) return;
        console.error('Failed to load Excel:', err);
        setError(t('preview.excel.loadFailed', { error: mapBackendError(err) }));
      } finally {
        if (!abortRef.current) {
          setLoading(false);
        }
      }
    };

    loadExcel();
    
    return () => {
      abortRef.current = true;
    };
  }, [filePath, t]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip={t('preview.excel.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message={t('preview.excel.errorTitle')}
        description={error}
        type="error"
        showIcon
      />
    );
  }

  if (sheets.length === 0) {
    return <Alert message={t('preview.excel.empty')} type="info" showIcon />;
  }

  const tabItems = sheets.map((sheet) => ({
    key: sheet.name,
    label: sheet.name,
    children: (
      <Table
        columns={sheet.headers.map((header) => ({
          title: header,
          dataIndex: header,
          key: header,
          ellipsis: true,
          width: 150,
        }))}
        dataSource={sheet.rows}
        size="small"
        scroll={{ x: 'max-content', y: 350 }}
        virtual
        pagination={{
          pageSize: 100,
          showSizeChanger: true,
          pageSizeOptions: ['50', '100', '200'],
          showQuickJumper: true,
          size: 'small',
          showTotal: (total) => t('preview.excel.paginationTotal', { total }),
        }}
        style={{ 
          background: colors.bgSecondary,
          borderRadius: 8,
        }}
      />
    ),
  }));

  return (
    <Tabs
      items={tabItems}
      size="small"
      style={{ maxHeight: 450, overflow: 'auto' }}
    />
  );
};
