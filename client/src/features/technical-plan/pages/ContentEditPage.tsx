import * as Dialog from '@radix-ui/react-dialog';
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import type { ImageModelStatus, OutlineContentMode, OutlineData, OutlineItem, OutlineWordControlOptions } from '../../../shared/types';
import type { BackgroundTaskState, ContentGenerationOptions, ContentGenerationSections, ContentIllustrationKind, ContentIllustrationPlanState, TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import aiImageExampleUrl from '../../../../assets/generate_img_example/ai.png';
import mermaidImageExampleUrl from '../../../../assets/generate_img_example/mermaid.png';
import htmlImageExampleUrl from '../../../../assets/generate_img_example/html.png';
import { buildOutlineMeta, consistencyRepairModeOptions, getLeafContent, getLeafStatus, illustrationKinds, originalPlanCoverageRepairModeOptions, statusLabels, tableRequirementOptions } from '../contentEditModel';
import type { OutlineNodeMeta } from '../contentEditModel';
import { findOutlineItem } from '../outlineTree';
import { buildContentProgressViewModel } from '../contentProgressModel';
import { collectLeafItems } from '../../../shared/utils/outlineMetrics';
import { ContinuePostProcessingDialog, GenerationDialog, HtmlImageTypesDialog, RequirementItemDialog, PreviewImageDialog } from '../components/contentEditDialogs';
import { ContentOutlineTree } from '../components/ContentOutlineTree';
import { useContentGeneration } from '../hooks/useContentGeneration';


interface ContentEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  contentIllustrationPlan?: ContentIllustrationPlanState;
  sections: ContentGenerationSections;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void> | void;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
}




const pendingModeDescriptions: Record<Exclude<OutlineContentMode, 'ai-generate'>, string> = {
  'template-fill': '该小节已标记为模板填写，后续将从招标文件提取并填充内容。',
  'point-to-point': '该小节已标记为点对点应答表，后续将在正文完成并确定 Word 页码后回填。',
  other: '该小节采用其他处理模式，暂不进入 AI 正文生成流程。',
};

const imageModelStatusLabels: Record<ImageModelStatus, string> = {
  untested: '未测试',
  available: '可用',
  unavailable: '不可用',
};




const illustrationKindLabels: Record<ContentIllustrationKind, string> = {
  html: 'HTML 图片',
  mermaid: 'Mermaid 图片',
  ai: 'AI 图片',
};


const imageGenerationExamples: Record<ContentIllustrationKind, { src: string; alt: string }> = {
  ai: { src: aiImageExampleUrl, alt: 'AI 生图示例' },
  mermaid: { src: mermaidImageExampleUrl, alt: 'Mermaid 生图示例' },
  html: { src: htmlImageExampleUrl, alt: 'HTML 生图示例' },
};
















const MarkdownContent = memo(function MarkdownContent({ content, onPreviewImage }: { content: string; onPreviewImage: (src: string, alt: string) => void }) {
  return (
    <MarkdownRenderer
      imageMode="preview"
      imageClassName="markdown-clickable-image"
      renderMermaid
      onPreviewImage={onPreviewImage}
    >
      {content}
    </MarkdownRenderer>
  );
});

function ContentEditPage({
  workflowKind,
  outlineWordControlSnapshot,
  outlineData,
  task,
  contentGenerationOptions,
  contentIllustrationPlan,
  sections,
  onContentGenerationOptionsChange,
  onContentSaved,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const allLeaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const leaves = useMemo(() => allLeaves.filter((item) => item.content_mode === 'ai-generate'), [allLeaves]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [confirmRegenerateItem, setConfirmRegenerateItem] = useState<OutlineItem | null>(null);
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [imageModelStatus, setImageModelStatus] = useState<ImageModelStatus>('untested');
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [pausePending, setPausePending] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [developerMode, setDeveloperMode] = useState(false);
  const firstLeafId = allLeaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findOutlineItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const exportFormatPreviewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(exportFormat), [exportFormat]);
  const running = task?.status === 'running';
  const pausing = task?.status === 'pausing' || pausePending;
  const paused = task?.status === 'paused';
  const taskFailed = task?.status === 'error';
  const taskInFlight = running || pausing;
  const phaseVisible = taskInFlight || paused || taskFailed;
  const taskBlocksGeneration = taskInFlight || paused;
  const contentStats = task?.stats?.content;
  const progressDetail = task?.progress_detail;
  const illustrationStats = useMemo(() => {
    const stats: Record<ContentIllustrationKind, { planned: number; success: number }> = {
      html: { planned: 0, success: 0 },
      mermaid: { planned: 0, success: 0 },
      ai: { planned: 0, success: 0 },
    };

    contentIllustrationPlan?.items.forEach((item) => {
      stats[item.kind].planned += 1;
      if (item.generation?.status === 'success') {
        stats[item.kind].success += 1;
      }
    });

    return stats;
  }, [contentIllustrationPlan]);
  const planning = phaseVisible && contentStats?.phase === 'planning';
  const outlineMeta = useMemo(() => outlineData?.outline ? buildOutlineMeta(outlineData.outline, sections, planning) : new Map<string, OutlineNodeMeta>(), [outlineData, planning, sections]);
  const contentSummary = useMemo(() => leaves.reduce((summary, item) => {
    const status = getLeafStatus(item, sections);
    return {
      completedCount: summary.completedCount + (status === 'success' ? 1 : 0),
      failedCount: summary.failedCount + (status === 'error' ? 1 : 0),
      ignoredCount: summary.ignoredCount + (status === 'ignored' ? 1 : 0),
      totalWords: summary.totalWords + (status === 'ignored' ? 0 : (outlineMeta.get(item.id)?.words || 0)),
    };
  }, { completedCount: 0, failedCount: 0, ignoredCount: 0, totalWords: 0 }), [leaves, outlineMeta, sections]);

  const {
    illustrationPlannedTotal,
    illustrationSuccessTotal,
    showIllustrationStats,
    resolvedCount,
    unresolvedCount,
    modeCounts,
    pendingCount,
    canRetryContentCorrection,
    awaitingContentDecision,
    generationStrategyLocked,
    contentRetryTargetLabel,
    displayProgress,
    displayProgressLabel,
    displayProgressCount,
    progressPhaseLabel,
    progressTone,
    progressActive,
    progressDescription,
    selectedStatus,
    generationButtonLabel,
    editing,
  } = buildContentProgressViewModel({
    planning,
    task,
    outlineWordControlSnapshot,
    running,
    pausing,
    paused,
    taskFailed,
    taskInFlight,
    phaseVisible,
    contentStats,
    progressDetail,
    illustrationStats,
    contentIllustrationPlan,
    developerMode,
    outlineMeta,
    contentSummary,
    leaves,
    allLeaves,
    selectedItem,
    selectedIsLeaf,
    editingItemId,
  });
  const { completedCount, failedCount, ignoredCount, totalWords } = contentSummary;
  const imageModelAvailable = imageModelStatus === 'available';

  const handlePreviewImage = useCallback((src: string, alt: string) => setPreviewImage({ src, alt }), []);

  useEffect(() => {
    if (!outlineData?.outline?.length) {
      setSelectedItemId('');
      return;
    }

    if (!selectedItemId || !findOutlineItem(outlineData.outline, selectedItemId)) {
      setSelectedItemId(firstLeafId || outlineData.outline[0].id);
    }
  }, [firstLeafId, outlineData, selectedItemId]);

  useEffect(() => {
    window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config.developer_mode));
        setImageModelStatus(config.image_model?.status || 'untested');
        if (config.export_format) {
          setExportFormat(config.export_format);
        }
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    if (task?.status !== 'running') {
      setPausePending(false);
    }
  }, [task?.status]);

  useEffect(() => {
    if (!selectedItem || selectedItem.id === editingItemId) {
      return;
    }
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const {
    generationDialogOpen,
    setGenerationDialogOpen,
    continuePostProcessingDialogOpen,
    setContinuePostProcessingDialogOpen,
    draftGenerationOptions,
    setDraftGenerationOptions,
    htmlImageTypesDialogOpen,
    setHtmlImageTypesDialogOpen,
    htmlImageTypesDraft,
    setHtmlImageTypesDraft,
    requirementItem,
    setRequirementItem,
    regenerateRequirement,
    setRegenerateRequirement,
    openGenerationDialog,
    saveGenerationOptions,
    openHtmlImageTypesDialog,
    confirmHtmlImageTypes,
    retryFailedSections,
    continuePostProcessing,
    rerunIllustrations,
    handleGenerationButtonClick,
    startGeneration,
    startSectionRegeneration,
  } = useContentGeneration({
    outlineData,
    leaves,
    isExpansionWorkflow,
    contentGenerationOptions,
    contentIllustrationPlan,
    onContentGenerationOptionsChange,
    imageModelStatus,
    setImageModelStatus,
    imageModelAvailable,
    running,
    paused,
    taskInFlight,
    taskBlocksGeneration,
    setPausePending,
    resolvedCount,
    unresolvedCount,
    awaitingContentDecision,
    canRetryContentCorrection,
    contentRetryTargetLabel,
    setSelectedItemId,
    setEditingItemId,
    setIsPreviewing,
    setDraftContent,
  });



  const startEditingContent = () => {
    if (taskBlocksGeneration) {
      showToast('请先完成当前正文生成任务，再编辑正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }

    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const togglePreview = () => {
    setIsPreviewing((prev) => !prev);
  };

  const cancelEditingContent = () => {
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  };

  const saveEditingContent = async () => {
    if (taskBlocksGeneration) {
      showToast('当前正文生成任务正在运行或已暂停，暂不能保存正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) {
      return;
    }

    try {
      await onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
      showToast('正文已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先在目录生成步骤完成技术方案目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className={`plan-step-body content-generation-page${showIllustrationStats ? ' has-dev-stats' : ''}`}>
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP 05</span>
          <strong>正文生成</strong>
          <p>只对标记为“AI生成”的叶子小节生成正文，其他模式保留为待处理。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个 AI 小节</span>
          <span><strong>{completedCount}</strong> 已生成</span>
          {ignoredCount > 0 && <span><strong>{ignoredCount}</strong> 已忽略</span>}
          <span title={`模板填写 ${modeCounts['template-fill']}，点对点应答表 ${modeCounts['point-to-point']}，其他模式 ${modeCounts.other}`}><strong>{pendingCount}</strong> 待处理</span>
          <span><strong>{totalWords}</strong> 字</span>
        </div>
        <div className="content-generation-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={openGenerationDialog}
            disabled={taskInFlight || !leaves.length}
            aria-label="打开正文生成配置"
            title="正文生成配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          {awaitingContentDecision ? (
            <>
              {unresolvedCount > 0 && (
                <button type="button" className="primary-action" onClick={() => void retryFailedSections()} disabled={taskBlocksGeneration}>
                  重试失败小节
                </button>
              )}
              <button type="button" className="secondary-action" onClick={() => setContinuePostProcessingDialogOpen(true)} disabled={taskBlocksGeneration}>
                继续后续流程
              </button>
            </>
          ) : (
            <button type="button" className="primary-action" onClick={handleGenerationButtonClick} disabled={pausing || !leaves.length}>
              {generationButtonLabel}
            </button>
          )}
        </div>
      </section>

      {showIllustrationStats && (
        <aside className="content-dev-stats-panel" aria-label="开发者配图统计">
          <div className="content-dev-stats-summary">
            <strong>配图统计</strong>
            <span>共编排 <b>{illustrationPlannedTotal}</b>，成功 <b>{illustrationSuccessTotal}</b></span>
          </div>
          {illustrationKinds.map((kind) => (
            <span className="content-dev-image-stat" key={kind}>
              <strong>{illustrationKindLabels[kind]}</strong>
              编排 <b>{illustrationStats[kind].planned}</b>
              成功 <b>{illustrationStats[kind].success}</b>
            </span>
          ))}
          <button
            type="button"
            className="secondary-action content-dev-stats-action"
            disabled={taskBlocksGeneration}
            onClick={() => void rerunIllustrations()}
          >仅重新配图</button>
        </aside>
      )}

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>标书目录</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className={`content-outline-stats${statsCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setStatsCollapsed((prev) => !prev)} aria-expanded={!statsCollapsed}>
              <span>{displayProgressLabel}</span>
              <strong>{displayProgressCount}</strong>
              <em>{statsCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!statsCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={displayProgress} tone={progressTone} active={progressActive} label={`${progressPhaseLabel}进度 ${displayProgress}%`} />
                <p>{progressDescription}</p>
                {failedCount > 0 && <small>失败 {failedCount} 个小节</small>}
              </div>
            )}
          </div>
          <div className="content-outline-list">
            <ContentOutlineTree
              items={outlineData.outline}
              outlineMeta={outlineMeta}
              selectedItemId={selectedItemId}
              exportFormat={exportFormat}
              taskBlocksGeneration={taskBlocksGeneration}
              confirmRegenerateItem={confirmRegenerateItem}
              onSelectItem={setSelectedItemId}
              onRegenerateItemChange={setConfirmRegenerateItem}
              onRequestRequirement={(item) => {
                setRequirementItem(item);
                setRegenerateRequirement('');
              }}
            />
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.id} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedStatus}`}>{statusLabels[selectedStatus]}</span>
              {editing ? (
                <>
                  <button type="button" className={isPreviewing ? 'secondary-action' : 'primary-action'} onClick={togglePreview}>
                    {isPreviewing ? '编辑' : '预览'}
                  </button>
                  <button type="button" className="primary-action" onClick={saveEditingContent} disabled={taskBlocksGeneration}>保存</button>
                  <button type="button" className="secondary-action" onClick={cancelEditingContent}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditingContent} disabled={!selectedItem || !selectedIsLeaf || taskBlocksGeneration}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <MarkdownEditor
              value={draftContent}
              onChange={setDraftContent}
              placeholder="输入 Markdown 正文..."
              disabled={taskBlocksGeneration}
            />
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title="正文预览全屏查看">
              {draftContent.trim() ? (
                <MarkdownContent content={draftContent} onPreviewImage={handlePreviewImage} />
              ) : (
                <p className="content-editor-empty">暂无预览内容</p>
              )}
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title={`${selectedItem.id} ${selectedItem.title}全屏查看`}>
              <MarkdownContent content={selectedContent} onPreviewImage={handlePreviewImage} />
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error'
                ? sections[selectedItem.id]?.error || '正文生成失败'
                : getLeafStatus(selectedItem, sections) === 'ignored'
                  ? '该小节已按用户选择忽略'
                  : selectedItem.content_mode === 'ai-generate' ? '正文待生成' : '该小节等待后续处理'}</strong>
              <p>{getLeafStatus(selectedItem, sections) === 'ignored'
                ? '该小节不参与一致性检查、字数调整和图片编排；如需补充，可直接编辑正文。'
                : selectedItem.content_mode && selectedItem.content_mode !== 'ai-generate'
                ? `${pendingModeDescriptions[selectedItem.content_mode]}${selectedItem.content_mode === 'other' && selectedItem.content_mode_note ? ` ${selectedItem.content_mode_note}` : ''}`
                : taskInFlight ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : paused ? '任务已暂停，可先导出当前内容或点击继续。' : '点击生成正文后，后台会按 AI 生成小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>
      </section>

      <ContinuePostProcessingDialog continuePostProcessing={continuePostProcessing} continuePostProcessingDialogOpen={continuePostProcessingDialogOpen} setContinuePostProcessingDialogOpen={setContinuePostProcessingDialogOpen} unresolvedCount={unresolvedCount} />

      <GenerationDialog consistencyRepairModeOptions={consistencyRepairModeOptions} developerMode={developerMode} draftGenerationOptions={draftGenerationOptions} generationDialogOpen={generationDialogOpen} generationStrategyLocked={generationStrategyLocked} imageGenerationExamples={imageGenerationExamples} imageModelAvailable={imageModelAvailable} imageModelStatus={imageModelStatus} imageModelStatusLabels={imageModelStatusLabels} isExpansionWorkflow={isExpansionWorkflow} leaves={leaves} openHtmlImageTypesDialog={openHtmlImageTypesDialog} originalPlanCoverageRepairModeOptions={originalPlanCoverageRepairModeOptions} paused={paused} saveGenerationOptions={saveGenerationOptions} setDraftGenerationOptions={setDraftGenerationOptions} setGenerationDialogOpen={setGenerationDialogOpen} setHtmlImageTypesDialogOpen={setHtmlImageTypesDialogOpen} setPreviewImage={setPreviewImage} startGeneration={startGeneration} tableRequirementOptions={tableRequirementOptions} taskBlocksGeneration={taskBlocksGeneration} taskInFlight={taskInFlight} />

      <HtmlImageTypesDialog confirmHtmlImageTypes={confirmHtmlImageTypes} htmlImageTypesDialogOpen={htmlImageTypesDialogOpen} htmlImageTypesDraft={htmlImageTypesDraft} setHtmlImageTypesDialogOpen={setHtmlImageTypesDialogOpen} setHtmlImageTypesDraft={setHtmlImageTypesDraft} />

      <RequirementItemDialog regenerateRequirement={regenerateRequirement} requirementItem={requirementItem} setRegenerateRequirement={setRegenerateRequirement} setRequirementItem={setRequirementItem} startSectionRegeneration={startSectionRegeneration} taskBlocksGeneration={taskBlocksGeneration} />
      <PreviewImageDialog previewImage={previewImage} setPreviewImage={setPreviewImage} />
    </div>
  );
}

export default ContentEditPage;
