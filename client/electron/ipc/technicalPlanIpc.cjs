const { ipcMain, shell } = require('electron');
const { previewContentSection } = require('../services/contentGenerationOutput.cjs');

function registerTechnicalPlanIpc({ technicalPlanStore, taskService, openXmlHelperService }) {
  ipcMain.handle('technical-plan:load-state', () => technicalPlanStore.loadTechnicalPlan());
  // v29 审批流：更新审批状态。
  ipcMain.handle('technical-plan:save-approval', (_event, payload) => technicalPlanStore.saveApprovalStatus(payload));
  ipcMain.handle('technical-plan:preview-content-word', (_event, sectionId) => previewContentSection({
    sectionId,
    technicalPlanStore,
    openXmlHelperService,
    exportFormat: technicalPlanStore.loadExportFormat?.() || technicalPlanStore.getActiveExportFormat?.() || undefined,
  }));
  ipcMain.handle('technical-plan:import-tender-document', (_event, filePaths, options) => taskService.importTenderDocument(filePaths, options));
  ipcMain.handle('technical-plan:remove-tender-document', (_event, sourceId) => taskService.removeTenderDocument(sourceId));
  ipcMain.handle('technical-plan:import-original-plan-document', (_event, filePaths, options) => taskService.importOriginalPlanDocument(filePaths, options));
  ipcMain.handle('technical-plan:check-bid-sections', () => technicalPlanStore.checkBidSections());
  ipcMain.handle('technical-plan:select-bid-section', (_event, selectedSection) => technicalPlanStore.selectBidSection(selectedSection));
  ipcMain.handle('technical-plan:read-tender-markdown', () => technicalPlanStore.readTenderMarkdown());
  ipcMain.handle('technical-plan:read-tender-source-markdown', (_event, sourceId) => technicalPlanStore.readTenderSourceMarkdown(sourceId));
  ipcMain.handle('technical-plan:read-original-plan-markdown', () => technicalPlanStore.readOriginalPlanMarkdown());
  ipcMain.handle('technical-plan:update-step', (_event, step) => technicalPlanStore.updateStep(step));
  ipcMain.handle('technical-plan:set-workflow-kind', (_event, workflowKind) => technicalPlanStore.setWorkflowKind(workflowKind));
  ipcMain.handle('technical-plan:switch-workflow-kind', (_event, workflowKind) => technicalPlanStore.switchWorkflowKind(workflowKind));
  ipcMain.handle('technical-plan:save-bid-analysis-config', (_event, payload) => technicalPlanStore.saveBidAnalysisConfig(payload));
  ipcMain.handle('technical-plan:save-outline-config', (_event, payload) => technicalPlanStore.saveOutlineConfig(payload));
  ipcMain.handle('technical-plan:save-outline-selection', (_event, payload) => technicalPlanStore.saveOutlineSelection(payload));
  ipcMain.handle('technical-plan:save-outline', (_event, outlineData) => technicalPlanStore.saveOutline(outlineData));
  ipcMain.handle('technical-plan:save-global-facts-config', (_event, payload) => technicalPlanStore.saveGlobalFactsConfig(payload));
  ipcMain.handle('technical-plan:save-global-facts', (_event, globalFacts) => technicalPlanStore.saveGlobalFacts(globalFacts));
  ipcMain.handle('technical-plan:save-content-generation-options', (_event, options) => technicalPlanStore.saveContentGenerationOptions(options));
  ipcMain.handle('technical-plan:save-chapter-content', (_event, payload) => technicalPlanStore.saveChapterContent(payload));
  ipcMain.handle('technical-plan:clear', () => taskService.resetTechnicalPlan());
  ipcMain.handle('technical-plan:open-bid-template', async () => {
    const filePath = technicalPlanStore.getBidTemplatePath?.();
    if (!filePath || !technicalPlanStore.hasBidTemplate?.()) {
      return { success: false, message: '还没有投标模版，请先确认一级目录' };
    }
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) {
      return { success: false, message: errorMessage };
    }
    return { success: true };
  });
}

module.exports = {
  registerTechnicalPlanIpc,
};
