/** 启动动画 · EVA 起动序列的舞台结构与遥测。
 *  结构与 design/launch-eva.html 的舞台一致；三套配色只换机号与分身层，
 *  动画时间轴写在 styles/eva.css 里，音效写在 boot-sfx.ts 里。 */

export type EvaPal = '01' | 'aska' | 'nerv' | '00';

interface EvaUnit {
  unit: string;
  code: string;
  ghost: string;
  children: string;
}

const UNIT: Record<EvaPal, EvaUnit> = {
  '01': { unit: '初号機 起動準備', code: 'UNIT-01 / STANDBY', ghost: '01', children: 'FIRST CHILDREN' },
  aska: { unit: '弐号機 起動準備', code: 'UNIT-02 / STANDBY', ghost: '02', children: 'SECOND CHILDREN' },
  nerv: { unit: '初号機 起動準備', code: 'UNIT-01 / STANDBY', ghost: '01', children: 'FIRST CHILDREN' },
  '00': { unit: '零号機 起動準備', code: 'UNIT-00 / STANDBY', ghost: '00', children: 'FIRST CHILDREN' },
};

/** 三贤者面板：零号机换成 LCL / 生体リンク / パターン（设计稿同款遥测） */
function magiCols(ghost: string): string {
  const cols: [string, string][] = ghost === '00'
    ? [['LCL PRESSURE', '01'], ['BIO-LINK', '02'], ['PATTERN', '03']]
    : [['MELCHIOR', '01'], ['BALTHASAR', '02'], ['CASPER', '03']];
  return cols.map(([em, b]) => `<div class="col"><em>${em}</em><b>${b}</b><i></i></div>`).join('');
}

const STAGE = (u: EvaUnit): string => `
  <div class="ev-bg"></div>
  <div class="ev-grid"></div>
  <div class="ev-ghost">${u.ghost}</div>

  <div class="ev-circuit" aria-hidden="true">
    <svg viewBox="0 0 1280 720" preserveAspectRatio="none">
      <path pathLength="100" d="M-10 470 H 150 L 190 430 H 300" />
      <path pathLength="100" d="M1290 186 H 1128 L 1088 226 H 1000" />
      <path pathLength="100" d="M116 730 V 642 L 164 596 H 306" />
      <path pathLength="100" d="M1120 -10 V 118 L 1076 162 H 980" />
      <path pathLength="100" d="M-10 150 H 56 L 92 186 H 150" />
      <circle cx="300" cy="430" r="2" />
      <circle cx="1000" cy="226" r="2" />
      <circle cx="306" cy="596" r="2" />
      <circle cx="980" cy="162" r="2" />
      <circle cx="150" cy="186" r="2" />
    </svg>
  </div>
  <div class="ev-ember" aria-hidden="true"></div>
  <div class="ev-survey" aria-hidden="true">
    <i class="scan"></i>
    <i class="cross"></i>
    <span class="c1">35°41'12"N</span>
    <span class="c2">MAGI · CORE</span>
    <span class="c3">DEPTH 00240</span>
    <span class="c4">139°41'28"E</span>
  </div>
  <div class="ev-dust" aria-hidden="true"></div>

  <div class="ev-tape ev-tape-t"></div>
  <div class="ev-tape ev-tape-b"></div>
  <div class="ev-frame"><i></i><i></i><i></i><i></i></div>
  <div class="ev-corner tl"></div>
  <div class="ev-corner tr"></div>
  <div class="ev-corner bl"></div>
  <div class="ev-corner br"></div>

  <div class="ev-top">
    <span>NERV · 極東支部 / <b>${u.children}</b></span>
    <span>A-10 NERVE CLIP · LCL PRESSURE 0.98</span>
    <span class="ev-clock">T+00.00</span>
  </div>

  <div class="ev-magi">
    ${magiCols(u.ghost)}
  </div>

  <div class="ev-side ev-side-l">
    <div class="ev-vtext"><span>${u.unit}</span><small>${u.code}</small></div>
    <div class="ev-mini">
      <b>神経接続</b>
      <b>LCL 注入</b>
      <b>パターン : 青</b>
    </div>
  </div>

  <div class="ev-side ev-side-r">
    <div class="ev-hex"></div>
    <div class="ev-chips">
      <b class="ok">電源</b><b class="ok">回路</b><b>同期</b><b>制御</b>
    </div>
  </div>

  <div class="ev-sync">
    <div class="ev-sync-lab">SYNC RATIO / 同期率</div>
    <div class="ev-sync-num"><span>0.0</span><small>%</small></div>
    <div class="ev-sync-bar"><i></i></div>
  </div>

  <div class="ev-warn">
    <span>警告</span>
    <em>PATTERN BLUE / パターン青</em>
  </div>

  <div class="ev-cross">
    <i class="v"></i>
    <i class="h"></i>
    <i class="ring"></i>
    <i class="ring2"></i>
  </div>
  ${u.ghost === '00'
    ? '<div class="ev-rteeth"></div><div class="ev-rcore"></div><div class="ev-rslit"></div>'
      + '<div class="ev-rplate t"></div><div class="ev-rplate b"></div>'
    : ''}
  <div class="ev-flash"></div>

  <div class="ev-word">
    <div class="ev-word-kana">スタッシュ</div>
    <div class="ev-word-main"><span>S</span><span>T</span><span>A</span><span>S</span><span>H</span></div>
    <div class="ev-word-sub"><i></i><span>GAME LIBRARY</span><i></i></div>
    <div class="ev-stamp">起動完了<em>LAUNCH OK</em><b>NO.0027</b></div>
  </div>

  <div class="ev-cap">LAUNCH SEQUENCE / <b>起動シーケンス</b></div>
  <div class="ev-prog"><i></i></div>

  <div class="ev-scan"></div>
  <div class="ev-vig"></div>
`;

/** 浮尘 12 颗（三套通用）+ 火星 14 颗（明日香）：随机位置与相位写在内联样式里 */
function buildParticles(root: HTMLElement): void {
  const dust = root.querySelector('.ev-dust');
  const ember = root.querySelector('.ev-ember');
  if (!dust || !ember) return;
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('i');
    const x = 4 + Math.random() * 92;
    let y = 8 + Math.random() * 84;
    // 中央留给字标，落在中段的粒子推到上下两端
    if (x > 26 && x < 74 && y > 30 && y < 80) y = y < 55 ? 16 : 88;
    s.style.left = `${x.toFixed(1)}%`;
    s.style.top = `${y.toFixed(1)}%`;
    s.style.setProperty('--dx', `${(Math.random() * 26 - 13).toFixed(1)}px`);
    s.style.animationDelay = `${(-Math.random() * 5.2).toFixed(2)}s`;
    s.style.animationDuration = `${(4.2 + Math.random() * 2.4).toFixed(2)}s`;
    dust.appendChild(s);
  }
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('i');
    s.style.left = `${(6 + Math.random() * 88).toFixed(1)}%`;
    s.style.top = `${(64 + Math.random() * 32).toFixed(1)}%`;
    s.style.setProperty('--dx', `${(Math.random() * 34 - 17).toFixed(1)}px`);
    s.style.animationDelay = `${(-Math.random() * 3.4).toFixed(2)}s`;
    s.style.animationDuration = `${(2.6 + Math.random() * 1.6).toFixed(2)}s`;
    ember.appendChild(s);
  }
}

export function buildEva(pal: EvaPal): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'eva';
  root.dataset.pal = pal;
  root.innerHTML = STAGE(UNIT[pal]);
  buildParticles(root);
  return root;
}

/** 十六进制遥测：一次九行，每行八组 */
function fillHex(root: HTMLElement): void {
  const hex = root.querySelector<HTMLElement>('.ev-hex');
  if (!hex) return;
  const line = (): string => {
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += `${Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0')} `;
    }
    return s.trim();
  };
  hex.textContent = Array.from({ length: 9 }, line).join('\n');
}

/** 遥测数字：时钟与同步率跟 CSS 共用一张 5s 表（950–3150ms 爬满同步率） */
export function startMeters(root: HTMLElement, motionMs: number): () => void {
  const clock = root.querySelector<HTMLElement>('.ev-clock');
  const num = root.querySelector<HTMLElement>('.ev-sync-num span');
  const t0 = performance.now();
  let lastHex = -1;
  const tick = (): void => {
    const t = ((performance.now() - t0) / Math.max(1, motionMs)) * 5000;
    if (clock) clock.textContent = `T+${(Math.min(t, 99999) / 1000).toFixed(2).padStart(5, '0')}`;
    if (num) {
      const p = Math.min(1, Math.max(0, (t - 950) / 2200));
      num.textContent = (p * 100).toFixed(1);
    }
    const step = Math.floor(t / 90);
    if (step !== lastHex) {
      lastHex = step;
      fillHex(root);
    }
  };
  fillHex(root);
  const id = window.setInterval(tick, 50);
  return () => window.clearInterval(id);
}
