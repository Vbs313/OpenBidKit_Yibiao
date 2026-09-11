import type { OutlineExpansionMode } from '../../shared/types';

// 目录补充方式的展示名：页面顶栏与生成配置弹窗共用，避免两处文案漂移。
export const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
