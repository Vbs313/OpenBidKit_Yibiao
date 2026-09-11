import * as Dialog from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { AppSwitch } from '../../../shared/ui';
import type { OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import { outlineExpansionModeLabels } from '../outlineModeLabels';
import { formatWordCountDraft, parseWordCountDraft } from '../outlineWordControl';
import { OutlineKnowledgePicker } from './OutlineKnowledgePicker';

// 目录生成配置弹窗：从 OutlineEditPage 原样搬出的受控展示组件。
// 页面持有状态与 IPC（打开弹窗 / 保存配置 / 开始生成），组件只渲染配置项并回传输入。

const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录；知识库不参与目录补充，但会用于后续全局事实和正文生成。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];
const technicalDocumentModeOptions: Array<{ value: Extract<OutlineMode, 'response-file' | 'standalone-technical'>; title: string; description: string }> = [
  {
    value: 'response-file',
    title: '完整投标文件结构',
    description: '保留技术方案、项目管理方案、监理大纲、施工组织设计或技术标等外层章节，便于组织完整投标文件。',
  },
  {
    value: 'standalone-technical',
    title: '技术文件独立成册',
    description: '一级目录直接从技术评分大项开始，不再创建技术方案、项目管理方案、监理大纲、施工组织设计或技术标等外层总目录。',
  },
];

interface OutlineGenerationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isExpansionWorkflow: boolean;
  hasOutlineData: boolean;
  draftOutlineMode: OutlineMode;
  setDraftOutlineMode: (value: OutlineMode) => void;
  draftOutlineExpansionMode: OutlineExpansionMode;
  setDraftOutlineExpansionMode: (value: OutlineExpansionMode) => void;
  draftMinimumWords: string;
  setDraftMinimumWords: (value: string) => void;
  draftMaximumWords: string;
  setDraftMaximumWords: (value: string) => void;
  draftSectionWords: string;
  setDraftSectionWords: (value: string) => void;
  draftStrictSectionWords: boolean;
  setDraftStrictSectionWords: (value: boolean) => void;
  parsedDraftSectionWords: number;
  estimatedPages: number | null;
  wordControlRequiresRegeneration: boolean;
  outlineModeRequiresRegeneration: boolean;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  savingOutlineConfig: boolean;
  generating: boolean;
  contentMutationLocked: boolean;
  projectOverview: string;
  saveOutlineConfig: () => void;
  generateOutline: () => void;
  knowledgePicker: ComponentProps<typeof OutlineKnowledgePicker>;
}

function OutlineGenerationDialog({
  open,
  onOpenChange,
  isExpansionWorkflow,
  hasOutlineData,
  draftOutlineMode,
  setDraftOutlineMode,
  draftOutlineExpansionMode,
  setDraftOutlineExpansionMode,
  draftMinimumWords,
  setDraftMinimumWords,
  draftMaximumWords,
  setDraftMaximumWords,
  draftSectionWords,
  setDraftSectionWords,
  draftStrictSectionWords,
  setDraftStrictSectionWords,
  parsedDraftSectionWords,
  estimatedPages,
  wordControlRequiresRegeneration,
  outlineModeRequiresRegeneration,
  outlineWordControlSnapshot,
  savingOutlineConfig,
  generating,
  contentMutationLocked,
  projectOverview,
  saveOutlineConfig,
  generateOutline,
  knowledgePicker,
}: OutlineGenerationDialogProps) {
  const renderOutlineExpansionModePicker = () => {
    if (!isExpansionWorkflow) {
      return null;
    }

    return (
      <section className="outline-generation-config-section outline-expansion-mode-section">
        <div className="outline-generation-config-head">
          <strong>原方案目录使用方式</strong>
          <span>{outlineExpansionModeLabels[draftOutlineExpansionMode]}</span>
        </div>
        <div className="outline-expansion-mode-switch">
          {outlineExpansionModeOptions.map((option) => {
            const selected = draftOutlineExpansionMode === option.value;
            return (
              <button
                type="button"
                className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => setDraftOutlineExpansionMode(option.value)}
                disabled={generating}
                aria-pressed={selected}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            );
          })}
        </div>
        {outlineModeRequiresRegeneration && (
          <div className="outline-word-control-notice">
            技术文件结构已改变，需要重新生成目录后才能生效！
          </div>
        )}
      </section>
    );
  };

  const renderTechnicalDocumentModePicker = () => {
    if (isExpansionWorkflow) {
      return null;
    }

    return (
      <section className="outline-generation-config-section outline-expansion-mode-section">
        <div className="outline-generation-config-head">
          <strong>技术文件结构</strong>
          <span>{technicalDocumentModeOptions.find((option) => option.value === draftOutlineMode)?.title}</span>
        </div>
        <div className="outline-expansion-mode-switch">
          {technicalDocumentModeOptions.map((option) => {
            const selected = draftOutlineMode === option.value;
            return (
              <button
                type="button"
                className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => setDraftOutlineMode(option.value)}
                disabled={generating}
                aria-pressed={selected}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="outline-generation-config-card">
          <Dialog.Title className="sr-only">{hasOutlineData ? '重新生成目录' : '生成目录'}</Dialog.Title>
          <Dialog.Description className="sr-only">选择本次目录生成方式、字数控制和参考知识库。</Dialog.Description>

          <div className="outline-generation-config-body">
            {/* 左栏：所有配置项 */}
            <div className="outline-generation-config-left">
              {renderTechnicalDocumentModePicker()}
              {renderOutlineExpansionModePicker()}
              <section className="outline-generation-config-section outline-word-control-section">
                <div className="content-generation-config-row">
                  <span>
                    <strong>全文字数/页数预设</strong>
                    <small>在目录生成阶段，就要预设好全文生成的字数，默认0表示不控制</small>
                  </span>
                </div>
                <div className="outline-word-control-options">
                  <div className="outline-word-control-grid">
                    <label>
                      <span>最少字数（万）</span>
                      <input inputMode="decimal" value={draftMinimumWords} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMinimumWords(event.target.value)} onBlur={() => setDraftMinimumWords(formatWordCountDraft(parseWordCountDraft(draftMinimumWords) ?? 0))} />
                    </label>
                    <label>
                      <span>最多字数（万）</span>
                      <input inputMode="decimal" value={draftMaximumWords} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMaximumWords(event.target.value)} onBlur={() => setDraftMaximumWords(formatWordCountDraft(parseWordCountDraft(draftMaximumWords) ?? 0))} />
                    </label>
                    <label>
                      <span>每小节字数（万）</span>
                      <input inputMode="decimal" value={draftSectionWords} onChange={(event) => {
                        if (!/^\d*(?:\.\d{0,4})?$/.test(event.target.value)) return;
                        setDraftSectionWords(event.target.value);
                      }} onBlur={() => {
                        const sectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
                        setDraftSectionWords(formatWordCountDraft(sectionWords));
                        if (sectionWords === 0) setDraftStrictSectionWords(false);
                      }} />
                    </label>
                  </div>
                  <small className="outline-word-control-help">
                    <span>填2代表20000字，0.15代表1500字，默认0表示不控制，AI默认生成多少就是多少。</span>
                    <span>如果<strong className="outline-word-control-highlight">您使用的不是gpt-5.6-sol</strong>，推荐按照您模型的能力上限填写每小节字数，否则扩写过程会非常漫长。</span>
                  </small>
                  <div className="content-generation-config-row">
                    <span>
                      <strong>强控小节字数</strong>
                      <small>{draftStrictSectionWords ? '强制控制每小节字数必须是预设值的正负 20%' : '仅控制总字数'}</small>
                    </span>
                    <AppSwitch checked={draftStrictSectionWords} onCheckedChange={setDraftStrictSectionWords} disabled={parsedDraftSectionWords === 0} aria-label="强控小节字数，允许范围为预设值的正负 20%" />
                  </div>
                  <div className="outline-word-control-estimate">
                      <div className="outline-word-control-estimate-label">预估页数</div>
                      <div className="outline-word-control-estimate-value">
                        {estimatedPages === null ? (
                          <span className="outline-word-control-estimate-empty">--</span>
                        ) : (
                          <>
                            <span className="outline-word-control-estimate-number">{estimatedPages}</span>
                            <span className="outline-word-control-estimate-unit">页</span>
                          </>
                        )}
                      </div>
                      <div className="outline-word-control-estimate-hint">
                        {estimatedPages === null ? '请先设置总字数范围' : '页数和排版有关，无法精确预估'}
                      </div>
                    </div>
                  </div>
                {wordControlRequiresRegeneration && (
                  <div className="outline-word-control-notice">
                    {outlineWordControlSnapshot ? '生成目录后若修改了字数设置，需要重新生成目录才能生效！' : '当前目录缺少字数控制生效配置，请重新生成目录。'}
                  </div>
                )}
              </section>
            </div>
            {/* 右栏：知识库选择器 */}
            <section className="outline-generation-config-section outline-knowledge-picker">
              <div className="outline-generation-config-head">
                <strong>参考知识库</strong>
                <span>已选择 {knowledgePicker.draftKnowledgeDocumentIds.length} 个文档</span>
              </div>
              <OutlineKnowledgePicker {...knowledgePicker} />
            </section>
          </div>

          <div className="content-regenerate-actions">
            <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
            <button type="button" className="secondary-action" onClick={() => { void saveOutlineConfig(); }} disabled={generating || contentMutationLocked || savingOutlineConfig}>
              {savingOutlineConfig ? '正在保存...' : '保存配置'}
            </button>
            <button type="button" className="primary-action" onClick={generateOutline} disabled={generating || contentMutationLocked || savingOutlineConfig || !projectOverview}>
              {hasOutlineData ? '重新生成目录' : '开始生成'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default OutlineGenerationDialog;
