import { useCallback, useRef, useState } from 'react';
import type { SettingsPageRequest, SettingsTab } from '../features/settings/types';
import type { SectionId } from '../shared/types/navigation';

/**
 * 设置页分类深链：任何地方需要「请先在设置中填写 X」时，调用 openSettings('components') 等
 * 直接跳到对应分类，而不是让用户自己找。
 *
 * 吸收自上游 useTextModelSetupRedirect 的 SettingsPageRequest 模式，但去掉官方账户/充值耦合，改为通用。
 */
export function useSettingsRedirect(requestSectionChange: (section: SectionId) => Promise<boolean> | void) {
  const [settingsRequest, setSettingsRequest] = useState<SettingsPageRequest | null>(null);
  const pendingRef = useRef<SettingsPageRequest | null>(null);

  /** 跳转到设置页指定分类。若被离开守卫拦截则撤回请求。 */
  const openSettings = useCallback((tab: SettingsTab) => {
    const request: SettingsPageRequest = { tab };
    pendingRef.current = request;
    setSettingsRequest(request);
    void Promise.resolve(requestSectionChange('settings')).then((allowed) => {
      if (allowed === false && pendingRef.current === request) {
        pendingRef.current = null;
        setSettingsRequest(null);
      }
    });
  }, [requestSectionChange]);

  /** 设置页消费后清除请求。 */
  const clearSettingsRequest = useCallback(() => {
    pendingRef.current = null;
    setSettingsRequest(null);
  }, []);

  return { settingsRequest, openSettings, clearSettingsRequest };
}
