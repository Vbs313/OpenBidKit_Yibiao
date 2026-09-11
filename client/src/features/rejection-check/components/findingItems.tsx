// 废标项检查的展示组件：文件徽标、结论块、三类问题条目。
//
// 这些原本在 RejectionCheckPage.tsx 的模块顶层，已是「显式 props 的纯展示组件」；
// 抽到 components/ 后页面只负责编排，展示细节不再挤在同一个文件里。
import { MarkdownFullscreenViewer, MarkdownRenderer, UploadFilePill } from '../../../shared/ui';
import type {
  LogicCheckFinding,
  RejectionCheckFinding,
  RejectionDocumentContent,
  TypoCheckFinding,
} from '../../../shared/types/domains/rejection-check';
import {
  documentLabels,
  findingSeverityLabels,
  findingTypeLabels,
  formatContentLength,
  formatImportedAt,
  highlightMarkdownText,
  getFileBadge,
  sourceLabels,
} from '../model';
function DocumentFilePill({ document, onRemove, removeDisabled = false }: { document: RejectionDocumentContent; onRemove?: () => void; removeDisabled?: boolean }) {
  return (
    <UploadFilePill
      badge={getFileBadge(document)}
      name={document.fileName}
      meta={`${sourceLabels[document.source]} · ${formatContentLength(document.content)} · ${formatImportedAt(document.importedAt)}`}
      onRemove={onRemove}
      removeDisabled={removeDisabled}
      removeLabel="移除"
      removeAriaLabel={`移除${documentLabels[document.role]}`}
    />
  );
}

function FindingDetailBlock({ label, content, allowRawHtml = false }: { label: string; content: string; allowRawHtml?: boolean }) {
  return (
    <div className="rejection-finding-detail-block">
      <strong>{label}</strong>
      <MarkdownFullscreenViewer className="markdown-viewer rejection-finding-markdown" showFullscreen={false}>
        <MarkdownRenderer allowRawHtml={allowRawHtml}>
          {content || '未提供'}
        </MarkdownRenderer>
      </MarkdownFullscreenViewer>
    </div>
  );
}

function TypoOriginalBlock({ excerpt, wrongText }: { excerpt: string; wrongText: string }) {
  const highlightedContent = highlightMarkdownText(excerpt || '未提供', wrongText);

  return (
    <div className="rejection-finding-detail-block">
      <strong>原文内容</strong>
      <MarkdownFullscreenViewer className="markdown-viewer rejection-finding-markdown typo-original-excerpt" showFullscreen={false}>
        <MarkdownRenderer allowRawHtml>
          {highlightedContent}
        </MarkdownRenderer>
      </MarkdownFullscreenViewer>
    </div>
  );
}

function RejectionFindingItem({ finding, bidLabel, expanded, onToggle, onDelete }: { finding: RejectionCheckFinding; bidLabel: string; expanded: boolean; onToggle: () => void; onDelete: () => void }) {
  return (
    <article className={`rejection-finding-item is-${finding.type} is-${finding.severity}${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong>{finding.title}</strong>
              <em className="rejection-finding-file-tag">{bidLabel}</em>
              <em className={`rejection-finding-tag is-${finding.type}`}>{findingTypeLabels[finding.type]}</em>
              <em className={`rejection-finding-severity is-${finding.severity}`}>{findingSeverityLabels[finding.severity]}</em>
            </span>
            <small>{finding.summary}</small>
          </span>
        </button>
        <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.title}`}>
          删除
        </button>
      </div>

      {expanded && (
        <div className="rejection-finding-detail">
          <FindingDetailBlock label="检查依据" content={finding.requirement} allowRawHtml />
          <FindingDetailBlock label="投标文件证据" content={finding.bidEvidence} allowRawHtml />
          <FindingDetailBlock label="风险原因" content={finding.riskReason} />
          <FindingDetailBlock label="处理建议" content={finding.suggestion} />
        </div>
      )}
    </article>
  );
}

function TypoFindingItem({ finding, bidLabel, expanded, onToggle, onDelete, onCopyOriginal, onCopyWrong }: { finding: TypoCheckFinding; bidLabel: string; expanded: boolean; onToggle: () => void; onDelete: () => void; onCopyOriginal: () => void; onCopyWrong: () => void }) {
  return (
    <article className={`rejection-finding-item is-typo${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong className="typo-finding-title">
                <span>{finding.wrongText}</span>
                <i aria-hidden="true">-&gt;</i>
                <span>{finding.correctText}</span>
              </strong>
              <em className="rejection-finding-tag is-typo">错别字</em>
              <em className="rejection-finding-file-tag">{bidLabel}</em>
            </span>
            <small>{finding.reason}</small>
          </span>
        </button>
        <div className="rejection-finding-actions">
          <button type="button" className="rejection-finding-copy" onClick={onCopyWrong} aria-label={`复制错字${finding.wrongText}`}>
            复制错字
          </button>
          <button type="button" className="rejection-finding-copy" onClick={onCopyOriginal} aria-label={`复制${finding.wrongText}所在原文`}>
            复制原文
          </button>
          <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.wrongText}`}>
            删除
          </button>
        </div>
      </div>

      {expanded && (
        <div className="rejection-finding-detail typo-finding-detail">
          <TypoOriginalBlock excerpt={finding.originalExcerpt} wrongText={finding.wrongText} />
          <FindingDetailBlock label="判断原因" content={finding.reason} />
        </div>
      )}
    </article>
  );
}

function LogicFindingItem({ finding, bidLabel, expanded, onToggle, onDelete }: { finding: LogicCheckFinding; bidLabel: string; expanded: boolean; onToggle: () => void; onDelete: () => void }) {
  return (
    <article className={`rejection-finding-item is-logic${expanded ? ' is-expanded' : ''}`}>
      <div className="rejection-finding-row">
        <button
          type="button"
          className="rejection-finding-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="rejection-finding-chevron" aria-hidden="true">{expanded ? '-' : '+'}</span>
          <span className="rejection-finding-title-wrap">
            <span>
              <strong>{finding.title}</strong>
              <em className="rejection-finding-file-tag">{bidLabel}</em>
              <em className="rejection-finding-tag is-logic">逻辑谬误</em>
            </span>
            <small>{finding.locationHint}</small>
          </span>
        </button>
        <button type="button" className="rejection-finding-delete" onClick={onDelete} aria-label={`删除${finding.title}`}>
          删除
        </button>
      </div>

      {expanded && (
        <div className="rejection-finding-detail">
          <FindingDetailBlock label="原文与位置" content={`${finding.locationHint}\n\n${finding.originalText}`} allowRawHtml />
          <FindingDetailBlock label="谬误原因" content={finding.fallacyReason} />
          <FindingDetailBlock label="修改建议" content={finding.suggestion} />
        </div>
      )}
    </article>
  );
}
export {
  DocumentFilePill,
  FindingDetailBlock,
  TypoOriginalBlock,
  RejectionFindingItem,
  TypoFindingItem,
  LogicFindingItem,
};
