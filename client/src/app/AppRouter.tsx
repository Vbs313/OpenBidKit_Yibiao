import { useEffect, useState } from 'react';
import type { SectionId } from '../shared/types/navigation';
import { getAppMenuItemById } from './menuConfig';
import BidOpportunityPage from '../features/bid-opportunity/pages/BidOpportunityPage';
import BusinessBidPage from '../features/business-bid/pages/BusinessBidPage';
import ContentExpansionReplaceTestPage from '../features/developer/pages/ContentExpansionReplaceTestPage';
import DeveloperDemoPage, { isDeveloperDemoSection } from '../features/developer/pages/DeveloperDemoPage';
import DeveloperMultimodalTestPage from '../features/developer/pages/DeveloperMultimodalTestPage';
import AgentTestPage from '../features/developer/pages/AgentTestPage';
import DeveloperTestPage from '../features/developer/pages/DeveloperTestPage';
import ExportFormatPage from '../features/export-format/pages/ExportFormatPage';
import MyTemplatesPage from '../features/export-format/pages/MyTemplatesPage';
import DuplicateCheckPage from '../features/duplicate-check/pages/DuplicateCheckPage';
import KnowledgeBasePage from '../features/knowledge-base/pages/KnowledgeBasePage';
import CredentialLibraryPage from '../features/credential-library/pages/CredentialLibraryPage';
import RejectionCheckPage from '../features/rejection-check/pages/RejectionCheckPage';
import ComplianceCheckPage from '../features/compliance-check/pages/ComplianceCheckPage';
import ResourcesPage from '../features/resources/pages/ResourcesPage';
import PluginsPage from '../features/plugins/pages/PluginsPage';
import SettingsPage from '../features/settings/pages/SettingsPage';
import TechnicalPlanHome from '../features/technical-plan/pages/TechnicalPlanHome';
import FeasibilityReportHome from '../features/feasibility-report/pages/FeasibilityReportHome';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';
import { RouteNotFound, UnderDevelopmentPage } from '../shared/ui';
import type { SettingsPageRequest } from '../features/settings/types';

interface AppRouterProps {
  activeSection: SectionId;
  developerMode: boolean;
  onDeveloperModeChange: (developerMode: boolean) => void;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  /** 应用级一次性设置页跳转请求（打开指定分类）。 */
  settingsRequest?: SettingsPageRequest | null;
  onSettingsRequestHandled?: () => void;
}

function AppRouter({ activeSection, developerMode, onDeveloperModeChange, onSectionChange, registerLeaveGuard, settingsRequest, onSettingsRequestHandled }: AppRouterProps) {
  const activeMenuItem = getAppMenuItemById(activeSection, developerMode);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (activeSection !== 'my-templates') {
      setEditingTemplateId(null);
    }
  }, [activeSection]);

  if (activeMenuItem?.children?.length) {
    return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
  }

  if (isDeveloperDemoSection(activeSection)) {
    return <DeveloperDemoPage sectionId={activeSection} />;
  }

  switch (activeSection) {
    case 'technical-plan':
      return <TechnicalPlanHome workflowKind="technical-plan" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'existing-plan-expansion':
      return <TechnicalPlanHome workflowKind="existing-plan-expansion" registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'feasibility-report':
      return <FeasibilityReportHome registerLeaveGuard={registerLeaveGuard} onSectionChange={onSectionChange} />;
    case 'business-bid':
      return <BusinessBidPage />;
    case 'document-knowledge-base':
      return <KnowledgeBasePage />;
    case 'credential-library':
      return <CredentialLibraryPage developerMode={developerMode} />;
    case 'resources':
      return <ResourcesPage />;
    case 'plugin-manager':
      return <PluginsPage />;
    case 'duplicate-check':
      return <DuplicateCheckPage />;
    case 'rejection-check':
      return <RejectionCheckPage />;
    case 'compliance-check':
      return <ComplianceCheckPage />;
    case 'my-templates':
      return editingTemplateId
        ? <ExportFormatPage mode="edit" templateId={editingTemplateId} onBack={() => setEditingTemplateId(null)} />
        : <MyTemplatesPage onCreateTemplate={() => onSectionChange('new-template')} onEditTemplate={setEditingTemplateId} />;
    case 'new-template':
      return <ExportFormatPage mode="create" />;
    case 'export-format':
      return <ExportFormatPage mode="create" />;
    case 'bid-opportunity':
      return <BidOpportunityPage />;
    case 'ai-evaluation':
      return <UnderDevelopmentPage title="AI 评标" description="模拟 AI 评标，对投标文件进行打分并出具评标报告。" />;
    case 'image-knowledge-base':
      return <UnderDevelopmentPage title="图片知识库" description="管理图片素材、图示和视觉参考资料。" />;
    case 'developer-test':
      return null;
    case 'developer-json-test':
      return <DeveloperTestPage />;
    case 'developer-multimodal-test':
      return <DeveloperMultimodalTestPage />;
    case 'developer-expansion-replace-test':
      return <ContentExpansionReplaceTestPage />;
    case 'developer-agent-test':
      return <AgentTestPage />;
    case 'settings':
      return <SettingsPage onDeveloperModeChange={onDeveloperModeChange} request={settingsRequest} onRequestHandled={onSettingsRequestHandled} />;
    default:
      // 兜底：未在 switch 中登记的 SectionId 不再返回空白页，给出明确反馈。
      return <RouteNotFound section={activeSection} />;
  }
}

export default AppRouter;
