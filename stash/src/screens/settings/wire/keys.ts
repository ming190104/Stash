/** 键位映射页签接线：手柄改键捕获 / 恢复默认 / 手感 / A-B 互换 / 手柄映射鼠标。 */

import type { PadMap, PadTuning } from '../../../types';
import { state } from '../../../state';
import { toast, esc } from '../../../ui';
import { refreshPadHints } from '../../../keybar';
import { PAD_DEFAULT, PAD_TUNING_DEFAULT, dedupePadMap } from '../../../padmap';
import { promptConfirm } from '../../../prompt';
import { persist } from '../../../settings-persist';
import { sui, rerender, setCapturePad } from '../ui';

/** 手感字段 → 中文名，只用于 toast。 */
const TUNE_LABEL: Record<string, string> = {
  deadzone: '摇杆死区',
  repeatMs: '方向重复率',
  mouseSpeed: '鼠标速度',
};

/** 旧配置没有 padTuning：首次改动时先补默认值，避免写到 undefined 上。 */
function tuning(): PadTuning {
  const s = state.settings;
  if (!s) throw new Error('settings not ready');
  s.padTuning = { ...PAD_TUNING_DEFAULT, ...s.padTuning };
  return s.padTuning;
}

export function wireKeys(body: HTMLElement): void {
  // 手柄手感：分段选择器都是数字档位，改完直接落盘；Rust 每帧读一次，下一帧生效
  body.querySelectorAll<HTMLElement>('[data-tuning]').forEach((seg) => {
    const key = seg.dataset.tuning as keyof PadTuning;
    seg.querySelectorAll<HTMLElement>('b[data-v]').forEach((b) => {
      b.addEventListener('click', () => {
        const raw = b.dataset.v;
        if (!state.settings || !raw) return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        (tuning() as unknown as Record<string, number>)[key] = value;
        seg.querySelectorAll('b').forEach((x) => x.classList.toggle('on', x === b));
        persist().catch((err) =>
          toast(esc(String((err as { message?: string })?.message ?? err)), true),
        );
        toast(`${TUNE_LABEL[key] ?? '手柄手感'} · ${b.textContent?.trim() ?? ''}`);
      });
    });
  });
  // P3 · 手柄映射鼠标：落盘即可，下一次启动游戏时由 Rust 侧接管
  body.querySelector('#tgPadMouse')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = !state.settings.gamepadMouse;
    state.settings.gamepadMouse = on;
    (e.currentTarget as HTMLElement).classList.toggle('on', on);
    persist().catch((err) => toast(esc(String((err as { message?: string })?.message ?? err)), true));
    toast(`手柄映射鼠标 · ${on ? '开（游戏运行时生效）' : '关'}`);
  });
  // P3 · A/B 互换（Nintendo 布局）：就是键位表里确认 / 返回两行的快捷方式，
  // 直接改写 padMap 再落盘——单一真相，避免开关与实际键位打架
  body.querySelector('#tgAbSwap')?.addEventListener('click', (e) => {
    if (!state.settings) return;
    const on = !state.settings.abSwap;
    state.settings.abSwap = on;
    // 与捕获同一套撞键规则：互换成对改写 accept / back 后统一去重，
    // 避免 random 恰好占着其中一颗键时一键触发两个动作（如 back 与 random 同为 south）
    state.settings.padMap = dedupePadMap({
      ...(state.settings.padMap ?? PAD_DEFAULT),
      accept: on ? 'east' : 'south',
      back: on ? 'south' : 'east',
    });
    (e.currentTarget as HTMLElement).classList.toggle('on', on);
    persist()
      .then(() => {
        refreshPadHints();
        rerender();
      })
      .catch((err) => {
        toast(esc(String((err as { message?: string })?.message ?? err)), true);
        rerender();
      });
    toast(`A/B 键互换 · ${on ? '开（东侧键确认）' : '关（南侧键确认）'}`);
  });
  // P5 · 手柄键位：点一行进入改键态，下一次物理按键（pad://button）落到这一行
  body.querySelectorAll<HTMLElement>('#padMapRows .pmrow').forEach((el) => {
    el.addEventListener('click', () => {
      sui.captureAt = Date.now() + 400;
      const seq = ++sui.captureSeq;
      setCapturePad(el.dataset.pad as keyof PadMap);
      rerender();
      toast('按下想绑定的手柄键…');
      // 10 秒没按键就自动退出，避免没接手柄时这一行一直挂着「按手柄按键…」
      const mark = sui.capturePad;
      window.setTimeout(() => {
        // 同一行连点两次会再开一个会话：旧定时器只认自己那一轮（seq），不能把新会话一起清掉
        if (sui.captureSeq === seq && sui.capturePad === mark) {
          setCapturePad(null);
          rerender();
        }
      }, 10000);
    });
  });
  body.querySelector('#padReset')?.addEventListener('click', async () => {
    if (!state.settings) return;
    // 一次 A 就清空太危险：先二次确认，B / Esc 取消时什么都不改
    const ok = await promptConfirm({
      title: '恢复默认键位？',
      sub: '只重置手柄键位，A/B 互换保持当前设置',
    });
    if (!ok || !state.settings) return;
    // A/B 互换是独立开关：重置键位时必须保持当前方向，不能让两者互相覆盖
    const keepSwap = state.settings.abSwap;
    const base = { ...PAD_DEFAULT };
    state.settings.padMap = keepSwap ? { ...base, accept: 'east', back: 'south' } : base;
    setCapturePad(null);
    persist()
      .then(() => {
        refreshPadHints();
        rerender();
        toast('手柄键位已恢复默认');
      })
      .catch((err) => {
        toast(esc(String((err as { message?: string })?.message ?? err)), true);
        rerender();
      });
  });
}
