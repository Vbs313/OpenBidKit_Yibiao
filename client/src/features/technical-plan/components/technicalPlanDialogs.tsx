// 技术方案工作台的弹窗集合。
//
// 原本是 TechnicalPlanHome 的 JSX 尾部（7 个弹窗、约 230 行），与页面逻辑无关，
// 抽出来后页面只负责「什么时候开、点了以后干什么」。
// 形制对齐既有 components/contentEditDialogs.tsx：一个文件放同一页的多个弹窗。

import * as Dialog from '@radix-ui/react-dialog';
import type { CSSProperties } from 'react';
import { AppDialog, ProgressBar } from '../../../shared/ui';
import { TemplatePreview } from '../../export-format/components/TemplatePreview';
import type { ExportTemplateRecord } from '../../../shared/types/exportFormat';
import { workflowLabel } from '../technicalPlanHomeModel';
import type { WordControlWarningDialogState } from '../technicalPlanHomeModel';
import type { TechnicalPlanWorkflowKind } from '../../../shared/types/domains/technical-plan';

export interface WorkflowSwitchRequest {
  from: TechnicalPlanWorkflowKind;
  to: TechnicalPlanWorkflowKind;
  navigateBackOnCancel: boolean;
}


export interface ExportProgressState {
  open: boolean;
  running: boolean;
  progress: number;
  message: string;
  warnings: string[];
  mermaidCount: number;
  filePath?: string;
  error?: string;
}


export const initialExportProgress: ExportProgressState = {
  open: false,
  running: false,
  progress: 0,
  message: '',
  warnings: [],
  mermaidCount: 0,
};


export interface SortLeaveDialogProps {
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
  onDiscard: () => void;
  onSave: () => Promise<void>;
}

export function SortLeaveDialog({
  open,
  saving,
  onOpenChange,
  onContinue,
  onDiscard,
  onSave,
}: SortLeaveDialogProps) {
  return (
      <AppDialog
        open={open}
        onOpenChange={(open) => !open && onContinue()}
        kicker="目录排序"
        title="排序结果是否保存"
        description="当前目录排序还没有保存。保存后会更新目录编号并保留已生成正文；不保存则丢弃本次排序草稿。"
        cardClassName="outline-sort-leave-card"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={onContinue} disabled={saving}>继续排序</button>
            <button type="button" className="secondary-action" onClick={onDiscard} disabled={saving}>不保存</button>
            <button type="button" className="primary-action" onClick={() => { void onSave(); }} disabled={saving}>
              {saving ? '正在保存...' : '保存排序'}
            </button>
          </>
        )}
      />
  );
}

export interface WordControlWarningDialogProps {
  dialog: WordControlWarningDialogState | null;
  onClose: () => void;
}

export function WordControlWarningDialog({
  dialog,
  onClose,
}: WordControlWarningDialogProps) {
  return (
      <AppDialog
        open={Boolean(dialog)}
        onOpenChange={(open) => !open && onClose()}
        kicker="结果提醒"
        title={dialog?.title}
        description={dialog?.message}
        cardClassName="word-control-result-card"
        actions={<Dialog.Close className="primary-action" type="button">知道了</Dialog.Close>}
      >
        <div className="word-control-result-body">
              <div className="word-control-result-metrics">
                {dialog?.metrics.map((metric) => (
                  <section className="word-control-result-metric" key={metric.label}>
                    <strong>{metric.label}</strong>
                    <dl>
                      <div>
                        <dt>预期</dt>
                        <dd>{metric.expected}</dd>
                      </div>
                      <div>
                        <dt>实际</dt>
                        <dd>{metric.actual}</dd>
                      </div>
                    </dl>
                  </section>
                ))}
              </div>
              {dialog?.sections.length ? (
                <section className="word-control-result-sections">
                  <div className="word-control-result-sections-head">
                    <strong>未达标小节</strong>
                    <span>{dialog.sections.length} 个</span>
                  </div>
                  <div className="word-control-result-section-list">
                    {dialog.sections.map((section) => (
                      <div className="word-control-result-section" key={section.id}>
                        <span>{section.id} {section.title}</span>
                        <strong>{section.words.toLocaleString('zh-CN')} 字</strong>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
        </div>
      </AppDialog>
  );
}

export interface PetInstallDialogProps {
  open: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: () => Promise<void>;
}

export function PetInstallDialog({
  open,
  installing,
  onClose,
  onInstall,
}: PetInstallDialogProps) {
  return (
      <AppDialog
        open={open}
        onOpenChange={(open) => !open && !installing && onClose()}
        kicker="AI 调整"
        title="需要安装桌宠插件"
        description="AI 调整通过桌宠的 AI 对话完成。当前桌宠插件尚未安装或未启用，是否立即安装并启用？"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => onClose()} disabled={installing}>取消</button>
            <button type="button" className="primary-action" onClick={() => { void onInstall(); }} disabled={installing}>
              {installing ? '正在安装...' : '安装并启用'}
            </button>
          </>
        )}
      />
  );
}

export interface OutlineWordControlLeaveDialogProps {
  open: boolean;
  onResolve: (continueRun: boolean) => void;
}

export function OutlineWordControlLeaveDialog({
  open,
  onResolve,
}: OutlineWordControlLeaveDialogProps) {
  return (
      <AppDialog
        open={open}
        onOpenChange={(open) => !open && onResolve(false)}
        kicker="字数检查"
        title="AI生成小节数量未达预期"
        description="您手动修改的目录可能导致生成正文字数不符合预期"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => onResolve(false)}>再修改目录</button>
            <button type="button" className="primary-action" onClick={() => onResolve(true)}>仍然继续</button>
          </>
        )}
      />
  );
}

export interface WorkflowSwitchDialogProps {
  request: { from: TechnicalPlanWorkflowKind; to: TechnicalPlanWorkflowKind } | null;
  switching: boolean;
  clearText: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function WorkflowSwitchDialog({
  request,
  switching,
  clearText,
  onCancel,
  onConfirm,
}: WorkflowSwitchDialogProps) {
  return (
      <AppDialog
        open={Boolean(request)}
        onOpenChange={(open) => !open && !switching && onCancel()}
        kicker="切换模式"
        title={`确认切换到${request ? workflowLabel(request.to) : '新模式'}`}
        description={request
          ? `当前保存的进度是「${workflowLabel(request.from)}」模式生成的。切换到「${workflowLabel(request.to)}」会清空之前的已有进度。是否继续？`
          : '切换模式会清空当前模式下的生成进度。'}
        cardClassName="workflow-switch-card"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={onCancel} disabled={switching}>取消</button>
            <button type="button" className="primary-action" onClick={() => { void onConfirm(); }} disabled={switching}>
              {switching ? '正在切换...' : '继续切换'}
            </button>
          </>
        )}
      >
        <div className="workflow-switch-summary">
          <span>保留：招标文件、招标文件解析结果、参考知识库选择</span>
          <span>清空：{clearText}</span>
        </div>
      </AppDialog>
  );
}

export interface ExportTemplateDialogProps {
  open: boolean;
  isExporting: boolean;
  search: string;
  loading: boolean;
  templates: ExportTemplateRecord[];
  filteredTemplates: ExportTemplateRecord[];
  selectedTemplate: ExportTemplateRecord | null;
  previewStyle: CSSProperties;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (templateId: string) => void;
  onCreate: () => void;
  onConfirm: () => Promise<void>;
}

export function ExportTemplateDialog({
  open,
  isExporting,
  search,
  loading,
  templates,
  filteredTemplates,
  selectedTemplate,
  previewStyle,
  onOpenChange,
  onClose,
  onSearchChange,
  onSelect,
  onCreate,
  onConfirm,
}: ExportTemplateDialogProps) {
  return (
      <Dialog.Root open={open} onOpenChange={(open) => !open && !isExporting && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-template-select-dialog">
            <div className="export-template-select-head">
              <div>
                <span className="section-kicker">Word 导出</span>
                <Dialog.Title>选择导出模板</Dialog.Title>
                <Dialog.Description>选择一个已保存模板后继续导出。模板样式应用范围保持现有导出逻辑。</Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭模板选择" disabled={isExporting}>×</Dialog.Close>
            </div>

            <div className="export-template-select-body">
              <section className="export-template-select-list-panel" aria-label="模板列表">
                <input
                  className="export-template-select-search"
                  type="text"
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="搜索模板名称"
                />
                <div className="export-template-select-list">
                  {loading ? (
                    <div className="export-template-select-empty"><strong>正在读取模板</strong><span>请稍候...</span></div>
                  ) : null}
                  {!loading && filteredTemplates.length === 0 ? (
                    <div className="export-template-select-empty">
                      <strong>{templates.length ? '没有匹配模板' : '暂无可用模板'}</strong>
                      <span>{templates.length ? '请换个关键词搜索，或新建一个模板。' : '请先新建并保存模板，保存后再返回导出。'}</span>
                      <button type="button" className="secondary-action" onClick={onCreate} disabled={isExporting}>新建模板</button>
                    </div>
                  ) : null}
                  {!loading && filteredTemplates.map((template) => {
                    const selected = selectedTemplate?.template_id === template.template_id;
                    return (
                      <button
                        type="button"
                        className={`export-template-select-row${selected ? ' is-active' : ''}`}
                        key={template.template_id}
                        onClick={() => onSelect(template.template_id)}
                      >
                        <strong>{template.template_name}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="export-template-select-preview" aria-label="模板预览">
                {selectedTemplate ? (
                  <>
                    <div className="export-template-select-preview-head">
                      <span className="section-kicker">预览</span>
                      <strong>{selectedTemplate.template_name}</strong>
                    </div>
                    <TemplatePreview config={selectedTemplate.config} previewStyle={previewStyle} />
                  </>
                ) : (
                  <div className="export-template-select-preview-empty">
                    <strong>暂无模板预览</strong>
                    <span>选择模板后会在这里显示预览。</span>
                  </div>
                )}
              </section>
            </div>

            <div className="content-regenerate-actions export-template-select-actions">
              <button type="button" className="secondary-action" onClick={onCreate} disabled={isExporting}>新建模板</button>
              <Dialog.Close className="secondary-action" type="button" disabled={isExporting}>取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => { void onConfirm(); }} disabled={loading || !selectedTemplate || isExporting}>继续导出</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}

export interface ExportProgressDialogProps {
  progress: ExportProgressState;
  onReset: () => void;
  onOpenFile: () => Promise<void>;
}

export function ExportProgressDialog({
  progress,
  onReset,
  onOpenFile,
}: ExportProgressDialogProps) {
  return (
      <Dialog.Root
        open={progress.open}
        onOpenChange={(open) => {
          if (!open && !progress.running) {
            onReset();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="export-progress-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">Word 导出</span>
              <Dialog.Title>{progress.running ? '正在导出 Word' : progress.error ? '导出失败' : '导出完成'}</Dialog.Title>
              <Dialog.Description>
                {progress.mermaidCount > 0
                  ? `本次包含 ${progress.mermaidCount} 张 Mermaid 图，导出时会在本地转换成 Word 图片。`
                  : '正在将正文、表格和图片写入 Word 文档。'}
              </Dialog.Description>
            </div>
            <div className="export-progress-body">
              <ProgressBar value={progress.progress} label={`Word 导出进度 ${progress.progress}%`} />
              <p>{progress.message || '正在处理导出任务，请稍候。'}</p>
              {progress.warnings.length > 0 && (
                <div className="export-warning-list">
                  <strong>需要核对</strong>
                  {progress.warnings.slice(0, 4).map((warning) => <small key={warning}>{warning}</small>)}
                  {progress.warnings.length > 4 && <small>还有 {progress.warnings.length - 4} 条图片提示，请打开导出的 Word 核对。</small>}
                </div>
              )}
            </div>
            {!progress.running && (
              <div className="content-regenerate-actions">
                {!progress.error && progress.filePath && <button className="primary-action" type="button" onClick={() => { void onOpenFile(); }}>打开文件</button>}
                <Dialog.Close className={progress.filePath && !progress.error ? 'secondary-action' : 'primary-action'} type="button">知道了</Dialog.Close>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}
