// 标书查重的展示面板：元数据 / 目录 / 正文 / 图片四个分析面板与分页、文件条。
//
// 这些原本是 DuplicateCheckPage.tsx 的模块级组件（已是显式 props），抽到 components/ 后页面只负责编排。

import { ProgressBar, UploadFilePill, useToast } from '../../../shared/ui';
import { useEffect, useMemo, useState } from 'react';
import type { DuplicateAnalysisStatus, DuplicateAnalysisTabId, DuplicateContentAnalysisState, DuplicateImageAnalysisState, DuplicateMetadataAnalysisState, DuplicateOutlineAnalysisState, LocalFileSelection } from '../../../shared/types';
import { analysisTabs, buildFileLabelMap, fileIndexLabel, formatDate, formatDuplicateSentenceText, formatFileSize, formatImageLocationSentence, progressText, statusLabel } from '../model';

function FilePill({ file, onRemove, disabled = false }: { file: LocalFileSelection; onRemove: () => void; disabled?: boolean }) {
  return (
    <UploadFilePill
      badge={file.extension.replace('.', '').slice(0, 4).toUpperCase() || 'DOC'}
      name={file.file_name}
      meta={`${formatFileSize(file.size)} · ${formatDate(file.modified_at)}`}
      onRemove={onRemove}
      removeDisabled={disabled}
      removeAriaLabel={`删除 ${file.file_name}`}
    />
  );
}

function DuplicateFileCodeBar({ files }: { files: LocalFileSelection[] }) {
  return (
    <div className="duplicate-file-codebar" aria-label="投标文件编号">
      {files.map((file, index) => (
        <span key={file.id} title={file.file_name}>
          <strong>{fileIndexLabel(index)}</strong>{file.file_name}
        </span>
      ))}
    </div>
  );
}

function PaginationControls({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="duplicate-pagination">
      <span>第 {Math.min(page, totalPages)} / {totalPages} 页，共 {total} 条</span>
      <div>
        <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>上一页</button>
        <button type="button" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages}>下一页</button>
      </div>
    </div>
  );
}

function DuplicateMetadataPane({ analysis, bidFiles }: { analysis?: DuplicateMetadataAnalysisState; bidFiles: LocalFileSelection[] }) {
  const isRunning = analysis?.status === 'running';
  const isDone = analysis?.status === 'success' || analysis?.status === 'error';
  const rows = analysis?.rows || [];
  const files = analysis?.files?.length ? analysis.files : bidFiles.map((file) => ({ file_id: file.id, file_name: file.file_name, status: 'pending' as const, metadata: [] }));

  return (
    <div className="duplicate-metadata-panel">
      <div className="duplicate-metadata-status-grid">
        <article>
          <span>正文内容提取</span>
          <strong>{progressText(analysis?.contentExtraction)}</strong>
          <small>{statusLabel(analysis?.contentExtraction?.status || 'pending')}</small>
        </article>
        <article>
          <span>元数据提取</span>
          <strong>{progressText(analysis?.metadataExtraction)}</strong>
          <small>{statusLabel(analysis?.metadataExtraction?.status || 'pending')}</small>
        </article>
      </div>

      {!analysis && (
        <div className="duplicate-analysis-empty">
          <strong>等待启动元数据分析</strong>
          <p>首次进入查重结果后，会自动并发执行正文内容提取和投标文件元数据提取。</p>
        </div>
      )}

      {analysis && !rows.length && (
        <div className="duplicate-analysis-empty">
          <strong>{isRunning ? '正在提取元数据' : '暂无可对比元数据'}</strong>
          <p>{analysis.message || '请稍候，文件较多时需要一定时间。'}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="duplicate-metadata-table-wrap">
          <table className="duplicate-metadata-table">
            <thead>
              <tr>
                <th>元数据项</th>
                {files.map((file) => <th key={file.file_id} title={file.file_name}>{file.file_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th>{row.label}</th>
                  {files.map((file) => {
                    const duplicated = row.duplicate_file_ids.includes(file.file_id);
                    const sameDay = row.same_day_file_ids?.includes(file.file_id);
                    return (
                      <td key={file.file_id} className={duplicated ? 'is-duplicate' : sameDay ? 'is-same-day' : undefined}>
                        {row.values[file.file_id] || '-'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isDone && analysis?.contentFiles?.some((file) => file.status === 'error') && (
        <p className="duplicate-analysis-warning">部分文件正文提取失败，可重新选择文件后再分析。</p>
      )}
    </div>
  );
}

function DuplicateOutlinePane({ analysis, bidFiles }: { analysis?: DuplicateOutlineAnalysisState; bidFiles: LocalFileSelection[] }) {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const labelMap = useMemo(() => buildFileLabelMap(bidFiles), [bidFiles]);
  const files = analysis?.files || [];
  const successfulFiles = files.filter((file) => file.status === 'success');
  const duplicateGroups = analysis?.duplicateGroups || [];
  const totalPages = Math.max(1, Math.ceil(duplicateGroups.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = duplicateGroups.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => setPage(1), [duplicateGroups.length]);

  function getOutlineGroupText(group: DuplicateOutlineAnalysisState['duplicateGroups'][number]) {
    const firstPath = group.file_ids.map((fileId) => group.paths[fileId]?.[0]).find(Boolean);
    return group.type === 'duplicate' && firstPath ? firstPath : group.title || firstPath || '未识别目录';
  }

  async function handleCopyOutline(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制重复目录', 'success');
    } catch {
      showToast('复制重复目录失败', 'error');
    }
  }

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待目录分析</strong><p>元数据提取完成后会自动开始目录分析。</p></div>;
  }

  return (
    <div className="duplicate-match-panel">
      <DuplicateFileCodeBar files={bidFiles} />
      {duplicateGroups.length ? (
        <section className="duplicate-match-card">
          <div className="duplicate-match-card-head">
            <strong>重复目录</strong>
            <span>{analysis.message} · 已排除招标目录 {analysis.tenderMatchedItemCount} 项</span>
          </div>
          <div className="duplicate-sentence-list duplicate-outline-list">
            {pageItems.map((group) => {
              const text = getOutlineGroupText(group);
              return (
                <article key={group.id}>
                  <div className="duplicate-sentence-content">
                    <p>
                      {text}
                      <button
                        type="button"
                        className="duplicate-sentence-copy"
                        onClick={() => void handleCopyOutline(text)}
                        aria-label="复制重复目录"
                      >
                        复制
                      </button>
                    </p>
                  </div>
                  <div className="duplicate-file-badges">
                    {group.file_ids.map((fileId) => {
                      const count = group.paths[fileId]?.length || group.item_ids[fileId]?.length || 1;
                      return (
                        <span key={fileId} title={bidFiles.find((file) => file.id === fileId)?.file_name || fileId}>
                          {labelMap.get(fileId) || '?'}{count > 1 ? ` x${count}` : ''}
                        </span>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          <PaginationControls page={currentPage} pageSize={pageSize} total={duplicateGroups.length} onPageChange={setPage} />
        </section>
      ) : (
        <div className="duplicate-analysis-empty">
          <strong>{analysis.status === 'running' ? '正在分析目录' : '未发现重复目录'}</strong>
          <p>{analysis.status === 'running' ? analysis.message : successfulFiles.length > 0 ? '未发现投标文件之间的目录重复；来自招标文件的目录项已自动排除。' : '暂无可用目录结果。'}</p>
        </div>
      )}
    </div>
  );
}

function DuplicateContentPane({ analysis, bidFiles }: { analysis?: DuplicateContentAnalysisState; bidFiles: LocalFileSelection[] }) {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const labelMap = useMemo(() => buildFileLabelMap(bidFiles), [bidFiles]);
  const duplicateSentences = analysis?.duplicateSentences || [];
  const totalPages = Math.max(1, Math.ceil(duplicateSentences.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = duplicateSentences.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => setPage(1), [duplicateSentences.length]);

  async function handleCopySentence(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制重复句子', 'success');
    } catch {
      showToast('复制重复句子失败', 'error');
    }
  }

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待正文比对</strong><p>正文内容提取完成后会自动开始句子级比对。</p></div>;
  }

  return (
    <div className="duplicate-match-panel">
      <DuplicateFileCodeBar files={bidFiles} />
      {duplicateSentences.length ? (
        <section className="duplicate-match-card">
          <div className="duplicate-match-card-head">
            <strong>重复句子</strong>
            <span>{analysis.message} · 已排除招标引用 {analysis.tenderMatchedSentenceCount} 句</span>
          </div>
          <div className="duplicate-sentence-list">
            {pageItems.map((item) => (
              <article key={item.id}>
                <div className="duplicate-sentence-content">
                  <p>
                    {formatDuplicateSentenceText(item.normalized, item.sentence)}
                    <button
                      type="button"
                      className="duplicate-sentence-copy"
                      onClick={() => void handleCopySentence(item.sentence || item.normalized)}
                      aria-label="复制重复句子"
                    >
                      复制
                    </button>
                  </p>
                </div>
                <div className="duplicate-file-badges">
                  {item.file_ids.map((fileId) => (
                    <span key={fileId} title={bidFiles.find((file) => file.id === fileId)?.file_name || fileId}>
                      {labelMap.get(fileId) || '?'}{item.occurrences[fileId] > 1 ? ` x${item.occurrences[fileId]}` : ''}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <PaginationControls page={currentPage} pageSize={pageSize} total={duplicateSentences.length} onPageChange={setPage} />
        </section>
      ) : (
        <div className="duplicate-analysis-empty">
          <strong>{analysis.status === 'running' ? '正在比对正文' : '未发现重复句子'}</strong>
          <p>{analysis.status === 'running' ? analysis.message : '未发现投标文件之间的重复句子；引用招标文件的句子已自动排除。'}</p>
        </div>
      )}
    </div>
  );
}

function DuplicateImagePane({ analysis, bidFiles }: { analysis?: DuplicateImageAnalysisState; bidFiles: LocalFileSelection[] }) {
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const pageSize = 24;
  const labelMap = useMemo(() => buildFileLabelMap(bidFiles), [bidFiles]);
  const duplicateImages = analysis?.duplicateImages || [];
  const totalPages = Math.max(1, Math.ceil(duplicateImages.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = duplicateImages.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => setPage(1), [duplicateImages.length]);

  async function handleCopyImageLocation(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制定位线索', 'success');
    } catch {
      showToast('复制定位线索失败', 'error');
    }
  }

  if (!analysis) {
    return <div className="duplicate-analysis-empty"><strong>等待图片比对</strong><p>正文内容提取完成后会自动按图片 hash 比对。</p></div>;
  }

  return (
    <div className="duplicate-match-panel">
      <DuplicateFileCodeBar files={bidFiles} />
      {duplicateImages.length ? (
        <section className="duplicate-match-card">
          <div className="duplicate-match-card-head">
            <strong>重复图片</strong>
            <span>{analysis.message} · 共识别 {analysis.totalImageCount} 张图片</span>
          </div>
          <div className="duplicate-image-grid">
            {pageItems.map((item) => {
              const locationEntries = item.file_ids.flatMap((fileId) => {
                const location = item.locations?.[fileId]?.[0];
                return location ? [{ fileId, location }] : [];
              });
              return (
                <article key={item.id}>
                  <div className="duplicate-image-preview">
                    <img src={item.preview_url} alt={`重复图片 ${item.hash.slice(0, 10)}`} loading="lazy" />
                  </div>
                  <strong>Hash {item.hash.slice(0, 12)}</strong>
                  <div className="duplicate-file-badges">
                    {item.file_ids.map((fileId) => (
                      <span key={fileId} title={bidFiles.find((file) => file.id === fileId)?.file_name || fileId}>
                        {labelMap.get(fileId) || '?'}{item.occurrences[fileId] > 1 ? ` x${item.occurrences[fileId]}` : ''}
                      </span>
                    ))}
                  </div>
                  {locationEntries.length > 0 && (
                    <div className="duplicate-image-locations">
                      {locationEntries.map((entry) => (
                        <div key={entry.fileId} className="duplicate-image-location">
                          <span>{labelMap.get(entry.fileId) || '?'}：{entry.location.directory || '未识别目录'}</span>
                          <p title={entry.location.previous_sentence || undefined}>前文：{entry.location.previous_sentence ? formatImageLocationSentence(entry.location.previous_sentence) : '未提取到图片前文'}</p>
                          <button type="button" onClick={() => void handleCopyImageLocation(entry.location.previous_sentence)} disabled={!entry.location.previous_sentence}>复制定位线索</button>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <PaginationControls page={currentPage} pageSize={pageSize} total={duplicateImages.length} onPageChange={setPage} />
        </section>
      ) : (
        <div className="duplicate-analysis-empty">
          <strong>{analysis.status === 'running' ? '正在比对图片' : '未发现重复图片'}</strong>
          <p>{analysis.status === 'running' ? analysis.message : '未发现投标文件之间完全相同的图片。'}</p>
        </div>
      )}
    </div>
  );
}

function DuplicateAnalysisPane({ activeTab, onTabChange, metadataAnalysis, outlineAnalysis, contentAnalysis, imageAnalysis, bidFiles, startingAnalysis, onRerun }: { activeTab: DuplicateAnalysisTabId; onTabChange: (tab: DuplicateAnalysisTabId) => void; metadataAnalysis?: DuplicateMetadataAnalysisState; outlineAnalysis?: DuplicateOutlineAnalysisState; contentAnalysis?: DuplicateContentAnalysisState; imageAnalysis?: DuplicateImageAnalysisState; bidFiles: LocalFileSelection[]; startingAnalysis: boolean; onRerun: () => void }) {
  const activeItem = analysisTabs.find((item) => item.id === activeTab) || analysisTabs[0];
  const metadataStatus = metadataAnalysis?.status || 'pending';
  const metadataProgress = metadataAnalysis?.status === 'success' || metadataAnalysis?.status === 'error'
    ? 100
    : metadataAnalysis?.metadataExtraction?.total
      ? Math.round((metadataAnalysis.metadataExtraction.completed / metadataAnalysis.metadataExtraction.total) * 100)
      : 0;
  const analysisRunning = startingAnalysis || metadataStatus === 'running' || outlineAnalysis?.status === 'running' || contentAnalysis?.status === 'running' || imageAnalysis?.status === 'running';

  return (
    <section className="duplicate-analysis-panel">
      <div className="duplicate-page-title duplicate-analysis-title">
        <div>
          <span className="section-kicker">STEP 02</span>
          <h2>查重结果</h2>
        </div>
        <button type="button" className="secondary-action" onClick={onRerun} disabled={!bidFiles.length || analysisRunning}>
          {analysisRunning ? '分析中...' : '重新查重'}
        </button>
      </div>

      <div className="duplicate-analysis-tabs" role="tablist" aria-label="标书查重维度">
        {analysisTabs.map((item) => {
          const isActive = item.id === activeTab;
          const status: DuplicateAnalysisStatus = item.id === 'metadata'
            ? metadataStatus
            : item.id === 'outline'
              ? outlineAnalysis?.status || 'pending'
              : item.id === 'content'
                ? contentAnalysis?.status || 'pending'
                : item.id === 'image'
                  ? imageAnalysis?.status || 'pending'
                  : 'pending';
          const progress = item.id === 'metadata'
            ? metadataProgress
            : item.id === 'outline'
              ? outlineAnalysis?.progress || 0
              : item.id === 'content'
                ? contentAnalysis?.progress || 0
                : item.id === 'image'
                  ? imageAnalysis?.progress || 0
                  : 0;
          const isRunning = status === 'running';

          return (
            <button
              type="button"
              className={`duplicate-analysis-tab${isActive ? ' is-active' : ''} is-${status}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`duplicate-analysis-panel-${item.id}`}
              id={`duplicate-analysis-tab-${item.id}`}
              key={item.id}
              onClick={() => onTabChange(item.id)}
            >
              <span className="duplicate-analysis-tab-main">
                <strong>{item.label}</strong>
                <em>{statusLabel(status)}</em>
              </span>
              {status !== 'pending' && (
                <ProgressBar value={progress} label={`${item.label}分析进度 ${progress}%`} />
              )}
            </button>
          );
        })}
      </div>

      <div
        className="duplicate-analysis-content"
        role="tabpanel"
        id={`duplicate-analysis-panel-${activeItem.id}`}
        aria-labelledby={`duplicate-analysis-tab-${activeItem.id}`}
      >
        {activeItem.id === 'metadata' ? (
          <DuplicateMetadataPane analysis={metadataAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'outline' ? (
          <DuplicateOutlinePane analysis={outlineAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'content' ? (
          <DuplicateContentPane analysis={contentAnalysis} bidFiles={bidFiles} />
        ) : activeItem.id === 'image' ? (
          <DuplicateImagePane analysis={imageAnalysis} bidFiles={bidFiles} />
        ) : (
          <>
            <span className="section-kicker">{activeItem.label}</span>
            <h3>{activeItem.label}查重结果区域</h3>
            <p>这里先保留内容骨架，后续接入查重任务后展示分析日志、重复项列表和处理结果。</p>
          </>
        )}
      </div>
    </section>
  );
}

export {
  FilePill,
  DuplicateFileCodeBar,
  PaginationControls,
  DuplicateMetadataPane,
  DuplicateOutlinePane,
  DuplicateContentPane,
  DuplicateImagePane,
  DuplicateAnalysisPane,
};
