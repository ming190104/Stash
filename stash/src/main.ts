/** Stash 前端入口：boot 流程（mockup 启动序列迁移 + Tauri 数据接入）。 */

import './app.css';
import { state, setScreen, SORT_MODES } from './state';
import { getLibrary, getSettings, onEvent, runningGame, TAURI, reportTiming, checkUpdate } from './ipc';
import { initLibrary, renderRail, openDetail, updateEmpty, scheduleLibraryRefresh } from './screens/library';
import { initGrid, renderGrid } from './screens/grid';
import { initDetail } from './screens/detail';
import { initSettings, renderSettings } from './screens/settings';
import { initFiles } from './screens/files';
import { init as initNav } from './nav';
import { init as initFps } from './fps';
import { initOverlay, applyStateParam, hideStates } from './overlay';
import { toggleQuickMenu } from './quick';
import { initDropImport } from './drop';
import { toast, esc, errMsg, applyTheme, cachedTheme, applyLayout, cachedLayout, applyMotion, applyFontScale, applyAnimSpeed, applyBootAnim, applyFullscreenUI, stageScale } from './ui';
import { applySoundSettings } from './sfx';
import { initSplash, hideBootCover } from './splash';
import type { LayoutName } from './types';

/* ============ 时钟 ============ */
function tick(): void {
  const d = new Date();
  const s = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  for (const id of ['clock', 'clock2', 'clock3']) {
    const el = document.getElementById(id);
    if (el) el.textContent = s;
  }
}

/* ============ 电量（WebView2 支持 Battery API，拿不到则隐藏） ============ */
async function initBattery(): Promise<void> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
    if (!nav.getBattery) return;
    const b = await nav.getBattery();
    const el = document.getElementById('battPct');
    if (el) el.textContent = `${Math.round(b.level * 100)}%`;
  } catch {
    /* 忽略：无电池信息时保持 --% */
  }
}

/* ============ 首屏入场编排（mockup bootSequence 同款） ============ */
const BOOT_DUR = 500;
function bootSequence(): void {
  const arm = (el: Element | null, kind: string, delay: number): void => {
    if (!el) return;
    const h = el as HTMLElement;
    h.classList.add('boots', kind);
    h.style.animationDelay = `${delay}ms`;
    const clear = (): void => {
      h.classList.remove('boots', kind);
      h.style.animationDelay = '';
    };
    h.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, delay + BOOT_DUR + 60); // 兜底：窗口切后台时 animationend 不可靠
  };
  arm(document.querySelector('#app .topbar'), 'up', 0);
  arm(document.querySelector('#app .keybar'), 'up', 150);
  document.querySelectorAll('#railTrack .card').forEach((c, i) => arm(c, 'up', 190 + i * 34));
}

/* ============ 等比缩放 + 流体舞台 ============
   1280×720 仍是布局基准：16:9 窗口下逻辑尺寸正好 1280×720，缩放后铺满整窗。
   窗口比例不是 16:9 时，把「短的那一边」定在 1280 / 720，另一边按同比例放大——
   多出来的空间交给布局自己撑（轨道更宽、hero 更高），因此永远没有留边，
   也不会非等比拉伸。 */
function fitStage(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const s = stageScale(innerWidth, innerHeight);
  app.style.width = `${innerWidth / s}px`;
  app.style.height = `${innerHeight / s}px`;
  app.style.transform = Math.abs(s - 1) < 0.001 ? '' : `scale(${s})`;
  // 逻辑宽度变了：轨道的居中 / 夹紧要用新视口重算
  window.dispatchEvent(new Event('stage-resize'));
}

/* ============ 静默更新检查 ============ */

/** 上次检查时间：每天最多查一次，避免每次启动都打 GitHub 接口（限流 60/h 也经不起） */
const UPDATE_CHECK_KEY = 'vnUpdateCheckedAt';
const UPDATE_CHECK_GAP = 24 * 3600 * 1000;

async function silentUpdateCheck(): Promise<void> {
  if (!TAURI) return;
  const last = Number(localStorage.getItem(UPDATE_CHECK_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < UPDATE_CHECK_GAP) return;
  try {
    const u = await checkUpdate();
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
    if (u) {
      toast(`发现新版本 ${u.version} · 设置 → 关于 可更新`);
      // Update 在 Rust 侧持有资源：只提示不安装，读完立刻释放
      void u.close();
    }
  } catch {
    // 离线 / 被拦 / 仓库没有 Release 都是常态：启动阶段不打扰用户
  }
}

/* ============ boot ============ */
async function boot(): Promise<void> {
  // ?layout=classic|list|wall 直达某布局（规格截图 / 目检；只切本次会话，不写回用户设置）
  const qLayoutRaw = new URLSearchParams(location.search).get('layout');
  const qLayout =
    qLayoutRaw === 'classic' || qLayoutRaw === 'list' || qLayoutRaw === 'wall' ? (qLayoutRaw as LayoutName) : null;
  // 首帧先用缓存主题 / 布局，避免读盘前闪一下默认样式
  applyTheme(cachedTheme());
  applyLayout(qLayout ?? cachedLayout(), !qLayout);
  // 冷启动跃迁：先起播（此时主题已就位，颜色一致），数据并行加载
  const splash = initSplash();
  // 启动动画层已在 DOM 里（或明确不播）：撤掉 index.html 的首帧遮罩
  hideBootCover();
  // 数据
  state.settings = await getSettings();
  state.games = await getLibrary();
  applyTheme(state.settings.theme);
  applyLayout(qLayout ?? state.settings.layout, !qLayout);
  applyFontScale(state.settings.fontScale);
  applySoundSettings(state.settings);
  // 全屏启动时隐藏窗口按钮（设置里切换时由设置页 / 快捷菜单同步）
  applyFullscreenUI(!!state.settings.fullscreen);

  // 持久化设置回灌（总案 10.2）：排序 / 动效强度 / 竖排原名
  const s = state.settings;
  if (SORT_MODES.some((m) => m.v === s.sort)) state.sortBy = s.sort;
  state.motion = s.motion === 1 ? 1 : 0;
  applyAnimSpeed(s.animSpeed);
  // 启动动画档位同步进缓存：设置文件里改过（导入 / 手改）时下次启动才不会用旧档
  applyBootAnim(s.bootAnim);
  state.verticalTitle = s.verticalTitle !== false;
  applyMotion(state.motion === 1);
  // 系统「减少动态效果」在运行中被切换时立即跟随，不必重启
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => applyMotion(state.motion === 1));

  // 各屏初始化（注册 handler / 事件监听）
  initLibrary();
  initGrid();
  initDetail();
  initSettings();
  initFiles();
  initNav();
  initFps();
  initOverlay();
  // 拖拽入库：把主程序 exe 直接拖进窗口（浏览器预览下 initDropImport 自身静默跳过）
  void initDropImport().catch((e) => console.warn('[boot] 拖拽入库订阅失败', e));

  // 首屏渲染
  renderRail();
  renderGrid();
  // 设置页渲染失败（IPC 拒答 / 数据异常）只该丢掉设置面板，不能连累下面的窗口按钮与事件订阅
  await renderSettings().catch((e) => console.error('[boot] 设置页渲染失败', e));
  updateEmpty();
  tick();
  setInterval(tick, 20000);
  void initBattery();

  // 重启 / 崩溃重开时与 Rust 对账「哪部在运行」，恢复前端运行态
  if (TAURI) {
    runningGame()
      .then((g) => {
        // 只补运行态，不重复 initLibrary（事件订阅会双份）
        if (g && !state.running) state.running = g.id;
      })
      .catch((e) => console.warn('[boot] running_game 对账失败', e));
  }

  // data-go 统一跳转（topbar 设置按钮 / 详情返回）
  document.querySelectorAll('[data-go]').forEach((b) => {
    b.addEventListener('click', () => setScreen((b as HTMLElement).dataset.go as never));
  });
  // 顶栏常驻菜单按钮：全屏隐藏搜索 / 设置 / 窗口按钮后，纯鼠标仍能打开快捷菜单
  document.querySelectorAll('[data-quick]').forEach((b) => {
    b.addEventListener('click', () => void toggleQuickMenu());
  });

  // 无边框窗口自绘按钮（decorations:false；拖拽由顶栏的 data-tauri-drag-region 承担）
  document.querySelectorAll('[data-win]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!TAURI) return; // 浏览器预览：无窗口可操作，静默忽略
      const action = (b as HTMLElement).dataset.win;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        if (action === 'min') await w.minimize();
        else await w.close();
      } catch (e) {
        // 窗口 API 失败（权限 / WebView 异常）不能留成未捕获拒绝：给一句可读提示
        toast(`窗口操作失败：${esc(String((e as { message?: string })?.message ?? e))}`, true);
      }
    });
  });

  // 无障碍：只有图标的按钮（顶栏 / 窗口按钮）没有可读文本，把 title 同步成 aria-label；
  // 装饰性 SVG 一律 aria-hidden，避免读屏把路径念一遍
  document.querySelectorAll<HTMLElement>('[title]:not([aria-label])').forEach((el) => {
    el.setAttribute('aria-label', el.title);
  });
  document.querySelectorAll('.tbtn svg, .kg svg, .state-mark svg').forEach((s) => {
    s.setAttribute('aria-hidden', 'true');
  });

  // 长按 Start+Select：Rust 已结束游戏并把窗口叫回前台，前端只需收起浮层回书架
  void onEvent('pad://home', () => {
    hideStates();
    setScreen('library');
    toast('已回到书架');
  });

  // 手柄映射鼠标被 UIPI 拒绝：只提示一次，避免用户以为「摇杆坏了」
  void onEvent('pad://mouse-blocked', () => {
    toast('手柄映射鼠标被系统拒绝 · 请让游戏与应用以相同权限运行', true);
  });

  // 后台缩略图完成 → 防抖刷新（thumb 路径已落盘）
  // 批量导入时 N 次 done 合并成一次全库 IPC + 重绘；失败只打日志（scheduleLibraryRefresh 内）
  void onEvent('thumbs://done', () => {
    scheduleLibraryRefresh();
  });

  // 缩放适配
  addEventListener('resize', fitStage);
  fitStage();

  // 启动动画按 5.0s 完整播放；数据与首屏已在遮罩后就绪，跳过交给任意键 / 触摸
  await splash;

  // 静默更新检查放在首屏之后：不占启动关键路径，失败也绝不打扰
  void silentUpdateCheck();

  // 窗口失焦 / 被其它窗口完全盖住时暂停无限动画：#app.paused 由 CSS 统一 pause，
  // 避免库界在后台（尤其是游戏全屏时）继续合成抢帧。
  // 同时在操作停止 4s 后挂 #app.idle：只要有一个无限动画在跑，合成器就按刷新率整窗
  // 出帧；静止后完全停帧，GPU 占用归零，切屏 / 并行游戏时不再掉帧。
  {
    const app = document.getElementById('app');
    const sync = (paused: boolean) => app?.classList.toggle('paused', paused);
    addEventListener('blur', () => sync(true));
    addEventListener('focus', () => sync(document.hidden));
    document.addEventListener('visibilitychange', () => sync(document.hidden));
    sync(document.hidden);

    let idleTimer = 0;
    let wakeTimer = 0;
    /** 一帧内只续一次 idle 计时（pointermove 这类高频事件合并用） */
    let wakeQueued = false;
    // 预热非当前屏：opacity:.001 才会真正触发一次栅格化（0 / visibility:hidden 都被跳过）。
    // 预热后第一次切过去只有图层合成（实测最大帧间隔 24ms → 6ms），不会再「卡一下」。
    // 每次进入 idle 再补一次：屏被隐藏久了栅格缓存会被回收，需要重新烘一遍。
    let warming = false;
    const prewarm = (): void => {
      if (warming) return;
      warming = true;
      const list = [...document.querySelectorAll<HTMLElement>('.screen')].filter(
        (el) => !el.classList.contains('on')
      );
      let i = 0;
      const step = (): void => {
        const el = list[i++];
        if (!el) {
          warming = false;
          return;
        }
        // 详情屏没进过作品时是空壳，预热没有意义
        if (el.dataset.s === 'detail' && !state.detailId) {
          step();
          return;
        }
        el.classList.add('warm');
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            el.classList.remove('warm');
            requestAnimationFrame(step); // 每个屏单独两帧，避免一次性栅格化多个整屏
          })
        );
      };
      step();
    };
    const sleep = (): void => {
      app?.classList.add('idle');
      prewarm();
    };
    const wake = () => {
      // 输入事件只负责给 idle 计时续命：pointermove 一秒能来上百条，
      // 每条都清 / 设一遍定时器纯属白烧，合并到一帧里只做一次。
      if (wakeQueued) return;
      wakeQueued = true;
      requestAnimationFrame(() => {
        wakeQueued = false;
        clearTimeout(idleTimer);
        idleTimer = window.setTimeout(sleep, 4000);
        // idle 推迟 180ms 再解除：让切屏那一帧先保持静止，避免「恢复呼吸动画的样式重算」
        // 与切屏合成撞在同一帧（实测多 6~10ms）；用户按下键到动画恢复只有 0.18s，无感。
        if (app?.classList.contains('idle')) {
          clearTimeout(wakeTimer);
          wakeTimer = window.setTimeout(() => app?.classList.remove('idle'), 180);
        }
      });
    };
    // 键盘 / 鼠标 / 滚轮 / 手柄（手柄走 nav://intent，不产生 DOM 输入事件）
    for (const t of ['keydown', 'pointerdown', 'pointermove', 'wheel'])
      addEventListener(t, wake, { passive: true });
    void onEvent('nav://intent', wake);
    wake();
    // 首屏入场结束后预热一次（不等到 4s，避免开机后马上切屏还是冷的）
    window.setTimeout(prewarm, 1200);
  }

  // 首屏：默认库屏；?screen=library|grid|detail|settings 可直达任一屏（便于出规格截图 / 目检）
  const q = new URLSearchParams(location.search).get('screen');
  if (q === 'detail' && state.games[0]) openDetail(state.games[0].id);
  else if (q === 'grid' || q === 'settings') setScreen(q);
  else setScreen('library');
  reportTiming('library-ready', Math.round(performance.now()));

  // ?state=search|empty|noresult|loading|error 直达任一 P0 状态层（规格截图 / 目检）
  applyStateParam();

  // 入场编排（双 rAF 确保首帧布局就绪）
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      reportTiming('first-paint', performance.now());
      bootSequence();
    })
  );

  if (!TAURI && import.meta.env.DEV) {
    setTimeout(() => toast('浏览器预览模式 · 仅开发构建可用'), 600);
  }
}

// boot 里任何一步抛错（IPC 拒答 / WebView 缺 API）都会让整个界面停在空白，
// 必须兜住并给出可读原因，而不是悄悄留下一个未处理的 Promise 拒绝
/* ============ 全局兜底 ============ */
/** 事件回调里漏网的错误不能只留在 devtools（桌面版没有可见控制台）。
 *  同一条消息 5s 内只提示一次：批量失败时不至于把 toast 队列刷爆。 */
let lastErr = '';
let lastErrAt = 0;
function reportGlobalError(reason: unknown): void {
  console.error('[unhandled]', reason);
  const msg = errMsg(reason);
  const now = Date.now();
  if (msg === lastErr && now - lastErrAt < 5000) return;
  lastErr = msg;
  lastErrAt = now;
  toast(`操作失败：${esc(msg)}`, true);
}
window.addEventListener('unhandledrejection', (e) => reportGlobalError(e.reason));
window.addEventListener('error', (e) => {
  // 资源加载失败（img / link）不冒泡到 window，这里只会收到真实脚本错误
  if (e.error) reportGlobalError(e.error);
});

// 同一个 index.html 只承载库界面（四屏 + 浮层），没有独立的置顶小窗
boot().catch((e: unknown) => {
  console.error('[boot] failed', e);
  toast(`启动失败：${esc(String((e as Error)?.message ?? e))}`);
});
