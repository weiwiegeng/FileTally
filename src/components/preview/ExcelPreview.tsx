import React, { useEffect, useState } from 'react';
import { Table, Spin, Alert, Tabs } from 'antd';
import * as XLSX from 'xlsx';
import { readFile } from '@tauri-apps/plugin-fs';

interface ExcelPreviewProps {
  filePath: string;
}

interface SheetData {
  name: string;
  headers: string[];
  rows: Record<string, any>[];
}

export const ExcelPreview: React.FC<ExcelPreviewProps> = ({ filePath }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetData[]>([]);

  useEffect(() => {
    const loadExcel = async () => {
      setLoading(true);
      setError(null);

      try {
        // Read file as binary
        const data = await readFile(filePath);
        const workbook = XLSX.read(data, { type: 'array' });

        const sheetsData: SheetData[] = [];

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

          if (jsonData.length === 0) {
            sheetsData.push({ name: sheetName, headers: [], rows: [] });
            continue;
          }

          // First row as headers
          const headers = (jsonData[0] || []).map((h, i) => String(h || `列${i + 1}`));
          
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

        setSheets(sheetsData);
      } catch (err) {
        console.error('Failed to load Excel:', err);
        setError('无法加载 Excel 文件');
      } finally {
        setLoading(false);
      }
    };

    loadExcel();
  }, [filePath]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spin tip="加载 Excel 中..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message="Excel 预览失败"
        description={error}
        type="error"
        showIcon
      />
    );
  }

  if (sheets.length === 0) {
    return <Alert message="Excel 文件为空" type="info" showIcon />;
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
        pagination={{
          pageSize: 50,
          showSizeChanger: false,
          showQuickJumper: true,
          size: 'small',
        }}
        style={{ 
          background: '#1a1a2e',
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
