import * as Dialog from '@radix-ui/react-dialog';
import type { BidSectionExtractionStatus, BidSectionMode } from '../../../shared/types/domains/technical-plan';
import { bidAnalysisTasks } from '../services/bidAnalysisWorkflow';
import { getModeForSelection, getModeLabel, modeOptions, normalizeSelectedTaskIds, requiredBidAnalysisTaskIds } from '../bidAnalysisModel';

interface BidAnalysisConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftSelectedTaskIds: string[];
  onToggleDraftTask: (taskId: string) => void;
  onSelectPreset: (preset: 'key' | 'full') => void;
  draftBidSectionMode: BidSectionMode;
  onDraftBidSectionModeChange: (mode: BidSectionMode) => void;
  hasTenderFile: boolean;
  bidSectionExtractionStatus: BidSectionExtractionStatus;
  bidSectionCount: number;
  selectedSectionTitle?: string;
  sectionTaskRunning: boolean;
  taskRunning: boolean;
  onOpenSectionSelector: () => void | Promise<void>;
  onStartSectionExtraction: () => void | Promise<void>;
  onSaveConfig: () => Promise<unknown>;
  onSaveConfigError: (error: unknown) => void;
  onStartAnalysis: () => void;
}

// 招标文件解析配置弹窗：从 BidAnalysisPage 原样搬出的受控展示组件（含任务勾选渲染器）。
export function BidAnalysisConfigDialog({
  open,
  onOpenChange,
  draftSelectedTaskIds,
  onToggleDraftTask,
  onSelectPreset,
  draftBidSectionMode,
  onDraftBidSectionModeChange,
  hasTenderFile,
  bidSectionExtractionStatus,
  bidSectionCount,
  selectedSectionTitle,
  sectionTaskRunning,
  taskRunning,
  onOpenSectionSelector,
  onStartSectionExtraction,
  onSaveConfig,
  onSaveConfigError,
  onStartAnalysis,
}: BidAnalysisConfigDialogProps) {

  const renderConfigTask = (definition: typeof bidAnalysisTasks[number]) => {
    const selected = normalizeSelectedTaskIds(draftSelectedTaskIds).includes(definition.id);
    const required = definition.required;

    return (
      <label className={`bid-analysis-config-item${selected ? ' is-selected' : ''}${required ? ' is-required' : ''}`} key={definition.id}>
        <input
          type="checkbox"
          checked={selected}
          disabled={required || taskRunning}
          onChange={() => onToggleDraftTask(definition.id)}
        />
        <span>
          <strong>{definition.label}</strong>
        </span>
        {required && <em>必选</em>}
      </label>
    );
  };

  const draftMode = getModeForSelection(draftSelectedTaskIds);
  const draftSelectedCount = normalizeSelectedTaskIds(draftSelectedTaskIds).length;
  const hasExtractedBidSections = bidSectionExtractionStatus === 'success' && bidSectionCount >= 2;
  const bidSectionActionLabel = sectionTaskRunning
    ? '识别中...'
    : hasExtractedBidSections
      ? selectedSectionTitle ? '更换' : '选择标段'
      : bidSectionExtractionStatus === 'error' ? '重新识别标段' : '识别标段';

  return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="bid-analysis-config-card">
            <Dialog.Title className="sr-only">招标文件解析配置</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次招标文件需要解析的项目。</Dialog.Description>

            <header className="bid-analysis-config-head">
              <div>
                <span className="section-kicker">解析配置</span>
                <strong>招标文件解析配置</strong>
              </div>
            </header>

            <div className="bid-analysis-config-body">
              <section className="bid-analysis-config-section is-compact">
                <div className="bid-analysis-config-section-head">
                  <strong>投标范围</strong>
                  <span>{draftBidSectionMode === 'multiple' ? '多标段' : '默认单标段'}</span>
                </div>
                <div className="bid-analysis-config-presets" role="group" aria-label="投标范围模式">
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftBidSectionMode === 'single' ? ' is-active' : ''}`}
                    onClick={() => onDraftBidSectionModeChange('single')}
                    disabled={taskRunning}
                  >
                    <span>单标段</span>
                    <small>默认</small>
                  </button>
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftBidSectionMode === 'multiple' ? ' is-active' : ''}`}
                    onClick={() => onDraftBidSectionModeChange('multiple')}
                    disabled={taskRunning}
                  >
                    <span>多标段</span>
                    <small>AI 识别</small>
                  </button>
                </div>
                {draftBidSectionMode === 'multiple' && (
                  <div className="bid-analysis-section-action">
                    {selectedSectionTitle && (
                      <>
                        <span className="bid-analysis-section-label">当前选择的标段</span>
                        <span className="bid-analysis-section-chip">{selectedSectionTitle}</span>
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary-action bid-analysis-section-change"
                      onClick={() => {
                        if (hasExtractedBidSections) {
                          void onOpenSectionSelector();
                          return;
                        }
                        void onStartSectionExtraction();
                      }}
                      disabled={!hasTenderFile || taskRunning}
                    >
                      {bidSectionActionLabel}
                    </button>
                  </div>
                )}
              </section>

              <section className="bid-analysis-config-section is-compact">
                <div className="bid-analysis-config-section-head">
                  <strong>解析范围</strong>
                  <span>{getModeLabel(draftMode)}</span>
                </div>
                <div className="bid-analysis-config-presets" role="group" aria-label="快速选择解析项">
                  {modeOptions.map((option) => (
                    <button
                      type="button"
                      className={`bid-analysis-config-preset${draftMode === option.id ? ' is-active' : ''}`}
                      key={option.id}
                      onClick={() => onSelectPreset(option.id)}
                      disabled={taskRunning}
                    >
                      <span>{option.title}</span>
                      <small>{option.badge}</small>
                    </button>
                  ))}
                </div>
              </section>

              <section className="bid-analysis-config-section">
                <div className="bid-analysis-config-section-head">
                  <strong>关键项</strong>
                  <span>{requiredBidAnalysisTaskIds.length} 项必选</span>
                </div>
                <div className="bid-analysis-config-grid">
                  {bidAnalysisTasks.filter((definition) => definition.required).map(renderConfigTask)}
                </div>
              </section>

              <section className="bid-analysis-config-section">
                <div className="bid-analysis-config-section-head">
                  <strong>其他项</strong>
                  <span>当前共选择 {draftSelectedCount} 项</span>
                </div>
                <div className="bid-analysis-config-grid">
                  {bidAnalysisTasks.filter((definition) => !definition.required).map(renderConfigTask)}
                </div>
              </section>
            </div>

            <div className="content-regenerate-actions bid-analysis-config-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  void onSaveConfig().catch((error) => onSaveConfigError(error));
                }}
                disabled={taskRunning}
              >
                保存配置
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={onStartAnalysis}
                disabled={taskRunning || !hasTenderFile}
              >
                开始解析
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}
