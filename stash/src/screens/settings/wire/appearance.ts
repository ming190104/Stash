/** 外观页签接线：主题 / 动效 / 字号 / 布局 / 竖排原名 / 音效。 */

import type { LayoutName, ThemeName } from '../../../types';
import { state } from '../../../state';
import { toast, esc, applyTheme, applyLayout, applyMotion, applyFontScale, normalizeFontScale, applyAnimSpeed, applyBootAnim } from '../../../ui';
import { applySoundSettings, sfx } from '../../../sfx';
import { openMenu } from '../../../quick';
import { renderRail } from '../../library';
import { renderGrid } from '../../grid';
import { THEME_LABEL, THEME_OPTS } from '../../settings-tabs/common';
import { persist } from '../persist';
import { rerender } from '../ui';

export function wireAppearance(body: HTMLElement): void {
  // 主题：收成一个下拉按钮，点开共用菜单再选（不再铺一排色点）
  body.querySelector('#pickTheme')?.addEventListener('click', () => {
    const cur: ThemeName = state.settings?.theme ?? 'cinema';
    void openMenu(
      '主题',
      `当前 · ${THEME_LABEL[cur] ?? THEME_LABEL.cinema}`,
      THEME_OPTS.map((t) => ({
        key: t.v,
        label: t.label,
        hint: t.v === cur ? '当前' : undefined,
        run: async () => {
          if (!state.settings) return;
          state.settings.theme = t.v;
          applyTheme(t.v);
          // 先落盘再报成功：persist() 失败时已按磁盘值把主题回滚，
          // 此时再弹「主题 · 白昼」会让人以为切换成功了
          try {
            await persist();
            toast(`主题 · ${THEME_LABEL[t.v]}`);
          } catch (err) {
            toast(esc(String((err as { message?: string })?.message ?? err)), true);
          }
          rerender();
        },
      })),
    );
  });
  // 动效强度：切 #app.motion-soft（mockup 机制真实接线）+ 落盘；系统减少动态效果时同样整档关闭
  body.querySelectorAll('#segMotion b').forEach((b) => {
    b.addEventListener('click', () => {
      state.motion = Number((b as HTMLElement).dataset.v);
      applyMotion(state.motion === 1);
      body.querySelectorAll('#segMotion b').forEach((x) => x.classList.toggle('on', x === b));
      if (state.settings) {
        state.settings.motion = state.motion;
        persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      toast(`动效强度 · ${state.motion === 1 ? '柔和' : '标准'}`);
    });
  });
  // 启动 / 全屏转场速度：只缩放这两段时长，同时写入缓存供下次冷启动在设置读盘前使用
  body.querySelectorAll('#segAnimSpeed b').forEach((b) => {
    b.addEventListener('click', () => {
      const v = applyAnimSpeed(Number((b as HTMLElement).dataset.v));
      body.querySelectorAll('#segAnimSpeed b').forEach((x) => x.classList.toggle('on', x === b));
      if (state.settings) {
        state.settings.animSpeed = v;
        persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      toast(`启动与转场速度 · ${v}×`);
    });
  });
  // 冷启动动画：写缓存供下次启动在设置读盘前选中同一档 + 落盘；本次启动已播过的不重播
  body.querySelectorAll('#segBootAnim b').forEach((b) => {
    b.addEventListener('click', () => {
      const v = applyBootAnim((b as HTMLElement).dataset.v);
      body.querySelectorAll('#segBootAnim b').forEach((x) => x.classList.toggle('on', x === b));
      if (state.settings) {
        state.settings.bootAnim = v;
        persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      toast(`启动动画 · ${v === 'core' ? '核心启动' : v === 'warp' ? '流光跃迁' : '关闭'}`);
    });
  });
  // 界面字号：写 --fs 根变量（app.css 全部 font-size 乘它）+ 落盘，版式不动
  body.querySelectorAll('#segFont b').forEach((b) => {
    b.addEventListener('click', () => {
      const v = normalizeFontScale(Number((b as HTMLElement).dataset.v));
      applyFontScale(v);
      body.querySelectorAll('#segFont b').forEach((x) => x.classList.toggle('on', x === b));
      if (state.settings) {
        state.settings.fontScale = v;
        persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
      }
      toast(`界面字号 · ${v === 0.9 ? '小' : v === 1 ? '标准' : v === 1.12 ? '大' : '特大'}`);
    });
  });
  // 布局皮肤：立即重建库屏 / 网格（CSS 与 TS 两侧都要切）+ 落盘
  body.querySelectorAll('#segLayout b').forEach((b) => {
    b.addEventListener('click', () => {
      const v = (b as HTMLElement).dataset.v as LayoutName;
      if (!state.settings) return;
      state.settings.layout = v;
      applyLayout(v);
      body.querySelectorAll('#segLayout b').forEach((x) => x.classList.toggle('on', x === b));
      renderRail();
      renderGrid();
      persist().catch((err) => {
        toast(esc(String((err as { message?: string })?.message ?? err)), true);
        rerender();
      });
      toast(`布局 · ${v === 'list' ? '列表' : v === 'wall' ? '海报墙' : '经典'}`);
    });
  });
  // 竖排原名（落盘）
  body.querySelector('#tgVt')?.addEventListener('click', (e) => {
    state.verticalTitle = !state.verticalTitle;
    (e.currentTarget as HTMLElement).classList.toggle('on', state.verticalTitle);
    renderRail();
    renderGrid();
    if (state.settings) {
      state.settings.verticalTitle = state.verticalTitle;
      persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
    }
    toast(`竖排原文名 · ${state.verticalTitle ? '开' : '关'}`);
  });
  // 交互音效：开关即时生效（关闭后立刻静音）；打开时播一声确认，让用户马上听到效果
  body.querySelector('#tgSound')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = !state.settings.sound.enabled;
    state.settings.sound.enabled = on;
    applySoundSettings(state.settings);
    (e.currentTarget as HTMLElement).classList.toggle('on', on);
    sfx.toggle(on);
    persist()
      .then(() => toast(`交互音效 · ${on ? '开' : '关'}`))
      .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
  });
  // 音效音量：三档，改完播一声让用户听到当前档位
  body.querySelectorAll('#segSound b').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.settings) return;
      const v = Math.min(1, Math.max(0, Number((b as HTMLElement).dataset.v)));
      state.settings.sound.gain = v;
      applySoundSettings(state.settings);
      body.querySelectorAll('#segSound b').forEach((x) => x.classList.toggle('on', x === b));
      sfx.confirm();
      persist()
        .then(() => toast(`音效音量 · ${v <= 0.4 ? '小' : v >= 0.8 ? '大' : '中'}`))
        .catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
    });
  });
}
