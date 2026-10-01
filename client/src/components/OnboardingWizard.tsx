import { useEffect, useState } from 'react';
import { AppDialog, AppSwitch, useToast } from '../shared/ui';

const ONBOARDING_STORAGE_KEY = 'sjjt-onboarding-completed';

interface OnboardingStep {
  title: string;
  description: string;
}

const STEPS: OnboardingStep[] = [
  {
    title: '配置文本模型',
    description: '首先需要配置文本模型（API Key、Base URL、模型名称），用于标书分析与正文生成。',
  },
  {
    title: '验证模型可用性',
    description: '配置完成后点击「测试连接」，确认模型可正常调用。若失败请检查 API Key 或网络。',
  },
  {
    title: '导入招标文件',
    description: '进入「技术方案」或「商务标」，导入招标文件即可开始标书编制。系统会自动解析采购方式与评分办法。',
  },
];

function isCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

function markCompleted(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
  } catch {
    // localStorage 不可用时静默降级，下次启动再次显示。
  }
}

/**
 * 首次启动引导：3 步配置向导，帮助新用户快速上手。
 * 完成后写 localStorage 标记，不再显示；可在设置页手动重置。
 */
export default function OnboardingWizard({ onNavigateToSettings }: { onNavigateToSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    if (!isCompleted()) setOpen(true);
  }, []);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      markCompleted();
      setOpen(false);
      showToast('引导完成，祝您使用愉快', 'success');
    }
  };

  const handleSkip = () => {
    markCompleted();
    setOpen(false);
  };

  const handleGoSettings = () => {
    markCompleted();
    setOpen(false);
    onNavigateToSettings();
  };

  if (!open) return null;

  const current = STEPS[step];
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) handleSkip(); }}
      title="欢迎使用数据集团工具箱"
      actions={
        <>
          <button type="button" className="secondary-action" onClick={handleSkip}>
            跳过引导
          </button>
          {step === 0 ? (
            <button type="button" className="primary-action" onClick={handleGoSettings}>
              去配置模型
            </button>
          ) : (
            <button type="button" className="primary-action" onClick={handleNext}>
              {step === STEPS.length - 1 ? '完成' : '下一步'}
            </button>
          )}
        </>
      }
    >
      <div className="onboarding-wizard">
        <div className="onboarding-progress">
          {STEPS.map((_, index) => (
            <span key={index} className={`onboarding-dot${index === step ? ' is-active' : index < step ? ' is-done' : ''}`} />
          ))}
        </div>
        <h3>{current.title}</h3>
        <p>{current.description}</p>
        {step === STEPS.length - 1 && (
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              void window.yibiao?.file.getSampleTender().then((result) => {
                if (result?.success) {
                  showToast(`已加载示例招标文件（${result.content.length} 字），可直接体验完整流程`, 'success');
                } else {
                  showToast(result?.message || '加载示例失败', 'error');
                }
              });
            }}
          >
            一键加载示例招标文件
          </button>
        )}
        <p className="onboarding-hint">
          第 {step + 1} / {STEPS.length} 步
        </p>
      </div>
    </AppDialog>
  );
}
