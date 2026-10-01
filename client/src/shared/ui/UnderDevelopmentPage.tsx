import EmptyState from './EmptyState';

export interface UnderDevelopmentPageProps {
  /** 功能名，如「AI 评标」 */
  title: string;
  /** 计划说明：这个功能上线后会做什么 */
  description?: string;
}

/**
 * 统一「正在开发中」占位页：复用 demo-coming-page / feature-under-development-overlay 视觉。
 *
 * 用于菜单中已登记但尚未交付的功能入口（如 AI 评标、图片知识库），
 * 避免用户点进去落到空白页（AppRouter default: return null）。
 */
export default function UnderDevelopmentPage({ title, description }: UnderDevelopmentPageProps) {
  return (
    <div className="demo-coming-page" role="status" aria-live="polite">
      <div className="feature-under-development-overlay">
        <strong>正在开发中，敬请期待</strong>
        <span>{title}尚未完成，请先不要使用。</span>
      </div>
      <section className="panel" style={{ padding: 28 }}>
        <span className="section-kicker">{title}</span>
        <h2 style={{ margin: '8px 0 12px' }}>{title}</h2>
        <p style={{ color: 'var(--yb-text-muted)', lineHeight: 1.8 }}>
          {description ?? '此功能已在规划中，尚未交付。欢迎在内网需求池提出场景与优先级。'}
        </p>
      </section>
    </div>
  );
}

/**
 * 路由兜底空态：当 SectionId 没有对应页面时给出明确反馈，而不是空白页。
 */
export function RouteNotFound({ section }: { section: string }) {
  return (
    <div className="page-stack" style={{ padding: 28 }}>
      <EmptyState
        title="页面未就绪"
        hint={`当前入口「${section}」还没有对应的页面。请从左侧菜单选择其他功能。`}
      />
    </div>
  );
}
