// 废标项检查的「选择标书」「无效与废标项」两步视图。
//
// 从 RejectionCheckPage 的三元 step 分支里整段搬出来（JSX 逐字，仅去掉了外层缩进）。
// 第三步（检查结果）刻意留在页面：它有 43 个依赖，抽出来就是一个 43 props 的门面。

import { MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, UploadBoard, UploadEmpty, UploadRow } from '../../../shared/ui';
import { extractionStatusLabels, getBidDocumentLabel, getTenderDocumentLabel, resultTabs, sourceLabels } from '../model';
import { DocumentFilePill } from './findingItems';
import type {
  RejectionCheckRunStatus,
  RejectionDocumentContent,
  RejectionDocumentRole,
  RejectionDocumentTabId,
  RejectionExtractionState,
  RejectionResultTab,
} from '../../../shared/types/domains/rejection-check';

export interface DocumentsStepViewProps {
  activeDocument: RejectionDocumentContent | null;
  activeDocumentTab: RejectionDocumentTabId;
  activeTenderSourceDocument: RejectionDocumentContent | null;
  bidDocuments: RejectionDocumentContent[];
  busy: 'technical-plan' | 'tender-upload' | 'bid-upload' | 'remove' | null;
  documentsLocked: boolean;
  importParsedDocument: (role: RejectionDocumentRole, filePaths?: string[]) => Promise<void>;
  readTenderFromTechnicalPlan: () => Promise<void>;
  removeDocument: (role: RejectionDocumentRole, documentId?: string) => void;
  resolveDroppedFilePaths: (files: FileList) => string[];
  setActiveDocumentTab: (tabId: RejectionDocumentTabId) => void;
  tenderDocuments: RejectionDocumentContent[];
}

export function DocumentsStepView({
  activeDocument,
  activeDocumentTab,
  activeTenderSourceDocument,
  bidDocuments,
  busy,
  documentsLocked,
  importParsedDocument,
  readTenderFromTechnicalPlan,
  removeDocument,
  resolveDroppedFilePaths,
  setActiveDocumentTab,
  tenderDocuments,
}: DocumentsStepViewProps) {
  return (
    <>
      <UploadBoard kicker="STEP 01" title="选择标书">
        <UploadRow
          index="01"
          title="招标文件"
          onDropFiles={(files) => {
            const paths = resolveDroppedFilePaths(files);
            if (paths.length) void importParsedDocument('tender', paths);
          }}
          dropDisabled={documentsLocked}
          actions={(
            <>
              <button type="button" className="secondary-action" onClick={readTenderFromTechnicalPlan} disabled={documentsLocked}>
                {busy === 'technical-plan' ? '读取中...' : '从技术方案读取'}
              </button>
              <button type="button" className="primary-action" onClick={() => void importParsedDocument('tender')} disabled={documentsLocked}>
                {busy === 'tender-upload' ? '解析中...' : tenderDocuments.length ? '继续上传' : '上传'}
              </button>
            </>
          )}
        >
          {tenderDocuments.length ? (
            <div className="duplicate-file-list rejection-bid-file-list">
              {tenderDocuments.map((document, index) => (
                <div className="rejection-bid-file-entry" key={document.id}>
                  <span>{`招标文件${index + 1}`}</span>
                  <DocumentFilePill document={document} onRemove={() => removeDocument('tender', document.id)} removeDisabled={documentsLocked} />
                </div>
              ))}
            </div>
          ) : (
            <UploadEmpty title="等待招标文件" hint="用于识别废标条款、响应格式和强制性要求。">
              <button type="button" className="text-button" onClick={() => void importParsedDocument('tender')} disabled={documentsLocked}>选择招标文件</button>
            </UploadEmpty>
          )}
        </UploadRow>

        <UploadRow
          index="02"
          title="投标文件"
          note="必选，可多份"
          onDropFiles={(files) => {
            const paths = resolveDroppedFilePaths(files);
            if (paths.length) void importParsedDocument('bid', paths);
          }}
          dropDisabled={documentsLocked}
          actions={(
            <button type="button" className="primary-action" onClick={() => void importParsedDocument('bid')} disabled={documentsLocked}>
              {busy === 'bid-upload' ? '解析中...' : bidDocuments.length ? '继续上传' : '上传'}
            </button>
          )}
        >
          {bidDocuments.length ? (
            <div className="duplicate-file-list rejection-bid-file-list">
              {bidDocuments.map((document, index) => (
                <div className="rejection-bid-file-entry" key={document.id}>
                  <span>{`投标文件${index + 1}`}</span>
                  <DocumentFilePill document={document} onRemove={() => removeDocument('bid', document.id)} removeDisabled={documentsLocked} />
                </div>
              ))}
            </div>
          ) : (
            <UploadEmpty title="等待投标文件" hint="可一次选择多份，也可以后续继续追加上传。">
              <button type="button" className="text-button" onClick={() => void importParsedDocument('bid')} disabled={documentsLocked}>选择投标文件</button>
            </UploadEmpty>
          )}
        </UploadRow>
      </UploadBoard>

      <div className="document-switch-tabs" role="tablist" aria-label="废标项检查正文切换">
        {[
          ...(tenderDocuments.length > 1 ? [{ id: 'tender', label: '招标文件全文' }] : []),
          ...(tenderDocuments.length > 1 ? tenderDocuments.map((document, index) => ({ id: document.id, label: `招标文件${index + 1}` })) : [{ id: 'tender', label: '招标文件' }]),
          ...bidDocuments.map((document, index) => ({ id: document.id, label: `投标文件${index + 1}` })),
        ].map((tab) => {
          const isActive = tab.id === activeDocumentTab;
          return (
            <button
              type="button"
              className={`document-switch-tab${isActive ? ' is-active' : ''}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`rejection-document-panel-${tab.id}`}
              id={`document-switch-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveDocumentTab(tab.id)}
            >
              <strong>{tab.label}</strong>
            </button>
          );
        })}
      </div>

      <section
        className="rejection-reader-card analysis-markdown-card"
        role="tabpanel"
        id={`rejection-document-panel-${activeDocumentTab}`}
        aria-labelledby={`document-switch-tab-${activeDocumentTab}`}
      >
        <div className="analysis-result-head rejection-reader-head">
          <strong>{activeDocumentTab === 'tender' ? '招标文件正文' : activeTenderSourceDocument ? `${getTenderDocumentLabel(tenderDocuments, activeDocumentTab)}正文` : `${getBidDocumentLabel(bidDocuments, activeDocumentTab)}正文`}</strong>
          <span>{activeDocument ? `${activeDocument.fileName} · ${sourceLabels[activeDocument.source]}` : '等待上传'}</span>
        </div>

        {activeDocument ? (
          <MarkdownFullscreenViewer className="markdown-viewer rejection-markdown-viewer" title={`${activeDocument.fileName}全屏查看`}>
            <MarkdownRenderer>
              {activeDocument.content}
            </MarkdownRenderer>
          </MarkdownFullscreenViewer>
        ) : (
          <div className="markdown-empty-state rejection-empty-reader">
            <strong>尚未准备{activeDocumentTab === 'tender' ? '招标文件' : '投标文件'}</strong>
            <p>{activeDocumentTab === 'tender' || activeTenderSourceDocument ? '可从技术方案读取招标文件，也可以直接上传并解析成 Markdown。' : '请上传至少一份投标文件，页面会在这里展示解析后的 Markdown 正文。'}</p>
          </div>
        )}
      </section>
    </>
  );
}

export interface ItemsStepViewProps {
  activeResultTab: RejectionResultTab;
  checkRunning: boolean;
  customCheckItemsDirty: boolean;
  customCheckItemsDisabled: boolean;
  customCheckItemsDraft: string;
  customCheckItemsSaving: boolean;
  extractionRunning: boolean;
  invalidBidAndRejectionItems: RejectionExtractionState;
  prepareInvalidBidAndRejectionItems: (restart: boolean) => Promise<void>;
  resultSourceLabel: string;
  saveCustomCheckItems: () => Promise<void>;
  setActiveResultTab: (tabId: RejectionResultTab) => void;
  tenderDocument: RejectionDocumentContent | null;
  updateCustomCheckItemsDraft: (value: string) => void;
  visibleExtractionContent: string;
  visibleExtractionStatus: RejectionCheckRunStatus;
}

export function ItemsStepView({
  activeResultTab,
  checkRunning,
  customCheckItemsDirty,
  customCheckItemsDisabled,
  customCheckItemsDraft,
  customCheckItemsSaving,
  extractionRunning,
  invalidBidAndRejectionItems,
  prepareInvalidBidAndRejectionItems,
  resultSourceLabel,
  saveCustomCheckItems,
  setActiveResultTab,
  tenderDocument,
  updateCustomCheckItemsDraft,
  visibleExtractionContent,
  visibleExtractionStatus,
}: ItemsStepViewProps) {
  return (
    <>
      <section className="rejection-result-command-bar">
        <div>
          <span className="section-kicker">STEP 02</span>
          <strong>无效与废标项</strong>
          <p>先提取招标文件中的无效投标和废标项，再补充自定义检查项。</p>
        </div>
        <div className={`rejection-result-status is-${visibleExtractionStatus}`}>
          <span>{extractionStatusLabels[visibleExtractionStatus]}</span>
          <small>{resultSourceLabel}</small>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={() => void prepareInvalidBidAndRejectionItems(Boolean(visibleExtractionContent.trim()) || visibleExtractionStatus === 'error')}
          disabled={!tenderDocument || extractionRunning}
        >
          {extractionRunning ? '解析中...' : visibleExtractionContent.trim() ? '重新解析' : '开始解析'}
        </button>
      </section>

      <div className="document-switch-tabs" role="tablist" aria-label="无效与废标项内容切换">
        {resultTabs.map((tab) => {
          const isActive = tab.id === activeResultTab;
          return (
            <button
              type="button"
                className={`document-switch-tab${isActive ? ' is-active' : ''}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`rejection-result-panel-${tab.id}`}
              id={`rejection-result-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveResultTab(tab.id)}
            >
              <strong>{tab.label}</strong>
            </button>
          );
        })}
      </div>

      <section
        className="rejection-reader-card rejection-result-card analysis-markdown-card"
        role="tabpanel"
        id={`rejection-result-panel-${activeResultTab}`}
        aria-labelledby={`rejection-result-tab-${activeResultTab}`}
      >
        <div className="analysis-result-head rejection-reader-head">
          <div className="rejection-reader-heading">
            <strong>{activeResultTab === 'analysis' ? '解析结果' : '自定义检查项'}</strong>
            <span>{activeResultTab === 'analysis'
              ? `${extractionStatusLabels[visibleExtractionStatus]} · ${resultSourceLabel}`
              : customCheckItemsSaving
                ? '正在保存自定义检查项'
                : extractionRunning || checkRunning
                  ? '任务运行中暂不能修改自定义检查项，当前检查会使用启动任务时的内容'
                  : customCheckItemsDirty
                    ? '内容尚未保存，保存后才用于废标项检查'
                    : '可填写补充检查口径、人工关注项或项目经验'}</span>
          </div>
          {activeResultTab === 'custom' && (
            <div className="rejection-custom-save-actions">
              <span className={`rejection-custom-save-state${customCheckItemsDirty ? ' is-dirty' : ''}`}>
                {customCheckItemsDirty ? '有未保存修改' : '已保存'}
              </span>
              <button
                type="button"
                className="primary-action"
                onClick={() => void saveCustomCheckItems()}
                disabled={!customCheckItemsDirty || customCheckItemsDisabled}
              >
                {customCheckItemsSaving ? '保存中...' : '保存'}
              </button>
            </div>
          )}
        </div>

        {activeResultTab === 'analysis' ? (
          visibleExtractionContent.trim() ? (
            <MarkdownFullscreenViewer className="markdown-viewer rejection-markdown-viewer rejection-result-viewer" title="解析结果全屏查看">
              <MarkdownRenderer>
                {visibleExtractionContent}
              </MarkdownRenderer>
            </MarkdownFullscreenViewer>
          ) : (
            <div className="markdown-empty-state rejection-empty-reader">
              <strong>{visibleExtractionStatus === 'error' ? invalidBidAndRejectionItems.error || '解析失败' : '等待解析无效与废标项'}</strong>
              <p>{extractionRunning ? '正在提取招标文件中的无效投标、废标项和可能风险。' : '进入本步骤后会自动解析；也可以点击上方“开始解析”。'}</p>
            </div>
          )
        ) : (
          <MarkdownEditor
            className="rejection-custom-editor"
            value={customCheckItemsDraft}
            onChange={updateCustomCheckItemsDraft}
            disabled={customCheckItemsDisabled}
            placeholder="输入自定义检查项，例如：\n- 关注报价文件是否存在多处不一致\n- 关注资格证明材料有效期是否覆盖投标截止时间\n- 关注技术偏离表是否遗漏关键参数响应"
          />
        )}
      </section>
    </>
  );
}
