import type { AgentModeScenariosConfig, ComponentsConfig, ImageModelConfig, ImageModelProfiles, TextModelConfig, TextModelProfiles, TextModelProvider } from '../../shared/types';

export type SettingsTab = 'general' | 'text-model' | 'image-model' | 'components' | 'agent' | 'about';

/** 应用级跳转传给设置页的一次性请求，设置页消费后由应用清除。
 *  用于「请先在设置中填写 X」类提示直达对应分类，而不是让用户自己找。 */
export interface SettingsPageRequest {
  tab: SettingsTab;
}

export interface SettingsPageState {
  textModel: Omit<TextModelConfig, 'context_length_limit' | 'concurrency_limit'> & {
    context_length_limit: number | '';
    concurrency_limit: number | '';
    provider: TextModelProvider;
  };
  textModelProfiles: TextModelProfiles;
  imageModel: Omit<ImageModelConfig, 'concurrency_limit'> & {
    concurrency_limit: number | '';
  };
  imageModelProfiles: ImageModelProfiles;
  components: Omit<ComponentsConfig, 'mermaid_concurrency_limit' | 'html_concurrency_limit'> & {
    mermaid_concurrency_limit: number | '';
    html_concurrency_limit: number | '';
  };
  agentModeScenarios: AgentModeScenariosConfig;
  general: {
    developer_mode: boolean;
    developer_token_stats_auto_open: boolean;
    developer_agent_monitor_auto_open: boolean;
    gpu_hardware_acceleration_enabled: boolean;
    gpu_hardware_acceleration_configured: boolean;
  };
}

export type AgentSelfCheckUiStatus = 'untested' | 'checking' | 'normal' | 'busy' | 'error';
