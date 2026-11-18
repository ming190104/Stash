/** 网络页签接线：元数据开关 / 代理 / 萌娘百科兜底 / SteamGridDB Key。 */

import { state } from '../../../state';
import { toast, toastNow, esc } from '../../../ui';
import { persist } from '../persist';

export function wireNetwork(body: HTMLElement): void {
  // 在线元数据开关（落盘到 settings.network.metadataEnabled）
  body.querySelector('#tgNet')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    state.settings.network.metadataEnabled = !state.settings.network.metadataEnabled;
    (e.currentTarget as HTMLElement).classList.toggle('on', state.settings.network.metadataEnabled);
    persist()
      .then(() => toastNow(`在线元数据 · ${state.settings!.network.metadataEnabled ? '已开启' : '已关闭'}`))
      .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
  });
  // 图片备用源凭据：留空即静默跳过，不会拖慢主链路
  const netField = (sel: string, key: 'sgdbKey', label: string) => {
    body.querySelector(sel)?.addEventListener('change', (e) => {
      if (!state.settings) return;
      const v = (e.target as HTMLInputElement).value.trim();
      state.settings.network[key] = v ? v : null;
      persist()
        .then(() => toast(v ? `${label} 已保存（仅存本机）` : `已清空 ${label}`))
        .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
    });
  };
  netField('#inpSgdb', 'sgdbKey', 'SteamGridDB Key');
  // Bangumi 召回不足时用萌娘百科兜底
  body.querySelector('#tgMoegirl')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = state.settings.network.moegirlFallback === false;
    state.settings.network.moegirlFallback = on;
    (e.currentTarget as HTMLElement).classList.toggle('on', on);
    persist()
      .then(() => toastNow(`萌娘百科兜底 · ${on ? '开' : '关'}`))
      .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
  });
}
