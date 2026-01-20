import React, { useEffect, useState, useRef } from 'react';
import { Spin, Alert, Pagination, Space, Button } from 'antd';
import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { readFile } from '@tauri-apps/plugin-fs';
import * as pdfjsLib from 'pdfjs-dist';

// Set worker path to local file in public folder
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface PdfPreviewProps {
  filePath: string;
}

export const PdfPreview: React.FC<PdfPreviewProps> = ({ filePath }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [scale, setScale] = useState(1.2);
  const [rendering, setRendering] = useState(false);

  // Load PDF document
  useEffect(() => {
    let cancelled = false;
    
    const loadPdf = async () => {
      setLoading(true);
      setError(null);
      setPdfDoc(null);
      
      try {
        // Read PDF file as binary using Tauri fs
        const fileData = await readFile(filePath);
        
        if (cancelled) return;
        
        // Load PDF document
        const loadingTask = pdfjsLib.getDocument({
          data: fileData,
          useWorkerFetch: false,
          isEvalSupported: false,
          useSystemFonts: true,
        });
        
        const pdf = await loadingTask.promise;
        
        if (cancelled) return;
        
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
        setCurrentPage(1);
        setLoading(false);
      } catch (err: any) {
        console.error('Failed to load PDF:', err);
        if (!cancelled) {
          setError(`无法加载 PDF: ${err.message || '未知错误'}`);
          setLoading(false);
        }
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || rendering) return;

    const renderPage = async () => {
      setRendering(true);
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale });
        
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        await page.render(renderContext).promise;
      } catch (err) {
        console.error('Failed to render page:', err);
      } finally {
        setRendering(false);
      }
    };

    renderPage();
  }, [pdfDoc, currentPage, scale]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 60 }}>
        <Spin tip="加载 PDF 中..." size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        message="PDF 预览失败"
        description={error}
        type="error"
        showIcon
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      {/* Controls */}
      <Space>
        <Button
          size="small"
          icon={<ZoomOutOutlined />}
          onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          disabled={scale <= 0.5}
        />
        <span style={{ color: '#8c8c8c', fontSize: 12, minWidth: 50, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <Button
          size="small"
          icon={<ZoomInOutlined />}
          onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          disabled={scale >= 3}
        />
      </Space>
      
      {/* Canvas container */}
      <div
        style={{
          background: '#2a2a3e',
          borderRadius: 8,
          padding: 16,
          overflow: 'auto',
          maxHeight: 400,
          maxWidth: '100%',
          position: 'relative',
        }}
      >
        {rendering && (
          <div style={{ 
            position: 'absolute', 
            top: 0, 
            left: 0, 
            right: 0, 
            bottom: 0, 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
            zIndex: 10,
          }}>
            <Spin />
          </div>
        )}
        <canvas ref={canvasRef} style={{ display: 'block', margin: '0 auto' }} />
      </div>
      
      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination
          current={currentPage}
          total={totalPages}
          pageSize={1}
          onChange={(page) => setCurrentPage(page)}
          showSizeChanger={false}
          showQuickJumper
          size="small"
        />
      )}
    </div>
  );
};
