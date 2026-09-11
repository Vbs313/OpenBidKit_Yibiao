import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { ProgressBar, useToast } from '../../../shared/ui';
import type { BackgroundTaskState, OutlineSelectionItem, SaveOutlineRequest, SaveOutlineSelectionRequest, TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { OutlineContentMode, OutlineData, OutlineExpansionMode, OutlineItem, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import {
  assertLeafContentModes,
  collectOutlineIds,
  collectRootIds,
  findOutlineItem,
  normalizeOutlineContentModes,
  renumberOutlineItemsWithIdMap,
} from '../outlineTree';
import { areWordControlOptionsEqual, formatWordCountDraft, getEstimatedPages, normalizeWordControlDraft, parseWordCountDraft } from '../outlineWordControl';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import OutlineSelectionDialog from '../components/OutlineSelectionDialog';
import { useOutlineSorting } from '../hooks/useOutlineSorting';
import { useOutlineTreeEditor } from '../hooks/useOutlineTreeEditor';
import { useOutlineKnowledgePicker } from '../hooks/useOutlineKnowledgePicker';
import { buildKnowledgePickerViewModel } from '../knowledgePickerModel';
import { outlineExpansionModeLabels } from '../outlineModeLabels';
import OutlineGenerationDialog from '../components/OutlineGenerationDialog';

interface OutlineEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  projectOverview: string;
  outlineMode: OutlineMode;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentTaskStatus?: BackgroundTaskState['status'];
  aiAdjustmentRunning?: boolean;
  onOutlineConfigChange: (config: { referenceKnowledgeDocumentIds: string[]; outlineMode: OutlineMode; outlineExpansionMode: OutlineExpansionMode; wordControlOptions: OutlineWordControlOptions }) => Promise<void>;
  onOutlineSaved: (request: SaveOutlineRequest) => Promise<void>;
  onOutlineSelectionSaved: (request: SaveOutlineSelectionRequest) => Promise<void>;
  onOpenBidTemplate?: () => Promise<void>;
  bidTemplateExists?: boolean;
  onSortGuardChange?: (guard: OutlineSortGuard | null) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

const contentModeOptions = Object.keys(OUTLINE_CONTENT_MODE_LABELS) as OutlineContentMode[];











function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}














function OutlineEditPage({
  workflowKind,
  projectOverview,
  outlineMode,
  outlineExpansionMode,
  outlineWordControlOptions,
  outlineWordControlSnapshot,
  referenceKnowledgeDocumentIds,
  outlineData,
  task,
  contentTaskStatus,
  aiAdjustmentRunning = false,
  onOutlineConfigChange,
  onOutlineSaved,
  onOutlineSelectionSaved,
  onOpenBidTemplate,
  bidTemplateExists = false,
  onSortGuardChange,
}: OutlineEditPageProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftOutlineMode, setDraftOutlineMode] = useState<OutlineMode>(outlineMode === 'standalone-technical' ? 'standalone-technical' : 'response-file');
  const [draftOutlineExpansionMode, setDraftOutlineExpansionMode] = useState<OutlineExpansionMode>(outlineExpansionMode);
  const [draftMinimumWords, setDraftMinimumWords] = useState(formatWordCountDraft(outlineWordControlOptions.minimumWords));
  const [draftMaximumWords, setDraftMaximumWords] = useState(formatWordCountDraft(outlineWordControlOptions.maximumWords));
  const [draftSectionWords, setDraftSectionWords] = useState(formatWordCountDraft(outlineWordControlOptions.sectionWords));
  const [draftStrictSectionWords, setDraftStrictSectionWords] = useState(outlineWordControlOptions.strictSectionWords);
  const [savingOutlineConfig, setSavingOutlineConfig] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [selectionDialogOpen, setSelectionDialogOpen] = useState(false);
  const [savingOutlineSelection, setSavingOutlineSelection] = useState(false);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const shownTaskErrorIdRef = useRef<string | null>(null);
  const { showToast } = useToast();
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const outlineSelection = task?.stats?.outline_selection;
  const hasOutlineSelection = Boolean(outlineSelection?.items?.length);
  const awaitingOutlineSelection = Boolean(taskRunning && hasOutlineSelection && !outlineSelection?.confirmed);
  const generating = startingOutline || taskRunning;
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const knowledgePickingDisabled = generating;
  const contentMutationLocked = contentTaskStatus === 'running' || contentTaskStatus === 'pausing' || contentTaskStatus === 'paused';

  const {
    draftKnowledgeDocumentIds,
    knowledgeSearch,
    setKnowledgeSearch,
    expandedKnowledgeFolderIds,
    knowledgeIndex,
    loadingKnowledge,
    loadKnowledgeIndex,
    resetDraft: resetKnowledgeDraft,
    toggleDraftKnowledgeDocument,
    toggleKnowledgeFolder,
    selectFolderDocuments,
    clearFolderDocuments,
    removeDraftKnowledgeDocument,
    clearDraftKnowledgeDocuments,
  } = useOutlineKnowledgePicker({
    referenceKnowledgeDocumentIds,
    disabled: generating,
  });

  const knowledgePickerViewModel = buildKnowledgePickerViewModel(knowledgeIndex, knowledgeSearch, draftKnowledgeDocumentIds);

  const getMutationLockMessage = () => {
    if (generating) return '目录生成任务正在运行，当前目录暂不可编辑';
    if (contentMutationLocked) return '正文生成任务正在运行或暂停中，请结束后再调整目录';
    return '';
  };

  const {
    sorting,
    draftOutlineData,
    sortDirty,
    savingSort,
    draggingItemId,
    dropTarget,
    activeOutlineData,
    startSorting,
    discardSorting,
    saveSorting,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  } = useOutlineSorting({
    outlineData,
    onOutlineSaved,
    onSortGuardChange,
    getMutationLockMessage,
    onStartSorting: () => setEditingItemId(null),
    onRemapExpandedIds: (idMap) => setExpandedItems((prev) => new Set([...prev].map((id) => idMap[id] || id))),
    onRemapSelectedId: (idMap) => setSelectedItemId((prev) => (prev ? idMap[prev] || prev : prev)),
  });

  const selectedItem = activeOutlineData && selectedItemId ? findOutlineItem(activeOutlineData.outline, selectedItemId) : null;
  const outlineMutationLocked = generating || contentMutationLocked || savingSort || aiAdjustmentRunning;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = awaitingOutlineSelection
    ? '待确认'
    : generating
      ? '运行中'
    : taskFailed
      ? '失败'
      : outlineData
        ? '已完成'
        : hasOutlineSelection
          ? outlineSelection?.confirmed ? '已确认' : '待确认'
          : '未开始';
  const aiStatusTitle = awaitingOutlineSelection ? '等待确认一级目录' : generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';
  const parsedDraftMinimumWords = parseWordCountDraft(draftMinimumWords) ?? 0;
  const parsedDraftMaximumWords = parseWordCountDraft(draftMaximumWords) ?? 0;
  const parsedDraftSectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
  const estimatedPages = getEstimatedPages(parsedDraftMinimumWords, parsedDraftMaximumWords);
  const normalizedDraftOptions: OutlineWordControlOptions = {
    minimumWords: parsedDraftMinimumWords,
    maximumWords: parsedDraftMaximumWords,
    sectionWords: parsedDraftSectionWords,
    strictSectionWords: parsedDraftSectionWords > 0 && draftStrictSectionWords,
  };
  const wordControlRequiresRegeneration = Boolean(outlineData && !areWordControlOptionsEqual(normalizedDraftOptions, outlineWordControlSnapshot));
  const outlineModeRequiresRegeneration = Boolean(outlineData && !isExpansionWorkflow && draftOutlineMode !== outlineMode);

  const initializeWordControlDraft = () => {
    setDraftMinimumWords(formatWordCountDraft(outlineWordControlOptions.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(outlineWordControlOptions.maximumWords));
    setDraftSectionWords(formatWordCountDraft(outlineWordControlOptions.sectionWords));
    setDraftStrictSectionWords(outlineWordControlOptions.strictSectionWords);
  };

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (cancelled) return;
      if (cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeOutlineData?.outline?.length) {
      const validIds = collectOutlineIds(activeOutlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size || sorting ? next : collectRootIds(activeOutlineData.outline);
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : activeOutlineData.outline[0]?.id || null));
      return;
    }

    setExpandedItems(new Set());
    setSelectedItemId(null);
  }, [activeOutlineData]);

  useEffect(() => {
    if (task?.status) {
      setStartingOutline(false);
      if (task.status !== 'running') {
        setLocalStartAt(null);
      }
    }
  }, [task?.status]);

  useEffect(() => {
    if (task?.status !== 'error' || !task.task_id || shownTaskErrorIdRef.current === task.task_id) return;
    shownTaskErrorIdRef.current = task.task_id;
    showToast(task.error || '目录生成失败，请调整设置后重新生成目录', 'error');
  }, [showToast, task?.error, task?.status, task?.task_id]);

  useEffect(() => {
    if (!awaitingOutlineSelection) {
      setSelectionDialogOpen(false);
      return;
    }
    setSelectionDialogOpen(true);
  }, [awaitingOutlineSelection, task?.task_id]);

  useEffect(() => {
    if (!generating) {
      return;
    }

    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  useEffect(() => {
    if (!generationDialogOpen) {
      return;
    }

    setDraftOutlineMode(outlineMode === 'standalone-technical' ? 'standalone-technical' : 'response-file');
    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    resetKnowledgeDraft();
    initializeWordControlDraft();
    void loadKnowledgeIndex();
  }, [generationDialogOpen, isExpansionWorkflow, outlineMode, outlineExpansionMode, outlineWordControlOptions, referenceKnowledgeDocumentIds]);


  const openGenerationDialog = () => {
    if (sorting) {
      showToast('请先保存当前目录排序', 'info');
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }
    if (!projectOverview) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    setDraftOutlineMode(outlineMode === 'standalone-technical' ? 'standalone-technical' : 'response-file');
    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    resetKnowledgeDraft();
    initializeWordControlDraft();
    setGenerationDialogOpen(true);
  };

  const getNormalizedWordControlOptions = () => normalizeWordControlDraft({
    minimumWords: draftMinimumWords,
    maximumWords: draftMaximumWords,
    sectionWords: draftSectionWords,
    strictSectionWords: draftStrictSectionWords,
  });

  const applyNormalizedWordControlDraft = (options: OutlineWordControlOptions) => {
    setDraftMinimumWords(formatWordCountDraft(options.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(options.maximumWords));
    setDraftSectionWords(formatWordCountDraft(options.sectionWords));
    setDraftStrictSectionWords(options.strictSectionWords);
  };

  const saveOutlineConfig = async () => {
    if (outlineModeRequiresRegeneration) {
      showToast('技术文件结构已改变，请点击“重新生成目录”使新结构生效', 'info');
      return;
    }
    try {
      const wordControlOptions = getNormalizedWordControlOptions();
      setSavingOutlineConfig(true);
      await onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineMode: isExpansionWorkflow ? 'aligned' : draftOutlineMode,
        outlineExpansionMode: isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement',
        wordControlOptions,
      });
      applyNormalizedWordControlDraft(wordControlOptions);
      setGenerationDialogOpen(false);
      showToast('目录生成配置已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录配置失败', 'error');
    } finally {
      setSavingOutlineConfig(false);
    }
  };

  const generateOutline = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }
    if (!projectOverview) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    try {
      const wordControlOptions = getNormalizedWordControlOptions();
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      const nextOutlineMode: OutlineMode = isExpansionWorkflow ? 'aligned' : draftOutlineMode;
      const nextOutlineExpansionMode = isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement';
      await onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineMode: nextOutlineMode,
        outlineExpansionMode: nextOutlineExpansionMode,
        wordControlOptions,
      });
      setGenerationDialogOpen(false);
      await window.yibiao?.tasks.startOutlineGeneration({
        reference_knowledge_document_ids: draftKnowledgeDocumentIds,
        outline_mode: nextOutlineMode,
        outline_expansion_mode: nextOutlineExpansionMode,
        word_control_options: wordControlOptions,
      });
      trackConfigUsage({
        outline_mode: isExpansionWorkflow ? nextOutlineExpansionMode : nextOutlineMode,
        word_control_enabled: wordControlOptions.minimumWords > 0 || wordControlOptions.maximumWords > 0 || wordControlOptions.sectionWords > 0,
        minimum_words: wordControlOptions.minimumWords,
        maximum_words: wordControlOptions.maximumWords,
        section_words: wordControlOptions.sectionWords,
        strict_section_words: wordControlOptions.strictSectionWords,
      });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const confirmOutlineSelection = async (items: OutlineSelectionItem[], selectedIds: string[]) => {
    if (!task?.task_id) return;
    try {
      setSavingOutlineSelection(true);
      await onOutlineSelectionSaved({ taskId: task.task_id, items, selectedIds });
      setSelectionDialogOpen(false);
      showToast(`已确认 ${selectedIds.length} 个一级目录`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存一级目录选择失败', 'error');
    } finally {
      setSavingOutlineSelection(false);
    }
  };

  // 用户修改一级目录选择时停止当前弹窗的自动确认计时。
  const suppressOutlineSelectionAutoConfirmation = () => {
    if (!task?.task_id) return;
    void window.yibiao.tasks.suppressOutlineSelectionAutoConfirmation({ taskId: task.task_id }).catch(() => undefined);
  };








  const saveOutlineChange = async (outline: OutlineItem[], reason: SaveOutlineRequest['reason'], affectedNodeIds: string[] = []) => {
    if (!outlineData) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    const normalizedOutline = normalizeOutlineContentModes(outline);
    assertLeafContentModes(normalizedOutline);
    const renumbered = renumberOutlineItemsWithIdMap(normalizedOutline);
    await onOutlineSaved({
      outlineData: { ...outlineData, outline: renumbered.outline },
      reason,
      idMap: renumbered.idMap,
      affectedNodeIds,
    });
  };

  const {
    editingItemId,
    editTitle,
    editDescription,
    editContentMode,
    editContentModeNote,
    setEditingItemId,
    setEditTitle,
    setEditDescription,
    setEditContentMode,
    setEditContentModeNote,
    startEditing,
    saveEditing,
    addRootItem,
    addChildItem,
    removeItem,
  } = useOutlineTreeEditor({
    outlineData,
    sorting,
    outlineMutationLocked,
    setExpandedItems,
    setSelectedItemId,
    saveOutlineChange,
  });






  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const expandAllItems = () => {
    if (activeOutlineData?.outline?.length) {
      setExpandedItems(collectOutlineIds(activeOutlineData.outline));
    }
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };











  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const isExpanded = expandedItems.has(item.id);
    const isActive = selectedItemId === item.id;
    const isDragging = draggingItemId === item.id;
    const isDropTarget = dropTarget?.itemId === item.id;
    const dropClass = isDropTarget
      ? dropTarget.valid
        ? ` is-drop-${dropTarget.position}`
        : ' is-drop-invalid'
      : '';

    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div
          className={`outline-tree-item${isActive ? ' is-active' : ''}${sorting ? ' is-sorting' : ''}${isDragging ? ' is-dragging' : ''}${dropClass}`}
          draggable={sorting}
          onDragStart={(event) => handleDragStart(event, item)}
          onDragOver={(event) => handleDragOver(event, item)}
          onDrop={(event) => handleDrop(event, item)}
          onDragEnd={handleDragEnd}
        >
          {sorting && <span className="outline-tree-drag-handle" aria-hidden="true">⋮⋮</span>}
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(item.id)}
            disabled={!hasChildren}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${item.title}` : `${item.title} 无子目录`}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="outline-tree-content"
            onClick={() => setSelectedItemId(item.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(item.id)}
          >
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
            {!hasChildren && item.content_mode && (
              <span className={`outline-content-mode-badge is-${item.content_mode}`}>{OUTLINE_CONTENT_MODE_LABELS[item.content_mode]}</span>
            )}
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>目录生成</strong>
          <p>{isExpansionWorkflow ? `当前原方案目录使用方式：${outlineExpansionModeLabels[outlineExpansionMode]}；参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。` : `${outlineMode === 'standalone-technical' ? '技术评分大项直接作为一级目录' : '一级目录依据完整响应文件要求生成'}；参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。`}</p>
        </div>
        <div className="outline-command-actions">
          {awaitingOutlineSelection && (
            <button type="button" className="secondary-action" onClick={() => setSelectionDialogOpen(true)}>
              确认一级目录
            </button>
          )}
          {bidTemplateExists && (
            <button type="button" className="secondary-action" onClick={() => void onOpenBidTemplate?.()}>
              打开投标模版
            </button>
          )}
          <button
            type="button"
            className="outline-config-action"
            onClick={openGenerationDialog}
            disabled={generating || sorting || contentMutationLocked || !projectOverview}
            aria-label="打开目录生成配置"
            title="目录生成配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={openGenerationDialog} disabled={generating || sorting || contentMutationLocked || !projectOverview}>
            {generating ? 'AI 正在生成目录' : outlineData ? '重新生成目录' : '生成目录'}
          </button>
        </div>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{statusText}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={progress} label={`目录生成进度 ${progress}%`} />
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {taskFailed && <small>{task?.error || latestLog || '目录生成失败'}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div>
              <strong>目录结构</strong>
              <span>{activeOutlineData?.outline?.length || 0} 个一级目录{sorting ? ' · 排序中' : ''}</span>
            </div>
            <div className="outline-tree-tools">
              {sorting ? (
                <>
                  <button type="button" className="outline-save-sort-action" onClick={() => { void saveSorting().catch((error) => showToast(error instanceof Error ? error.message : '保存排序失败', 'error')); }} disabled={savingSort}>
                    {savingSort ? '正在保存...' : '保存排序'}
                  </button>
                  <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                  <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              ) : (
                <>
                {outlineData && (
                <button type="button" className="outline-add-root-action" onClick={() => { void addRootItem(); }} disabled={outlineMutationLocked}>
                  添加一级目录
                </button>
                )}
                {outlineData && (
                  <button type="button" onClick={startSorting} disabled={outlineMutationLocked || !outlineData?.outline?.length}>目录排序</button>
                )}
                <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              )}
            </div>
          </div>
          {activeOutlineData?.outline?.length ? (
            <div className={`outline-tree-list${sorting ? ' is-sorting' : ''}`}>
              {activeOutlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>{awaitingOutlineSelection ? '一级目录已生成' : '尚未生成目录'}</strong>
              <p>{awaitingOutlineSelection
                ? '请查看并确认需要继续使用的一级目录。'
                : taskFailed ? '上次目录生成未完成，请重新生成目录。' : '先完成招标文件解析，再生成技术方案目录。'}</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {(generating || contentMutationLocked || sorting) && (
                <div className="outline-detail-lock">
                  {sorting
                    ? '目录排序中，当前目录暂不可编辑。'
                    : contentMutationLocked
                      ? '正文生成任务正在运行或暂停中，当前目录暂不可编辑。'
                      : '目录生成任务正在运行，当前目录暂不可编辑，避免覆盖后台生成结果。'}
                </div>
              )}
              {editingItemId === selectedItem.id ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <label>
                    <span>描述</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  {!selectedItem.children?.length && (
                    <label>
                      <span>内容处理模式</span>
                      <select value={editContentMode} onChange={(event) => setEditContentMode(event.target.value as OutlineContentMode)} disabled={outlineMutationLocked || sorting}>
                        {contentModeOptions.map((mode) => <option value={mode} key={mode}>{OUTLINE_CONTENT_MODE_LABELS[mode]}</option>)}
                      </select>
                    </label>
                  )}
                  {!selectedItem.children?.length && editContentMode === 'other' && (
                    <label>
                      <span>其他模式说明</span>
                      <textarea value={editContentModeNote} onChange={(event) => setEditContentModeNote(event.target.value)} disabled={outlineMutationLocked || sorting} />
                    </label>
                  )}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={outlineMutationLocked || sorting}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {!selectedItem.children?.length && selectedItem.content_mode && (
                    <span className={`outline-content-mode-badge is-${selectedItem.content_mode}`}>{OUTLINE_CONTENT_MODE_LABELS[selectedItem.content_mode]}</span>
                  )}
                  {!selectedItem.children?.length && selectedItem.content_mode === 'other' && selectedItem.content_mode_note && (
                    <small>{selectedItem.content_mode_note}</small>
                  )}
                  {selectedItem.source_requirement_title && (
                    <small>{isExpansionWorkflow && outlineExpansionMode === 'original-only' ? '来源原方案目录' : '来源响应文件目录'}：{selectedItem.source_requirement_title}</small>
                  )}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={outlineMutationLocked || sorting}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => { void addChildItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => { void removeItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和描述。</p>
            </div>
          )}
        </aside>
      </section>

      {outlineSelection && (
        <OutlineSelectionDialog
          open={selectionDialogOpen}
          selection={outlineSelection}
          saving={savingOutlineSelection}
          onDismiss={() => setSelectionDialogOpen(false)}
          onInteraction={suppressOutlineSelectionAutoConfirmation}
          onConfirm={(items, selectedIds) => { void confirmOutlineSelection(items, selectedIds); }}
        />
      )}

      <OutlineGenerationDialog
        open={generationDialogOpen}
        onOpenChange={setGenerationDialogOpen}
        isExpansionWorkflow={isExpansionWorkflow}
        hasOutlineData={Boolean(outlineData)}
        draftOutlineMode={draftOutlineMode}
        setDraftOutlineMode={setDraftOutlineMode}
        draftOutlineExpansionMode={draftOutlineExpansionMode}
        setDraftOutlineExpansionMode={setDraftOutlineExpansionMode}
        draftMinimumWords={draftMinimumWords}
        setDraftMinimumWords={setDraftMinimumWords}
        draftMaximumWords={draftMaximumWords}
        setDraftMaximumWords={setDraftMaximumWords}
        draftSectionWords={draftSectionWords}
        setDraftSectionWords={setDraftSectionWords}
        draftStrictSectionWords={draftStrictSectionWords}
        setDraftStrictSectionWords={setDraftStrictSectionWords}
        parsedDraftSectionWords={parsedDraftSectionWords}
        estimatedPages={estimatedPages}
        wordControlRequiresRegeneration={wordControlRequiresRegeneration}
        outlineModeRequiresRegeneration={outlineModeRequiresRegeneration}
        outlineWordControlSnapshot={outlineWordControlSnapshot}
        savingOutlineConfig={savingOutlineConfig}
        generating={generating}
        contentMutationLocked={contentMutationLocked}
        projectOverview={projectOverview}
        saveOutlineConfig={saveOutlineConfig}
        generateOutline={generateOutline}
        knowledgePicker={{
          loadingKnowledge,
          viewModel: knowledgePickerViewModel,
          knowledgeSearch,
          setKnowledgeSearch,
          knowledgePickingDisabled,
          expandedKnowledgeFolderIds,
          draftKnowledgeDocumentIds,
          toggleKnowledgeFolder,
          toggleDraftKnowledgeDocument,
          selectFolderDocuments,
          clearFolderDocuments,
          removeDraftKnowledgeDocument,
          clearDraftKnowledgeDocuments,
        }}
      />
    </div>
  );
}

export default OutlineEditPage;
