/** 键位映射页签：手柄信息 + 按键测试 + 手柄键位表（改键 / 恢复默认）+ 手感 + A/B 互换 + 手柄映射鼠标。
 *  游戏内截图也走手柄键位（默认 Select），不再注册系统级键盘热键。 */
import type { PadMap, Settings } from '../../types';
import { state } from '../../state';
import { esc } from '../../ui';
import { PAD_TUNING_DEFAULT } from '../../padmap';
import { padRowsHTML, tuneSegHTML } from './common';

const LAYOUT_LABEL: Record<string, string> = {
  xbox: 'Xbox',
  playstation: 'PlayStation',
  nintendo: 'Nintendo',
};

/** 手感档位：值必须与 normalizePadTuning 的收敛范围兼容。 */
const DEADZONE_OPTS = [
  { v: '0.18', label: '灵敏' },
  { v: '0.28', label: '标准' },
  { v: '0.38', label: '防漂移' },
];
const REPEAT_OPTS = [
  { v: '120', label: '慢' },
  { v: '60', label: '标准' },
  { v: '40', label: '快' },
];
const SPEED_OPTS = [
  { v: '6', label: '慢' },
  { v: '11', label: '标准' },
  { v: '18', label: '快' },
];
/** 0.28 / 0.70 / 1 这类浮点直接 String 会带上多余小数，统一收一下。 */
function num(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** 后端电量文本 → 人话；未知就直说未知，不编造百分比。 */
function powerLabel(power: string): string {
  if (power === 'wired') return '有线';
  if (power === 'charged') return '已充满';
  if (power.startsWith('charging:')) return `充电 ${power.slice(9)}%`;
  if (power.startsWith('discharging:')) return `电量 ${power.slice(12)}%`;
  return '电量未知';
}

export function keysHTML(s: Settings, captureKey: keyof PadMap | null): string {
  const info = state.padInfo;
  const name = info.name || '未连接';
  const meta = `${LAYOUT_LABEL[info.kind] ?? 'Xbox'} · ${powerLabel(info.power)}${info.ff ? ' · 力反馈' : ''}`;
  const t = s.padTuning ?? PAD_TUNING_DEFAULT;
  return `
    <h2 class="sh">键位映射</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>手柄信息</b><span>${esc(name)}</span></div>
        <div class="pmkey" id="padInfoMeta">${esc(meta)}</div></div>
      <div class="srow"><div class="lab"><b>按键测试</b><span>按任意手柄键，这里显示被识别到的物理键</span></div>
        <div class="pmkey" id="padTest">—</div></div>
      <div class="srow"><div class="lab"><b>手柄键位</b><span>按 A 进入改键，再按想绑定的手柄键 · 与其它动作撞键自动对调 · 方向键与摇杆固定不参与</span></div>
        <span class="mini" id="padReset" data-danger="1">恢复默认键位</span></div>
      <div class="padmap" id="padMapRows">${padRowsHTML(s, captureKey, state.padKind)}</div>
      <div class="srow"><div class="lab"><b>手柄手感</b><span>改完立刻生效 · 只影响手柄操作，不改游戏键位</span></div></div>
      <div class="srow"><div class="lab"><b>摇杆死区</b><span>摇杆漂移时调大；越小越灵敏</span></div>
        ${tuneSegHTML('tgDeadzone', DEADZONE_OPTS, num(t.deadzone), 'deadzone')}</div>
      <div class="srow"><div class="lab"><b>方向重复率</b><span>按住方向时走一格的间隔；容易误触的手柄建议调慢</span></div>
        ${tuneSegHTML('tgRepeat', REPEAT_OPTS, num(t.repeatMs), 'repeatMs')}</div>
      <div class="srow"><div class="lab"><b>鼠标速度</b><span>手柄映射鼠标时，左摇杆推满的光标速度</span></div>
        ${tuneSegHTML('tgMouseSpeed', SPEED_OPTS, num(t.mouseSpeed), 'mouseSpeed')}</div>
      <div class="srow"><div class="lab"><b>A/B 键互换</b><span>Nintendo 布局：东侧键为确认、南侧键为返回（与 Xbox 布局相反）</span></div>
        <button class="tg${s.abSwap ? ' on' : ''}" id="tgAbSwap"></button></div>
      <div class="srow"><div class="lab"><b>手柄映射鼠标</b><span>游戏运行时左摇杆移光标 · A 左键 · B 右键 · 右摇杆滚轮</span></div>
        <button class="tg${s.gamepadMouse ? ' on' : ''}" id="tgPadMouse"></button></div>
      <p class="snote">若游戏以管理员权限运行，Windows 会拒绝模拟输入。请以相同权限启动游戏，或退出转区 / 加速工具后重试。</p>
    </div>`;
}
