// 批量导出：一次性导出全部标段的 Word 文件。
//
// 用途：多标段项目（bid_section_mode = 'multiple'）交付时，避免逐标段手动导出。
// 设计：
// 1. 读取 technical_plan_meta.bid_sections_json 获取标段清单。
// 2. 逐标段调用 exportService.exportWord，串行执行避免并发冲突。
// 3. 输出到统一目录（outputDir/标段名.docx），返回逐标段结果清单。
// 4. 单标段失败不阻断其余标段，最后汇总报告。

const path = require('node:path');
const fs = require('node:fs');

/**
 * 批量导出全部标段。
 *
 * @param {{ exportService: any, technicalPlanStore: any, outputDir: string, onProgress?: (done: number, total: number, sectionName: string) => void }} deps
 * @returns {Promise<{ success: boolean, total: number, exported: number, failed: number, results: Array<{section_id: string, section_name: string, success: boolean, file?: string, message?: string}> }>}
 */
async function batchExportBidSections({ exportService, technicalPlanStore, outputDir, onProgress }) {
  const state = technicalPlanStore?.loadTechnicalPlan?.() || {};
  const sections = Array.isArray(state.bidSections) ? state.bidSections : [];
  if (!sections.length) {
    return { success: false, total: 0, exported: 0, failed: 0, results: [], message: '未识别到标段，无法批量导出' };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const results = [];
  let exported = 0;
  let failed = 0;

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const sectionName = String(section.name || section.title || `标段${index + 1}`).trim();
    const fileName = `${sectionName}.docx`;
    const filePath = path.join(outputDir, fileName);
    onProgress?.(index, sections.length, sectionName);

    try {
      // 每个标段独立导出；exportService.exportWord 接受 payload 含 selectedSectionId。
      await exportService.exportWord({
        ...state,
        selectedSectionId: section.id,
        output_path: filePath,
        skip_dialog: true,
      });
      exported += 1;
      results.push({ section_id: section.id, section_name: sectionName, success: true, file: filePath });
    } catch (error) {
      failed += 1;
      results.push({
        section_id: section.id,
        section_name: sectionName,
        success: false,
        message: String(error?.message || error || '导出失败'),
      });
    }
  }

  onProgress?.(sections.length, sections.length, '');
  return { success: failed === 0, total: sections.length, exported, failed, results };
}

module.exports = { batchExportBidSections };
