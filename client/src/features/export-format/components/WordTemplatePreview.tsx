// Word 真样张预览：用 @docx-editor 打开 OpenXmlHelper 渲染出的 DOCX。
// 与 HTML 模板预览并存：此处只负责「像 Word 一样看版面」，表单样式仍由 ExportFormatConfig 控制。

import { useCallback, useEffect, useRef, useState } from 'react';
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DOCUMENT_DISPLAY_TEMPLATE_HTML } from '../../../shared/bodyHtml/documentTemplate';

const PREVIEW_REBUILD_DELAY_MS = 400;

interface WordTemplatePreviewProps {
  config: ExportFormatConfig;
}

interface PreviewState {
  documentKey: string;
  document: Uint8Array | null;
  loading: boolean;
  error: string;
}

export function WordTemplatePreview({ config }: WordTemplatePreviewProps) {
  const [preview, setPreview] = useState<PreviewState>({
    documentKey: '',
    document: null,
    loading: true,
    error: '',
  });
  const editorRef = useRef<DocxEditorRef | null>(null);
  const readyRef = useRef(false);
  const loadedKeyRef = useRef('');
  const runningRef = useRef(false);
  const renderedKeyRef = useRef('');
  const mountedRef = useRef(true);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 配置指纹忽略模板名称，改名不应重排样张。
  const requestKey = JSON.stringify({ ...config, template_name: '' });

  useEffect(() => {
    if (runningRef.current) return undefined;
    if (requestKey === renderedKeyRef.current) return undefined;

    const delayMs = renderedKeyRef.current ? PREVIEW_REBUILD_DELAY_MS : 0;
    const timer = window.setTimeout(() => {
      runningRef.current = true;
      setPreview((current) => ({ ...current, loading: true, error: '' }));
      void (async () => {
        try {
          const result = await window.yibiao.templates.renderPreview(
            DOCUMENT_DISPLAY_TEMPLATE_HTML,
            { ...configRef.current, template_name: '' },
          );
          renderedKeyRef.current = requestKey;
          if (!mountedRef.current) return;
          setPreview({
            documentKey: result.key,
            document: result.bytes,
            loading: false,
            error: '',
          });
        } catch (reason) {
          renderedKeyRef.current = requestKey;
          if (!mountedRef.current) return;
          setPreview((current) => ({
            ...current,
            loading: false,
            error: reason instanceof Error ? reason.message : 'Word 样张生成失败',
          }));
        } finally {
          runningRef.current = false;
        }
      })();
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [requestKey]);

  const applyDocument = useCallback(() => {
    if (!readyRef.current || !preview.document) return;
    if (loadedKeyRef.current === preview.documentKey) return;
    loadedKeyRef.current = preview.documentKey;
    editorRef.current?.load(preview.document);
  }, [preview.document, preview.documentKey]);

  useEffect(() => {
    applyDocument();
  }, [applyDocument]);

  return (
    <aside className="settings-page-section export-template-preview-panel" aria-label="Word 样张预览">
      <div className="export-template-preview-scroll">
        <DocxEditor
          ref={editorRef}
          className="export-template-docx-editor"
          mode="edit"
          chrome={false}
          navigation={false}
          rulers={false}
          onReady={() => {
            readyRef.current = true;
            applyDocument();
          }}
        />
        {!preview.document && (
          <div className="export-template-preview-empty" role="status">
            {preview.error || '正在生成 Word 样张…'}
          </div>
        )}
        {preview.document && preview.loading && (
          <div className="export-template-preview-loading" role="status">正在更新 Word 样张…</div>
        )}
        {preview.document && preview.error && (
          <div className="export-template-preview-error" role="alert">{preview.error}</div>
        )}
      </div>
    </aside>
  );
}
