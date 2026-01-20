import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Spin, Alert, Space, Button, Typography } from 'antd';
import { ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { readFile } from '@tauri-apps/plugin-fs';
import * as pdfjsLib from 'pdfjs-dist';
import { useThemeColors } from '../../hooks';

// Set worker path to local file in public folder
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

const { Text } = Typography;

interface PdfPreviewProps {
  filePath: string;
}

export const PdfPreview: React.FC<PdfPreviewProps> = ({ filePath }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderingRef = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [scale, setScale] = useState(0.8);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());
  const colors = useThemeColors();

  // Load PDF document
  useEffect(() => {
    let cancelled = false;
    
    const loadPdf = async () => {
      setLoading(true);
      setError(null);
      setPdfDoc(null);
      setRenderedPages(new Set());
      canvasRefs.current.clear();
      renderingRef.current.clear();
      
      try {
        const fileData = await readFile(filePath);
        
        if (cancelled) return;
        
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

  // 渲染单页
  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdfDoc) return;
    if (renderingRef.current.has(pageNum)) return;
    
    const canvas = canvasRefs.current.get(pageNum);
    if (!canvas) return;
    
    renderingRef.current.add(pageNum);
    
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.height = viewport.height;
      canvas.width = viewport.width;

      await page.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;
      
      setRenderedPages(prev => new Set(prev).add(pageNum));
    } catch (err) {
      console.error('Failed to render page:', pageNum, err);
    } finally {
      renderingRef.current.delete(pageNum);
    }
  }, [pdfDoc, scale]);

  // 检查可见页面并渲染
  const checkAndRenderVisiblePages = useCallback(() => {
    if (!containerRef.current || !pdfDoc) return;
    
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    
    canvasRefs.current.forEach((canvas, pageNum) => {
      const wrapper = canvas.parentElement;
      if (!wrapper) return;
      
      const rect = wrapper.getBoundingClientRect();
      const isVisible = (
        rect.bottom >= containerRect.top - 100 &&
        rect.top <= containerRect.bottom + 100
      );
      
      if (isVisible && !renderedPages.has(pageNum)) {
        renderPage(pageNum);
      }
    });
  }, [pdfDoc, renderedPages, renderPage]);

  // PDF 加载完成后渲染初始可见页面
  useEffect(() => {
    if (!pdfDoc || totalPages === 0) return;
    
    // 延迟执行以确保 canvas 已挂载
    const timer = setTimeout(() => {
      checkAndRenderVisiblePages();
    }, 100);
    
    return () => clearTimeout(timer);
  }, [pdfDoc, totalPages, checkAndRenderVisiblePages]);

  // 缩放变化时重新渲染
  useEffect(() => {
    if (!pdfDoc) return;
    setRenderedPages(new Set());
    renderingRef.current.clear();
    
    const timer = setTimeout(() => {
      checkAndRenderVisiblePages();
    }, 100);
    
    return () => clearTimeout(timer);
  }, [scale]);

  // 滚动时检查并渲染可见页面
  const handleScroll = useCallback(() => {
    checkAndRenderVisiblePages();
  }, [checkAndRenderVisiblePages]);

  // Set canvas ref
  const setCanvasRef = useCallback((pageNum: number, el: HTMLCanvasElement | null) => {
    if (el) {
      canvasRefs.current.set(pageNum, el);
    }
  }, []);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          共 {totalPages} 页
        </Text>
        <Space>
          <Button
            size="small"
            icon={<ZoomOutOutlined />}
            onClick={() => setScale((s) => Math.max(0.3, s - 0.2))}
            disabled={scale <= 0.3}
          />
          <span style={{ color: colors.textSecondary, fontSize: 12, minWidth: 50, textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </span>
          <Button
            size="small"
            icon={<ZoomInOutlined />}
            onClick={() => setScale((s) => Math.min(2, s + 0.2))}
            disabled={scale >= 2}
          />
        </Space>
      </div>
      
      {/* Scrollable pages container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          background: colors.bgSecondary,
          borderRadius: 8,
          padding: 16,
          overflow: 'auto',
          maxHeight: 500,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          alignItems: 'center',
        }}
      >
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
          <div
            key={pageNum}
            style={{
              position: 'relative',
              background: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              borderRadius: 4,
              minHeight: 200,
              minWidth: 150,
            }}
          >
            {/* Page number indicator */}
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                zIndex: 5,
              }}
            >
              {pageNum} / {totalPages}
            </div>
            
            {/* Loading overlay for unrendered pages */}
            {!renderedPages.has(pageNum) && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(255,255,255,0.8)',
                  zIndex: 10,
                  minHeight: 200,
                }}
              >
                <Spin size="small" />
              </div>
            )}
            
            <canvas
              ref={(el) => setCanvasRef(pageNum, el)}
              style={{ display: 'block' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
