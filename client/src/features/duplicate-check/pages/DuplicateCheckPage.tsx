import { useEffect, useMemo, useRef, useState } from 'react';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, FloatingToolbar, isLibreOfficeRequiredMessage, ProgressBar, ToolbarArrowLeftIcon, ToolbarArrowRightIcon, ToolbarDocumentIcon, UploadBoard, UploadEmpty, UploadFilePill, UploadRow, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import { hasExportableDuplicateResults } from '../exportState';
import type { DuplicateAnalysisStatus, DuplicateAnalysisTabId, DuplicateCheckStep, DuplicateCheckTaskState, DuplicateCheckWorkspaceState, DuplicateContentAnalysisState, DuplicateImageAnalysisState, DuplicateMetadataAnalysisState, DuplicateOutlineAnalysisState, LocalFileSelection } from '../../../shared/types';
import {
  analysisTabs,
  formatFileSize,
  createDuplicateCheckSignature,
} from '../model';
import {
  FilePill,
  DuplicateAnalysisPane,
} from '../components/duplicatePanes';


const guideItems = [
  '同设备、同用户、同一个 WPS 账号、时间相近等问题，一秒锁定。',
  '可选上传招标文件，多份投标文件都引用了招标文件中的内容，不算重复。',
  '图片基于哈希校验，只能识别同一张图片，截图、压缩等相似图片筛不出来。',
];

const dimensions = [
  { title: '元数据', text: '检查设备、账号、编辑时间、作者等隐藏信息。' },
  { title: '目录', text: '比对章节结构和标题顺序，识别模板化复制。' },
  { title: '正文', text: '筛查段落、表格和关键描述的重复内容。' },
  { title: '图片', text: '对原图做哈希校验，定位完全一致的图片。' },
];

const defaultAnalysisTab: DuplicateAnalysisTabId = 'metadata';
const steps: DuplicateCheckStep[] = ['upload', 'analysis'];
const stepLabels: Record<DuplicateCheckStep, string> = {
  upload: '选择标书',
  analysis: '查重结果',
};

function DuplicateCheckPage() {
  const [tenderFile, setTenderFile] = useState<LocalFileSelection | null>(null);
  const [tenderFiles, setTenderFiles] = useState<LocalFileSelection[]>([]);
  const [activeTenderFileId, setActiveTenderFileId] = useState('');
  const [bidFiles, setBidFiles] = useState<LocalFileSelection[]>([]);
  const [step, setStep] = useState<DuplicateCheckStep>('upload');
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<DuplicateAnalysisTabId>(defaultAnalysisTab);
  const [metadataAnalysis, setMetadataAnalysis] = useState<DuplicateMetadataAnalysisState | undefined>();
  const [outlineAnalysis, setOutlineAnalysis] = useState<DuplicateOutlineAnalysisState | undefined>();
  const [contentAnalysis, setContentAnalysis] = useState<DuplicateContentAnalysisState | undefined>();
  const [imageAnalysis, setImageAnalysis] = useState<DuplicateImageAnalysisState | undefined>();
  const [analysisTask, setAnalysisTask] = useState<DuplicateCheckTaskState | undefined>();
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [busy, setBusy] = useState<'tender' | 'bid' | null>(null);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportedExcelPath, setExportedExcelPath] = useState('');
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const startedMetadataSignatureRef = useRef<string | null>(null);
  const currentAnalysisSignatureRef = useRef('');
  const hydratedRef = useRef(false);
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  function applyDuplicateCheckState(state: DuplicateCheckWorkspaceState) {
    const nextTenderFiles = Array.isArray(state.tenderFiles) ? state.tenderFiles : state.tenderFile ? [state.tenderFile] : [];
    setTenderFile(state.tenderFile || nextTenderFiles[0] || null);
    setTenderFiles(nextTenderFiles);
    setActiveTenderFileId((current) => (nextTenderFiles.some((file) => file.id === current) ? current : nextTenderFiles[0]?.id || ''));
    setBidFiles(Array.isArray(state.bidFiles) ? state.bidFiles : []);
    setStep(state.step === 'analysis' ? 'analysis' : 'upload');
    setActiveAnalysisTab(analysisTabs.some((item) => item.id === state.activeAnalysisTab) ? state.activeAnalysisTab as DuplicateAnalysisTabId : defaultAnalysisTab);
    setMetadataAnalysis(state.metadataAnalysis);
    setOutlineAnalysis(state.outlineAnalysis);
    setContentAnalysis(state.contentAnalysis);
    setImageAnalysis(state.imageAnalysis);
    setAnalysisTask(state.analysisTask);
  }

  const totalSize = useMemo(() => bidFiles.reduce((sum, file) => sum + file.size, tenderFiles.reduce((tenderSum, file) => tenderSum + file.size, 0)), [bidFiles, tenderFiles]);
  const isAnalysisRunning = startingAnalysis
    || analysisTask?.status === 'running'
    || metadataAnalysis?.status === 'running'
    || outlineAnalysis?.status === 'running'
    || contentAnalysis?.status === 'running'
    || imageAnalysis?.status === 'running';
  const canGoNext = bidFiles.length > 0;
  const activeIndex = steps.indexOf(step);
  const isNextDisabled = activeIndex >= steps.length - 1 || !canGoNext;
  const nextTooltip = activeIndex >= steps.length - 1
    ? '当前已经是最后一步'
    : canGoNext
      ? `进入${stepLabels[steps[activeIndex + 1]]}`
      : '请先上传至少一份投标文件';

  useEffect(() => {
    if (!analyticsReady) return;

    trackPageView(step === 'analysis'
      ? `duplicate-check/analysis/${activeAnalysisTab}`
      : 'duplicate-check/upload');
  }, [activeAnalysisTab, analyticsReady, step]);

  useEffect(() => {
    let canceled = false;

    void window.yibiao?.duplicateCheck.loadState()
      .then((state) => {
        if (canceled || !state) return;
        applyDuplicateCheckState(state);
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '读取标书查重缓存失败', 'error');
      })
      .finally(() => {
        if (!canceled) {
          hydratedRef.current = true;
          setAnalyticsReady(true);
        }
      });

    return () => {
      canceled = true;
    };
  }, [showToast]);

  useEffect(() => {
    if (!hydratedRef.current) return;

    void window.yibiao?.duplicateCheck.saveUiState({ step, activeAnalysisTab })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '保存标书查重页面状态失败', 'error');
      });
  }, [activeAnalysisTab, showToast, step]);

  useEffect(() => {
    const unsubscribe = window.yibiao?.tasks?.onTaskEvent<unknown, unknown, DuplicateCheckWorkspaceState>((event) => {
      const state = event?.duplicateCheck;
      const patch = event?.duplicateCheckPatch;
      if (!state && !patch) return;
      const eventSignature = state?.metadataAnalysis?.signature
        || state?.outlineAnalysis?.signature
        || state?.contentAnalysis?.signature
        || state?.imageAnalysis?.signature
        || patch?.metadataAnalysis?.signature
        || patch?.outlineAnalysis?.signature
        || patch?.contentAnalysis?.signature
        || patch?.imageAnalysis?.signature;
      if (eventSignature && eventSignature !== currentAnalysisSignatureRef.current) return;
      setStartingAnalysis(false);
      const metadata = state?.metadataAnalysis || patch?.metadataAnalysis;
      metadata?.contentFiles?.forEach((file) => {
        const noticeId = `content:${file.file_id}`;
        if (file.status === 'error'
          && isLibreOfficeRequiredMessage(file.error)
          && !documentParseNoticeIdsRef.current.has(noticeId)) {
          documentParseNoticeIdsRef.current.add(noticeId);
          showDocumentParseNotice(file.error);
        }
      });
      if (state) applyDuplicateCheckState(state);
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'metadataAnalysis')) {
        setMetadataAnalysis((prev) => patch.metadataAnalysis === undefined
          ? undefined
          : { ...(prev || ({} as DuplicateMetadataAnalysisState)), ...patch.metadataAnalysis } as DuplicateMetadataAnalysisState);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'outlineAnalysis')) {
        setOutlineAnalysis((prev) => patch.outlineAnalysis === undefined
          ? undefined
          : { ...(prev || ({} as DuplicateOutlineAnalysisState)), ...patch.outlineAnalysis } as DuplicateOutlineAnalysisState);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'contentAnalysis')) {
        setContentAnalysis((prev) => patch.contentAnalysis === undefined
          ? undefined
          : { ...(prev || ({} as DuplicateContentAnalysisState)), ...patch.contentAnalysis } as DuplicateContentAnalysisState);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'imageAnalysis')) {
        setImageAnalysis((prev) => patch.imageAnalysis === undefined
          ? undefined
          : { ...(prev || ({} as DuplicateImageAnalysisState)), ...patch.imageAnalysis } as DuplicateImageAnalysisState);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'analysisTask')) setAnalysisTask(patch.analysisTask);
    });
    window.yibiao?.tasks?.getActiveTasks().catch((error) => {
      console.warn('获取标书查重后台任务状态失败', error);
    });
    return () => unsubscribe?.();
  }, []);

  const currentAnalysisSignature = useMemo(() => {
    const files: LocalFileSelection[] = [...tenderFiles, ...bidFiles];
    return createDuplicateCheckSignature(files);
  }, [bidFiles, tenderFiles]);
  const hasExportableCurrentResult = hasExportableDuplicateResults({
    metadataAnalysis,
    outlineAnalysis,
    contentAnalysis,
    imageAnalysis,
    signature: currentAnalysisSignature,
  });

  useEffect(() => {
    currentAnalysisSignatureRef.current = currentAnalysisSignature;
  }, [currentAnalysisSignature]);

  const startDuplicateAnalysis = (force = false) => {
    if (!bidFiles.length) {
      showToast('请先上传至少一份投标文件', 'info');
      return;
    }
    if (force) {
      startedMetadataSignatureRef.current = null;
    }
    startedMetadataSignatureRef.current = currentAnalysisSignature;
    setStartingAnalysis(true);
    void window.yibiao?.tasks?.startDuplicateAnalysis({ tenderFile: tenderFiles[0] || null, tenderFiles, bidFiles, force })
      .then(() => {
        showToast(force ? '标书查重重新分析任务已在后台启动' : '标书查重分析任务已在后台启动', 'success');
      })
      .catch((error) => {
        startedMetadataSignatureRef.current = null;
        setStartingAnalysis(false);
        const message = error instanceof Error ? error.message : '启动元数据分析失败';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'error');
      });
  };

  useEffect(() => {
    if (step !== 'analysis' || !bidFiles.length) return;
    if (metadataAnalysis?.status === 'success'
      && metadataAnalysis.signature
      && outlineAnalysis?.status === 'success'
      && contentAnalysis?.status === 'success'
      && imageAnalysis?.status === 'success') return;
    if (startedMetadataSignatureRef.current === currentAnalysisSignature) return;
    startDuplicateAnalysis(false);
  }, [bidFiles, contentAnalysis?.status, currentAnalysisSignature, imageAnalysis?.status, metadataAnalysis?.signature, metadataAnalysis?.status, outlineAnalysis?.status, showToast, step, tenderFiles]);

  const selectFiles = async (multiple: boolean, filePaths?: string[]) => {
    const selector = window.yibiao?.file?.selectDuplicateCheckFiles;
    if (typeof selector !== 'function') {
      throw new Error('文件选择接口尚未加载，请重启应用后重试');
    }
    return selector({ multiple, filePaths });
  };

  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  const persistSelectedFiles = async (nextTenderFiles: LocalFileSelection[], nextBidFiles: LocalFileSelection[], nextStep: DuplicateCheckStep = step) => {
    const saver = window.yibiao?.duplicateCheck?.saveFiles;
    if (typeof saver !== 'function') {
      throw new Error('标书查重缓存接口尚未加载，请重启应用后重试');
    }
    await saver({ tenderFile: nextTenderFiles[0] || null, tenderFiles: nextTenderFiles, bidFiles: nextBidFiles, step: nextStep, activeAnalysisTab });
    const state = await window.yibiao.duplicateCheck.loadState();
    applyDuplicateCheckState(state);
    setStartingAnalysis(false);
    startedMetadataSignatureRef.current = null;
    return state;
  };

  const uploadTenderFile = async (filePaths?: string[]) => {
    if (isAnalysisRunning) {
      showToast('标书查重分析正在运行，请完成后再调整文件', 'info');
      return;
    }
    try {
      setBusy('tender');
      const result = await selectFiles(true, filePaths);
      if (!result?.success || !result.files?.length) {
        const message = result?.message || '未选择招标文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }
      const exists = new Set(tenderFiles.map((file) => file.file_path));
      const nextFiles = result.files.filter((file) => !exists.has(file.file_path));
      if (nextFiles.length < result.files.length) {
        showToast('已跳过重复选择的招标文件', 'info');
      }
      if (nextFiles.length > 0) {
        await persistSelectedFiles([...tenderFiles, ...nextFiles], bidFiles);
        showToast(`已加入 ${nextFiles.length} 份招标文件，暂不执行解析`, 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择招标文件失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const uploadBidFiles = async (filePaths?: string[]) => {
    if (isAnalysisRunning) {
      showToast('标书查重分析正在运行，请完成后再调整文件', 'info');
      return;
    }
    try {
      setBusy('bid');
      const result = await selectFiles(true, filePaths);
      if (!result?.success || !result.files?.length) {
        const message = result?.message || '未选择投标文件';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, message === '已取消选择' ? 'info' : 'error');
        return;
      }

      const exists = new Set(bidFiles.map((file) => file.file_path));
      const nextFiles = result.files.filter((file) => !exists.has(file.file_path));
      if (nextFiles.length < result.files.length) {
        showToast('已跳过重复选择的投标文件', 'info');
      }
      if (nextFiles.length > 0) {
        await persistSelectedFiles(tenderFiles, [...bidFiles, ...nextFiles]);
        showToast('投标文件已加入，暂不执行解析', 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择投标文件失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  async function exportDuplicateResultsExcel() {
    if (!window.yibiao?.duplicateCheck?.exportExcel) {
      showToast('标书查重结果导出接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    setExportingExcel(true);
    try {
      const result = await window.yibiao.duplicateCheck.exportExcel({ signature: currentAnalysisSignature });
      if (result.canceled) return;
      if (!result.success || !result.path) {
        showToast(result.message || '标书查重结果导出失败', 'error');
        return;
      }
      setExportedExcelPath(result.path);
      showToast(result.message || '标书查重结果已导出', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '标书查重结果导出失败', 'error');
    } finally {
      setExportingExcel(false);
    }
  }

  async function openExportedExcelFile() {
    if (!exportedExcelPath) return;
    try {
      await window.yibiao.export.openFile(exportedExcelPath);
      setExportedExcelPath('');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 Excel 文件失败', 'error');
    }
  }

  const resetFiles = () => {
    if (isAnalysisRunning) {
      showToast('标书查重分析正在运行，请完成后再重置文件', 'info');
      return;
    }
    void window.yibiao?.duplicateCheck.clear()
      .then(() => {
        applyDuplicateCheckState({
          tenderFile: null,
          tenderFiles: [],
          bidFiles: [],
          step: 'upload',
          activeAnalysisTab: defaultAnalysisTab,
        });
        setStartingAnalysis(false);
        startedMetadataSignatureRef.current = null;
        showToast('已重置上传列表', 'success');
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : '清空标书查重缓存失败', 'error');
      });
  };

  const switchStep = (nextStep: DuplicateCheckStep) => {
    setStep(nextStep);
  };

  const goToOffset = (offset: number) => {
    const nextStep = steps[activeIndex + offset];
    if (!nextStep) return;
    switchStep(nextStep);
  };

  const toolbarGroups: FloatingToolbarGroup[] = [
    ...(step === 'analysis' ? [{
      id: 'duplicate-check-export',
      actions: [{
        id: 'export-excel',
        label: exportingExcel ? '导出中...' : '导出 Excel',
        icon: <ToolbarDocumentIcon />,
        variant: 'success' as const,
        disabled: isAnalysisRunning || exportingExcel || !hasExportableCurrentResult,
        tooltip: isAnalysisRunning
          ? '请等待当前查重任务结束后再导出'
          : !hasExportableCurrentResult
            ? '没有当前文件集合对应的可导出结果'
            : '导出当前元数据、目录、正文和图片查重结果',
        onClick: () => { void exportDuplicateResultsExcel(); },
      }],
    }] : []),
    {
      id: 'duplicate-check-reset',
      actions: [
        {
          id: 'reset',
          label: '重置',
          variant: 'danger',
          disabled: isAnalysisRunning,
          tooltip: '清空当前标书查重流程',
          onClick: resetFiles,
        },
        {
          id: 'home',
          label: '首页',
          variant: step === 'upload' ? 'primary' : 'secondary',
          tooltip: '回到选择标书',
          onClick: () => switchStep('upload'),
        },
      ],
    },
    {
      id: 'duplicate-check-navigation',
      actions: [
        {
          id: 'previous-step',
          label: '上一步',
          icon: <ToolbarArrowLeftIcon />,
          disabled: activeIndex <= 0,
          tooltip: activeIndex <= 0 ? '当前已经是第一步' : `返回${stepLabels[steps[activeIndex - 1]]}`,
          onClick: () => goToOffset(-1),
        },
        {
          id: 'next-step',
          label: '下一步',
          icon: <ToolbarArrowRightIcon />,
          variant: 'primary',
          disabled: isNextDisabled,
          tooltip: nextTooltip,
          onClick: () => goToOffset(1),
        },
      ],
    },
  ];

  return (
    <div className="duplicate-check-page">
      {step === 'upload' ? (
        <>
          <UploadBoard
            kicker="STEP 01"
            title="选择标书"
            aside={(
              <div className="duplicate-upload-summary">
                <span>{tenderFiles.length ? `${tenderFiles.length} 份招标文件` : '未上传招标文件'}</span>
                <strong>{bidFiles.length} 份投标文件</strong>
                <small>{formatFileSize(totalSize)}</small>
              </div>
            )}
          >
            <UploadRow
              index="01"
              title="招标文件"
              note="可选，可多份"
              onDropFiles={(files) => {
                const paths = resolveDroppedFilePaths(files);
                if (paths.length) void uploadTenderFile(paths);
              }}
              dropDisabled={busy !== null || isAnalysisRunning}
              actions={(
                <button type="button" className="primary-action" onClick={() => void uploadTenderFile()} disabled={busy !== null || isAnalysisRunning}>
                  {busy === 'tender' ? '选择中...' : tenderFiles.length ? '继续上传' : '上传'}
                </button>
              )}
            >
              {tenderFiles.length ? (
                <div className="duplicate-file-list">
                  {tenderFiles.map((file, index) => (
                    <button
                      key={file.file_path}
                      type="button"
                      className={`duplicate-document-tab${activeTenderFileId === file.id ? ' is-active' : ''}`}
                      onClick={() => setActiveTenderFileId(file.id)}
                    >
                      <span>{`招标文件${index + 1}`}</span>
                      <strong>{file.file_name}</strong>
                    </button>
                  ))}
                  {tenderFiles.map((file) => (
                    <FilePill key={`pill-${file.file_path}`} file={file} disabled={isAnalysisRunning} onRemove={() => {
                      void persistSelectedFiles(tenderFiles.filter((item) => item.file_path !== file.file_path), bidFiles)
                        .catch((error) => showToast(error instanceof Error ? error.message : '移除招标文件失败', 'error'));
                    }} />
                  ))}
                </div>
              ) : (
                <UploadEmpty title="等待招标文件" hint="可选。上传后，多份投标文件引用招标文件中的内容不计入重复。">
                  <button type="button" className="text-button" onClick={() => void uploadTenderFile()} disabled={busy !== null || isAnalysisRunning}>选择招标文件</button>
                </UploadEmpty>
              )}
            </UploadRow>

            <UploadRow
              index="02"
              title="投标文件"
              note="必选，可多份"
              onDropFiles={(files) => {
                const paths = resolveDroppedFilePaths(files);
                if (paths.length) void uploadBidFiles(paths);
              }}
              dropDisabled={busy !== null || isAnalysisRunning}
              actions={(
                <button type="button" className="primary-action" onClick={() => void uploadBidFiles()} disabled={busy !== null || isAnalysisRunning}>
                  {busy === 'bid' ? '选择中...' : '上传'}
                </button>
              )}
            >
              {bidFiles.length ? (
                <div className="duplicate-file-list">
                  {bidFiles.map((file) => (
                    <FilePill key={file.file_path} file={file} disabled={isAnalysisRunning} onRemove={() => {
                      void persistSelectedFiles(tenderFiles, bidFiles.filter((item) => item.file_path !== file.file_path))
                        .catch((error) => showToast(error instanceof Error ? error.message : '移除投标文件失败', 'error'));
                    }} />
                  ))}
                </div>
              ) : (
                <UploadEmpty title="等待投标文件" hint="至少上传两份投标文件，用于互相比对重复内容。">
                  <button type="button" className="text-button" onClick={() => void uploadBidFiles()} disabled={busy !== null || isAnalysisRunning}>选择投标文件</button>
                </UploadEmpty>
              )}
            </UploadRow>
          </UploadBoard>

          <section className="duplicate-guide-panel">
            <div className="duplicate-guide-head">
              <div>
                <strong>多维度筛查重复项</strong>
              </div>
            </div>

            <div className="duplicate-dimension-grid">
              {dimensions.map((item) => (
                <article key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>

            <ul className="duplicate-guide-list">
              {guideItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        </>
      ) : (
        <DuplicateAnalysisPane activeTab={activeAnalysisTab} onTabChange={setActiveAnalysisTab} metadataAnalysis={metadataAnalysis} outlineAnalysis={outlineAnalysis} contentAnalysis={contentAnalysis} imageAnalysis={imageAnalysis} bidFiles={bidFiles} startingAnalysis={startingAnalysis || analysisTask?.status === 'running'} onRerun={() => startDuplicateAnalysis(true)} />
      )}

      <AppDialog
        open={Boolean(exportedExcelPath)}
        onOpenChange={(open) => !open && setExportedExcelPath('')}
        kicker="导出完成"
        title="标书查重结果已导出"
        description={exportedExcelPath ? `文件已保存到：${exportedExcelPath}` : undefined}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setExportedExcelPath('')}>稍后打开</button>
            <button type="button" className="primary-action" onClick={() => { void openExportedExcelFile(); }}>打开文件</button>
          </>
        )}
      />

      <FloatingToolbar groups={toolbarGroups} label="标书查重工具条" />
    </div>
  );
}

export default DuplicateCheckPage;
