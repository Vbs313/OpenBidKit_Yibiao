// 检查配置弹窗：废标项 / 错别字 / 逻辑谬误三项开关 + 保存并开始检查。
//
// 从 RejectionCheckPage 的结果面板里整段搬出来（JSX 逐字，仅去掉外层缩进）。

import * as Dialog from '@radix-ui/react-dialog';
import { AppSwitch } from '../../../shared/ui';
import type {
  RejectionCheckOptions,
  RejectionCheckRunStatus,
  RejectionDocumentContent,
} from '../../../shared/types/domains/rejection-check';

export interface CheckConfigDialogProps {
  checkConfigDialogOpen: boolean;
  setCheckConfigDialogOpen: (open: boolean) => void;
  draftCheckOptions: RejectionCheckOptions;
  setDraftCheckOptions: (updater: (prev: RejectionCheckOptions) => RejectionCheckOptions) => void;
  checkRunning: boolean;
  extractionRunning: boolean;
  bidDocuments: RejectionDocumentContent[];
  visibleExtractionStatus: RejectionCheckRunStatus;
  currentRejectionCheckInputSignature: string;
  checkActionLabel: string;
  saveCheckOptions: () => void;
  startCheckWithOptions: () => void;
}

export function CheckConfigDialog({
  checkConfigDialogOpen,
  setCheckConfigDialogOpen,
  draftCheckOptions,
  setDraftCheckOptions,
  checkRunning,
  extractionRunning,
  bidDocuments,
  visibleExtractionStatus,
  currentRejectionCheckInputSignature,
  checkActionLabel,
  saveCheckOptions,
  startCheckWithOptions,
}: CheckConfigDialogProps) {
  return (
    <Dialog.Root open={checkConfigDialogOpen} onOpenChange={setCheckConfigDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="content-generation-config-card rejection-check-config-card">
          <div className="content-regenerate-card-head">
            <span className="section-kicker">检查配置</span>
            <Dialog.Title>检查结果配置</Dialog.Title>
          </div>

          <div className="content-generation-config-list">
            <label className="content-generation-config-row">
              <span>
                <strong>废标项检查</strong>
                <small>基于招标文件无效与废标项检查投标文件响应风险，默认必选。</small>
              </span>
              <AppSwitch checked disabled aria-label="废标项检查" />
            </label>
            <label className="content-generation-config-row">
              <span>
                <strong>错别字检查</strong>
                <small>检查投标文件中的错别字、明显别字和文字疏漏。</small>
              </span>
              <AppSwitch
                checked={draftCheckOptions.typoCheck}
                onCheckedChange={(checked) => setDraftCheckOptions((prev) => ({ ...prev, typoCheck: checked }))}
                aria-label="错别字检查" />
            </label>
            <label className="content-generation-config-row">
              <span>
                <strong>逻辑谬误检查</strong>
                <small>检查前后矛盾、逻辑不一致和表述漏洞。</small>
              </span>
              <AppSwitch
                checked={draftCheckOptions.logicCheck}
                onCheckedChange={(checked) => setDraftCheckOptions((prev) => ({ ...prev, logicCheck: checked }))}
                aria-label="逻辑谬误检查" />
            </label>
          </div>

          <div className="content-regenerate-actions">
            <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
            <button type="button" className="secondary-action" onClick={saveCheckOptions}>
              保存配置
            </button>
            <button type="button" className="primary-action" onClick={startCheckWithOptions} disabled={checkRunning || extractionRunning || !bidDocuments.length || (draftCheckOptions.rejectionCheck && (visibleExtractionStatus !== 'success' || !currentRejectionCheckInputSignature))}>
              {checkActionLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
