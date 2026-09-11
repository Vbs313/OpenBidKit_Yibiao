import type { Dispatch, SetStateAction } from 'react';
import type { ToastType } from '../../../shared/ui';
import { isLibreOfficeRequiredMessage } from '../../../shared/ui';
import type { RejectionCheckStep, RejectionDocumentRole } from '../../../shared/types/domains/rejection-check';
import { documentLabels, resolveImportToastType } from '../model';
import type { useRejectionWorkspace } from './useRejectionWorkspace';

export type RejectionDocumentBusyState = 'technical-plan' | 'tender-upload' | 'bid-upload' | 'remove' | null;

interface UseRejectionDocumentImportParams {
  documentsLocked: boolean;
  step: RejectionCheckStep;
  setBusy: Dispatch<SetStateAction<RejectionDocumentBusyState>>;
  setStep: (step: RejectionCheckStep) => void;
  applyWorkspaceState: ReturnType<typeof useRejectionWorkspace>['applyWorkspaceState'];
  showToast: (message: string, type?: ToastType) => void;
  showDocumentParseNotice: (message?: string) => void;
}

// 文档导入 / 移除的 IPC 出口：页面只接 handler，不直接调 window.yibiao.rejectionCheck。
export function useRejectionDocumentImport({
  documentsLocked,
  step,
  setBusy,
  setStep,
  applyWorkspaceState,
  showToast,
  showDocumentParseNotice,
}: UseRejectionDocumentImportParams) {
  const resolveDroppedFilePaths = (files: FileList) =>
    Array.from(files).map((file) => window.yibiao?.file.getPathForFile(file) || '').filter(Boolean);

  async function importParsedDocument(role: RejectionDocumentRole, filePaths?: string[]) {
    const documentLabel = documentLabels[role];
    if (documentsLocked) {
      return;
    }
    try {
      const importer = window.yibiao?.rejectionCheck.importDocument;
      if (typeof importer !== 'function') {
        throw new Error('文件解析接口尚未加载，请重启应用后重试');
      }

      setBusy(role === 'tender' ? 'tender-upload' : 'bid-upload');
      const result = await importer(role, filePaths);

      if (!result?.success) {
        const message = result?.message || `未选择${documentLabel}`;
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, resolveImportToastType(message, false));
        return;
      }

      applyWorkspaceState(await window.yibiao.rejectionCheck.loadState());
      const successMessage = result.message || `${documentLabel}已解析`;
      showToast(successMessage, resolveImportToastType(successMessage, true));
    } catch (error) {
      const message = error instanceof Error ? error.message : `${documentLabel}解析失败`;
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function readTenderFromTechnicalPlan() {
    if (documentsLocked) {
      return;
    }
    if (!window.yibiao?.rejectionCheck?.importTenderFromTechnicalPlan) {
      showToast('废标项检查缓存接口尚未加载，请重启应用后重试', 'error');
      return;
    }

    try {
      setBusy('technical-plan');
      const result = await window.yibiao.rejectionCheck.importTenderFromTechnicalPlan();
      if (!result?.success) {
        showToast(result?.message || '技术方案中暂无可读取的招标文件正文', 'info');
        return;
      }

      applyWorkspaceState(await window.yibiao.rejectionCheck.loadState());
      showToast(result.message || '已从技术方案读取招标文件', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取技术方案招标文件失败', 'error');
    } finally {
      setBusy(null);
    }
  }

  function removeDocument(role: RejectionDocumentRole, documentId?: string) {
    if (documentsLocked) {
      return;
    }
    setBusy('remove');
    void window.yibiao?.rejectionCheck.removeDocument(role, documentId)
      .then(() => window.yibiao.rejectionCheck.loadState())
      .then((state) => {
        applyWorkspaceState({ ...state, step: role === 'tender' && step === 'items' ? 'documents' : state.step });
      })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : `移除${documentLabels[role]}失败`, 'error');
      })
      .finally(() => {
        setBusy(null);
      });
  }

  return {
    resolveDroppedFilePaths,
    importParsedDocument,
    readTenderFromTechnicalPlan,
    removeDocument,
  };
}
