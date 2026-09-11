// 正文编辑页的 5 个对话框：继续后处理、生成配置、HTML 图片类型、按需求重生成、图片预览。
//
// 原本是 ContentEditPage.tsx 里 return 顶层的 5 个 <Dialog.Root>（合计约 300 行）。
// JSX 原样搬出，页面局部量改为同名 props——渲染结果不变。

import * as Dialog from '@radix-ui/react-dialog';
import { ConsistencyRepairMode, ContentGenerationOptions, ContentIllustrationKind, ContentTableRequirement, OriginalPlanCoverageRepairMode } from '../../../shared/types/domains/technical-plan';
import { AppSwitch } from '../../../shared/ui';
import { ImageModelStatus, OutlineItem } from '../../../shared/types';
import type { Dispatch, SetStateAction } from 'react';

function ImageExampleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9.1a2.5 2.5 0 0 1 4.7 1.2c0 1.8-2.4 2.1-2.4 3.7" />
      <path d="M12 17h.01" strokeWidth="2.4" />
    </svg>
  );
}

type ContinuePostProcessingDialogProps = {
  continuePostProcessing: () => Promise<void>;
  continuePostProcessingDialogOpen: boolean;
  setContinuePostProcessingDialogOpen: Dispatch<SetStateAction<boolean>>;
  unresolvedCount: number;
};

export function ContinuePostProcessingDialog(props: ContinuePostProcessingDialogProps) {
  return (
<Dialog.Root open={props.continuePostProcessingDialogOpen} onOpenChange={props.setContinuePostProcessingDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card content-incomplete-decision-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>忽略未完成小节并继续？</Dialog.Title>
              <Dialog.Description asChild>
                <div className="content-incomplete-decision-copy">
                  <p className="content-incomplete-decision-summary">
                    仍有 <strong>{props.unresolvedCount} 个</strong>正文小节失败或未完成。
                  </p>
                  <div className="content-incomplete-decision-impact">
                    <strong>确认继续后：</strong>
                    <ul>
                      <li>这些小节将标记为“已忽略”</li>
                      <li>不再参与一致性检查、字数调整和图片编排</li>
                      <li>全文最少字数可能会分配到其余成功小节</li>
                    </ul>
                  </div>
                  <p className="content-incomplete-decision-warning">
                    完成后将不再提供失败小节重试入口。
                  </p>
                </div>
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void props.continuePostProcessing()}>确认并继续</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}

type GenerationDialogProps = {
  consistencyRepairModeOptions: { value: ConsistencyRepairMode; label: string; }[];
  developerMode: boolean;
  draftGenerationOptions: ContentGenerationOptions;
  generationDialogOpen: boolean;
  generationStrategyLocked: boolean;
  imageGenerationExamples: Record<ContentIllustrationKind, { src: string; alt: string; }>;
  imageModelAvailable: boolean;
  imageModelStatus: ImageModelStatus;
  imageModelStatusLabels: Record<ImageModelStatus, string>;
  isExpansionWorkflow: boolean;
  leaves: OutlineItem[];
  openHtmlImageTypesDialog: () => void;
  originalPlanCoverageRepairModeOptions: { value: OriginalPlanCoverageRepairMode; label: string; }[];
  paused: boolean;
  saveGenerationOptions: () => Promise<void>;
  setDraftGenerationOptions: Dispatch<SetStateAction<ContentGenerationOptions>>;
  setGenerationDialogOpen: Dispatch<SetStateAction<boolean>>;
  setHtmlImageTypesDialogOpen: Dispatch<SetStateAction<boolean>>;
  setPreviewImage: Dispatch<SetStateAction<{ src: string; alt: string; } | null>>;
  startGeneration: (simulatePartialFailures?: boolean) => Promise<void>;
  tableRequirementOptions: { value: ContentTableRequirement; label: string; }[];
  taskBlocksGeneration: boolean;
  taskInFlight: boolean;
};

export function GenerationDialog(props: GenerationDialogProps) {
  return (
<Dialog.Root
        open={props.generationDialogOpen}
        onOpenChange={(open) => {
          props.setGenerationDialogOpen(open);
          if (!open) props.setHtmlImageTypesDialogOpen(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-generation-config-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <Dialog.Title>正文生成配置</Dialog.Title>
            </div>
            <div className="content-generation-config-list">
              <div className="content-generation-config-group">
                <label className="content-generation-config-row">
                  <span>
                    <strong>表格需求</strong>
                  </span>
                  <select
                    value={props.draftGenerationOptions.tableRequirement}
                    disabled={props.generationStrategyLocked}
                    onChange={(event) => props.setDraftGenerationOptions((prev) => ({ ...prev, tableRequirement: event.target.value as ContentTableRequirement }))}
                  >
                    {props.tableRequirementOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="content-generation-config-group">
                <label className="content-generation-config-row">
                  <span>
                    <strong>全文一致性审计</strong>
                  </span>
                  <AppSwitch
                    checked={props.draftGenerationOptions.enableConsistencyAudit}
                    disabled={props.generationStrategyLocked}
                    onCheckedChange={(checked) => props.setDraftGenerationOptions((prev) => ({ ...prev, enableConsistencyAudit: checked }))}
                    aria-label="是否启用全文一致性审计" />
                </label>
                {props.draftGenerationOptions.enableConsistencyAudit && (
                  <label className="content-generation-config-row">
                    <span>
                      <strong>一致性修复方式</strong>
                    </span>
                    <select
                      value={props.draftGenerationOptions.consistencyRepairMode}
                      disabled={props.generationStrategyLocked}
                      onChange={(event) => props.setDraftGenerationOptions((prev) => ({ ...prev, consistencyRepairMode: event.target.value as ConsistencyRepairMode }))}
                    >
                      {props.consistencyRepairModeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {props.isExpansionWorkflow && (
                <div className="content-generation-config-group">
                  <label className="content-generation-config-row">
                    <span>
                      <strong>原方案覆盖审计</strong>
                    </span>
                    <AppSwitch
                      checked={props.draftGenerationOptions.enableOriginalPlanCoverageAudit}
                      disabled={props.generationStrategyLocked}
                      onCheckedChange={(checked) => props.setDraftGenerationOptions((prev) => ({ ...prev, enableOriginalPlanCoverageAudit: checked }))}
                      aria-label="是否启用原方案覆盖审计" />
                  </label>
                  {props.draftGenerationOptions.enableOriginalPlanCoverageAudit && (
                    <label className="content-generation-config-row">
                      <span>
                        <strong>原方案覆盖修复方式</strong>
                      </span>
                      <select
                        value={props.draftGenerationOptions.originalPlanCoverageRepairMode}
                        disabled={props.generationStrategyLocked}
                        onChange={(event) => props.setDraftGenerationOptions((prev) => ({ ...prev, originalPlanCoverageRepairMode: event.target.value as OriginalPlanCoverageRepairMode }))}
                      >
                        {props.originalPlanCoverageRepairModeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
              <div className="content-generation-config-group">
                <div className="content-generation-config-row">
                  <div className="content-generation-image-option-title">
                    <strong>使用 AI 生图</strong>
                    <button
                      type="button"
                      className="content-generation-example-button"
                      onClick={() => props.setPreviewImage(props.imageGenerationExamples.ai)}
                      aria-label="查看 AI 生图示例"
                      title="查看 AI 生图示例"
                    >
                      <ImageExampleIcon />
                    </button>
                  </div>
                  <div className="content-generation-config-control">
                    <em className={`content-image-status is-${props.imageModelStatus}`}>{props.imageModelStatusLabels[props.imageModelStatus]}</em>
                    <AppSwitch
                      checked={props.draftGenerationOptions.useAiImages && props.imageModelAvailable}
                      disabled={props.generationStrategyLocked || !props.imageModelAvailable}
                      onCheckedChange={(checked) => props.setDraftGenerationOptions((prev) => ({ ...prev, useAiImages: checked }))}
                      aria-label="是否使用 AI 生图" />
                  </div>
                </div>
                {props.draftGenerationOptions.useAiImages && props.imageModelAvailable && (
                  <label className="content-generation-config-row">
                    <span><strong>AI 生图上限</strong></span>
                    <input
                      type="number"
                      min="0"
                      max={Math.max(1, props.leaves.length)}
                      value={props.draftGenerationOptions.maxAiImages}
                      disabled={props.generationStrategyLocked}
                      onChange={(event) => props.setDraftGenerationOptions((prev) => ({
                        ...prev,
                        maxAiImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, props.leaves.length))),
                      }))}
                    />
                  </label>
                )}
              </div>
              <div className="content-generation-config-group">
                <div className="content-generation-config-row">
                  <div className="content-generation-image-option-title">
                    <strong>使用 Mermaid 生图</strong>
                    <button
                      type="button"
                      className="content-generation-example-button"
                      onClick={() => props.setPreviewImage(props.imageGenerationExamples.mermaid)}
                      aria-label="查看 Mermaid 生图示例"
                      title="查看 Mermaid 生图示例"
                    >
                      <ImageExampleIcon />
                    </button>
                  </div>
                  <AppSwitch
                    checked={props.draftGenerationOptions.useMermaidImages}
                    disabled={props.generationStrategyLocked}
                    onCheckedChange={(checked) => props.setDraftGenerationOptions((prev) => ({ ...prev, useMermaidImages: checked }))}
                    aria-label="是否使用 Mermaid 生图" />
                </div>
                {props.draftGenerationOptions.useMermaidImages && (
                  <label className="content-generation-config-row">
                    <span><strong>Mermaid 生图上限</strong></span>
                    <input
                      type="number"
                      min="0"
                      max={Math.max(1, props.leaves.length)}
                      value={props.draftGenerationOptions.maxMermaidImages}
                      disabled={props.generationStrategyLocked}
                      onChange={(event) => props.setDraftGenerationOptions((prev) => ({
                        ...prev,
                        maxMermaidImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, props.leaves.length))),
                      }))}
                    />
                  </label>
                )}
              </div>
              <div className="content-generation-config-group">
                <div className="content-generation-config-row">
                  <div className="content-generation-image-option-title">
                    <strong>生成 HTML 图片</strong>
                    <button
                      type="button"
                      className="content-generation-example-button"
                      onClick={() => props.setPreviewImage(props.imageGenerationExamples.html)}
                      aria-label="查看 HTML 生图示例"
                      title="查看 HTML 生图示例"
                    >
                      <ImageExampleIcon />
                    </button>
                  </div>
                  <AppSwitch
                    checked={props.draftGenerationOptions.useHtmlImages}
                    disabled={props.generationStrategyLocked}
                    onCheckedChange={(checked) => props.setDraftGenerationOptions((prev) => ({ ...prev, useHtmlImages: checked }))}
                    aria-label="是否生成 HTML 图片" />
                </div>
                {props.draftGenerationOptions.useHtmlImages && (
                  <label className="content-generation-config-row">
                    <span><strong>HTML 生图上限</strong></span>
                    <input
                      type="number"
                      min="0"
                      max={Math.max(1, props.leaves.length)}
                      value={props.draftGenerationOptions.maxHtmlImages}
                      disabled={props.generationStrategyLocked}
                      onChange={(event) => props.setDraftGenerationOptions((prev) => ({
                        ...prev,
                        maxHtmlImages: Math.max(0, Math.min(Number(event.target.value) || 0, Math.max(1, props.leaves.length))),
                      }))}
                    />
                  </label>
                )}
              </div>
              {props.draftGenerationOptions.useHtmlImages && (
                <div className="content-generation-config-group">
                  <div className="content-generation-config-row">
                    <span><strong>高级设置</strong></span>
                    <button type="button" className="secondary-action" onClick={props.openHtmlImageTypesDialog} disabled={props.generationStrategyLocked}>打开</button>
                  </div>
                </div>
              )}
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={props.saveGenerationOptions} disabled={props.taskInFlight || props.paused}>
                保存配置
              </button>
              {!props.paused && props.developerMode && (
                <button type="button" className="secondary-action" onClick={() => void props.startGeneration(true)} disabled={props.taskBlocksGeneration || props.leaves.length < 2}>
                  以随机失败模式开始
                </button>
              )}
              {!props.paused && <button type="button" className="primary-action" onClick={() => void props.startGeneration(false)} disabled={props.taskBlocksGeneration}>开始生成</button>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}

type HtmlImageTypesDialogProps = {
  confirmHtmlImageTypes: () => void;
  htmlImageTypesDialogOpen: boolean;
  htmlImageTypesDraft: string;
  setHtmlImageTypesDialogOpen: Dispatch<SetStateAction<boolean>>;
  setHtmlImageTypesDraft: Dispatch<SetStateAction<string>>;
};

export function HtmlImageTypesDialog(props: HtmlImageTypesDialogProps) {
  return (
<Dialog.Root open={props.htmlImageTypesDialogOpen} onOpenChange={props.setHtmlImageTypesDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal html-image-types-modal" />
          <Dialog.Content className="content-regenerate-card html-image-types-card" aria-describedby={undefined}>
            <div className="content-regenerate-card-head">
              <Dialog.Title>HTML 可生成的图片类型</Dialog.Title>
            </div>
            <textarea
              value={props.htmlImageTypesDraft}
              onChange={(event) => props.setHtmlImageTypesDraft(event.target.value)}
              aria-label="HTML 可生成的图片类型"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={props.confirmHtmlImageTypes}>确认</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}

type RequirementItemDialogProps = {
  regenerateRequirement: string;
  requirementItem: OutlineItem | null;
  setRegenerateRequirement: Dispatch<SetStateAction<string>>;
  setRequirementItem: Dispatch<SetStateAction<OutlineItem | null>>;
  startSectionRegeneration: () => Promise<void>;
  taskBlocksGeneration: boolean;
};

export function RequirementItemDialog(props: RequirementItemDialogProps) {
  return (
<Dialog.Root
        open={Boolean(props.requirementItem)}
        onOpenChange={(open) => {
          if (!open) {
            props.setRequirementItem(null);
            props.setRegenerateRequirement('');
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">重新生成</span>
              <Dialog.Title>{props.requirementItem?.id} {props.requirementItem?.title}</Dialog.Title>
              <Dialog.Description>输入本次重新生成的具体要求，AI 会只覆盖当前小节正文。</Dialog.Description>
            </div>
            <textarea
              value={props.regenerateRequirement}
              onChange={(event) => props.setRegenerateRequirement(event.target.value)}
              placeholder="例如：强化实施步骤，减少背景描述，突出设备配置与运维响应。"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={props.startSectionRegeneration} disabled={props.taskBlocksGeneration}>开始重新生成</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}

type PreviewImageDialogProps = {
  previewImage: { src: string; alt: string; } | null;
  setPreviewImage: Dispatch<SetStateAction<{ src: string; alt: string; } | null>>;
};

export function PreviewImageDialog(props: PreviewImageDialogProps) {
  return (
<Dialog.Root open={Boolean(props.previewImage)} onOpenChange={(open) => !open && props.setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-modal" />
          <Dialog.Content className="image-preview-card">
            <Dialog.Close className="image-preview-close" type="button" aria-label="关闭图片预览">×</Dialog.Close>
            <Dialog.Title>{props.previewImage?.alt || '图片预览'}</Dialog.Title>
            {props.previewImage && <img src={props.previewImage.src} alt={props.previewImage.alt} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
  );
}
