/** 设置屏的动作集合：手动添加 exe / 匹配 / 导入导出 / 诊断。
 *  以 data-act 为入口统一接线，各页签只负责画按钮，不重复写 IPC 逻辑。 */

import { state, SORT_MODES } from '../../state';
import { toast, esc, applyTheme, applyLayout, applyMotion, applyFontScale } from '../../ui';
import { applySoundSettings } from '../../sfx';
import {
  TAURI,
  addGame,
  pickExeFile,
  getLibrary,
  getSettings,
  updateSettings,
  cancelMatch,
  testNetwork,
  probeSources,
  exportData,
  importData,
  pickSavePath,
  pickJsonFile,
  matchAll,
  matchRunning as isMatchRunning,
  onEvent,
  openAppDir,
  exportDiagnostics,
} from '../../ipc';
import { promptInput } from '../../prompt';
import { hideStates } from '../../overlay';
import { runBaseline } from '../../fps';
import { renderRail, updateCount, refreshLibrary, openDetail } from '../library';
import { renderGrid } from '../grid';
import { runHealth } from './health';
import { rerender } from './ui';
import { setSourceProbe } from '../settings-tabs/metadata';

const TIER_LAB: Record<string, string> = { auto: '自动入库', pending: '待确认', none: '未匹配' };

/** 匹配进行中标志：防重复点「开始匹配」堆出一串并发（1 req/s 是硬约束） */
let matchRunning = false;

/** 主程序名太泛时不适合当标题（`game.exe` / `launcher.exe` 之类），改用所在目录名。 */
const GENERIC_STEM = new Set([
  'game', 'start', 'launch', 'launcher', 'play', 'run', 'main', 'app', 'vn',
  'galgame', 'setup', 'boot', 'engine', 'system',
]);

/** 由 exe 路径推默认标题：优先文件名（去掉 .exe）；泛化名 / 纯数字 / 极短名改用目录名。
 *  只做纯前端推断——meta.json / PE 信息要等入库探测，而标题在探测前就要填。 */
export function suggestTitle(exe: string): string {
  const parts = exe.split(/[\\/]+/).filter(Boolean);
  const file = parts.pop() ?? '';
  const stem = file.replace(/\.exe$/i, '').trim();
  const dir = parts.pop() ?? '';
  const dirGeneric = !dir || /^(g|games?|galgame|vn|shelf)$/i.test(dir) || /^[a-z]:$/i.test(dir);
  const weak = GENERIC_STEM.has(stem.toLowerCase()) || /^\d+$/.test(stem) || [...stem].length <= 3;
  return weak && !dirGeneric ? dir : stem || dir;
}

/** 目录比对（统一分隔符 / 去尾斜杠 / 小写）：只在添加重复作品时定位已有条目。 */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function dirOf(exe: string): string {
  return exe.replace(/[\\/][^\\/]+$/, '');
}

/** 按 exe 入库（手动添加与拖拽入库共用）：成功返回 true；重复时打开库里那部并返回 false。
 *  标题由调用方决定：对话框可编辑，拖拽直接按文件 / 目录名推断。 */
export async function addGameByExe(exe: string, title: string): Promise<boolean> {
  const t = title.trim();
  if (!t) {
    toast('标题不能为空', true);
    return false;
  }
  try {
    const g = await addGame(exe, t);
    await refreshLibrary();
    hideStates();
    // 首部作品入库时给一次「下一步」：在线元数据默认关闭，否则用户会以为封面 / 会社为空是坏了
    const first = state.games.length === 1 && !!state.settings && !state.settings.network.metadataEnabled;
    toast(`已添加《${esc(g.title)}》${first ? ' · 需要封面 / 简介可在设置 · 元数据开启在线匹配' : ''}`);
    return true;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    // 同一目录重复添加：后端拒绝后不弹红条，直接打开库里那部（比让人自己翻更快）
    if (msg.includes('已在库中')) {
      // 库可能已被别处改动：这里读一次最新的，避免定位到内存里的旧数据
      const games = await getLibrary().catch(() => state.games);
      state.games = games;
      const hit = games.find((g) => sameDir(g.dir, dirOf(exe)));
      if (hit) {
        hideStates();
        toast(`《${esc(hit.title)}》已在库中，已打开详情`);
        openDetail(hit.id);
        return false;
      }
    }
    toast(esc(msg), true);
    return false;
  }
}

/** 手动添加单部作品：选 exe → 填标题（默认按文件 / 目录名推断）→ 入库。
 *  不经过目录识别门槛，小体积 exe / 合集目录里的主程序也能单独入库。 */
export async function addManualGame(): Promise<void> {
  const exe = await pickExeFile();
  if (!exe) return;
  const title = await promptInput({
    title: '手动添加游戏',
    sub: '标题会固定下来；封面 / 引擎仍按所在目录读取',
    value: suggestTitle(exe),
    cap: 120,
  });
  if (title === null) return;
  await addGameByExe(exe, title);
}

async function exportBundle(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const p = await pickSavePath(`stash-backup-${day}.json`);
  if (!p) return;
  try {
    const n = await exportData(p);
    // 路径只留尾部：导出后用户下一步就是「拷到电脑 / 发给别人」，
    // 不告诉存到哪等于没导；但 toast 是 nowrap 单行，整条路径会把气泡撑出屏幕
    const shown = p.length > 45 ? `…${p.slice(-45)}` : p;
    toast(`已导出 ${n} 部作品（库 + 设置）→ ${esc(shown)}`);
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function importBundle(): Promise<void> {
  const p = await pickJsonFile();
  if (!p) return;
  const v = await promptInput({
    title: '导入备份',
    sub: `${p}\n会覆盖当前库与设置（导入前自动另存当前库）；输入「确认」继续`,
  });
  if (v !== '确认') return;
  try {
    const n = await importData(p);
    state.settings = await getSettings();
    // 导入的是整包设置：只换 state.settings 不够，主题/布局/动效/字号/排序都是
    // 运行时状态，不重新灌一次就会「设置页显示新值、界面还是旧样式」，要等重启才生效
    const s = state.settings;
    applyTheme(s.theme);
    applyLayout(s.layout);
    if (SORT_MODES.some((m) => m.v === s.sort)) state.sortBy = s.sort;
    state.motion = s.motion === 1 ? 1 : 0;
    state.verticalTitle = s.verticalTitle !== false;
    applyMotion(state.motion === 1);
    applyFontScale(s.fontScale);
    applySoundSettings(s);
    // 手柄键位是「进程内状态」：import_data 只写盘、不会重新下发，
    // 不补这一步就会出现「设置页显示备份里的新键位、按下去还是旧映射」直到重启。
    // 走一次 update_settings 让后端按新值重新应用（失败只提示，导入本身已成功）。
    try {
      await updateSettings(s);
    } catch (e) {
      toast(`设置已导入，但手柄键位未能即时生效：${esc(String((e as { message?: string })?.message ?? e))}`, true);
    }
    state.games = await getLibrary();
    hideStates();
    renderRail();
    renderGrid();
    rerender();
    updateCount();
    toast(`已导入 ${n} 部作品 · 游戏目录变化时请在设置里重新添加`);
  } catch (e) {
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function runMatch(): Promise<void> {
  if (matchRunning) {
    toast('匹配已在进行中', true);
    return;
  }
  if (!TAURI) {
    toast('浏览器预览：未接 Tauri 网络层，匹配需在应用内运行', true);
    return;
  }
  matchRunning = true;
  const total = state.games.filter((g) => !g.bangumiId && (!g.matchScore || g.pending)).length;
  // 后端会先做数据源预检（不可达时可能等一次超时），再开跑整轮；提示里要说清楚
  toast(total ? `开始匹配 ${total} 部（先检查数据源，串行 1 req/s，约 ${total * 2}s）` : '全部已匹配');

  // 所有监听都先就位，任何一条出错都要复位 matchRunning，否则按钮永久卡在“进行中”
  let off: () => void = () => {};
  let offErr: () => void = () => {};
  let offDone: () => void = () => {};
  let guard = 0;
  const cleanup = (): void => {
    matchRunning = false;
    if (guard) {
      window.clearInterval(guard);
      guard = 0;
    }
    off();
    offErr();
    offDone();
  };
  // 整轮结束的收尾（done 事件与下方状态轮询共用）：复位 + 刷新库 + 汇总 toast。
  // 幂等：靠 matchRunning 挡住第二次进入
  const finishMatch = (cancelled: boolean, done = 0, tot = 0): void => {
    if (!matchRunning) return;
    cleanup();
    void (async () => {
      // 回调里的异步刷新必须自己兜住：失败时界面不能停在「匹配中…」且抛出未捕获拒绝
      let games;
      try {
        games = await getLibrary();
      } catch (e) {
        console.error('[settings] 匹配后刷新库失败', e);
        toast('匹配已结束，但刷新库失败（可返回库重试）', true);
        return;
      }
      state.games = games;
      renderRail();
      renderGrid();
      rerender();
      const auto = state.games.filter((g) => g.matched && !g.pending).length;
      const pend = state.games.filter((g) => g.pending).length;
      if (cancelled) {
        toast(`匹配已取消 · 完成 ${done}/${tot} · 入库 ${auto} 部`);
      } else {
        toast(`匹配完成 · 入库 ${auto} 部 · 待确认 ${pend} 部`);
      }
    })();
  };
  try {
    off = await onEvent<{ done: number; total: number; tier: string }>('match://progress', (p) => {
      if (p.done === p.total || p.done % 5 === 0) {
        toast(`匹配中 ${p.done} / ${p.total} · 最近一部 ${TIER_LAB[p.tier] ?? p.tier}`);
      }
    });
    offErr = await onEvent<{ message: string }>('match://error', (e) => toast(esc(e.message), true));
    offDone = await onEvent<{ total: number; done: number; cancelled?: boolean; id?: string }>('match://done', (p) => {
      if (p.id) return; // bind_subject 也发这条事件（{id, bound}），不能当成「整轮匹配结束」
      finishMatch(!!p.cancelled, p.done, p.total);
    });
    await matchAll();
    // match_all 返回时预检已完成（预检本身可能阻塞 10–30s），整轮仍在 Rust 后台线程串行跑，
    // 30–80 部要 1–3 分钟；所以不能按时间兜底——1.5s 后就把仍在进行的匹配当成结束，
    // 会拆掉进度监听并误报「完成」。
    // done 事件丢失（订阅失败）时按钮才会永久卡住：改为查后端状态，确认结束才收尾（幂等）。
    guard = window.setInterval(() => {
      if (!matchRunning) {
        cleanup();
        return;
      }
      void isMatchRunning()
        .then((run) => {
          if (!run) finishMatch(false);
        })
        .catch(() => {
          /* IPC 瞬时失败：等下一轮 */
        });
    }, 2000);
  } catch (e) {
    cleanup();
    toast(esc(String((e as { message?: string })?.message ?? e)), true);
  }
}

async function doAction(act: string): Promise<void> {
  if (act === 'baseline') {
    toast('基线测试运行中…');
    const lines = await runBaseline();
    toast(esc(lines.join(' ｜ ')));
    return;
  }
  if (act === 'opendata' || act === 'openlogs') {
    try {
      await openAppDir(act === 'openlogs' ? 'logs' : 'data');
      toast(act === 'openlogs' ? '已打开日志目录' : '已打开数据目录');
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  if (act === 'diagnostics') {
    try {
      const p = await exportDiagnostics();
      toast(esc(`诊断报告已导出：${p.split(/[\\/]/).pop() ?? p}（数据目录 / diagnostics）`));
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  if (act === 'health') return runHealth();
  if (act === 'addgame') return addManualGame();
  if (act === 'export') return exportBundle();
  if (act === 'import') return importBundle();
  if (act === 'cancelmatch') {
    if (!matchRunning) {
      toast('当前没有进行中的匹配');
      return;
    }
    await cancelMatch();
    toast('已请求取消 · 当前这部跑完即停');
    return;
  }
  if (act === 'testnet') {
    // 后端只测 Bangumi；只有「萌娘百科兜底」开着时才在 Bangumi 不可达后补测萌娘百科。
    // 文案先讲清楚，别让用户等兜底结果却看见一条只提 Bangumi 的提示
    const fallback = state.settings?.network?.moegirlFallback !== false;
    toast(fallback ? '正在测试 Bangumi 连接…（不可达时再试萌娘百科）' : '正在测试 Bangumi 连接…');
    try {
      toast(esc(await testNetwork()));
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  if (act === 'probe') {
    // 逐源探测：主源不可达时每一步都要等一次超时，先讲清楚再等
    toast('正在测试数据源…（Bangumi 不可达时可能要等一次超时）');
    try {
      const r = await probeSources();
      if (!r) {
        toast('浏览器预览：未接 Tauri 网络层', true);
        return;
      }
      setSourceProbe(r);
      rerender();
      if (r.usable) {
        toast(esc(r.message ?? '数据源可用 · 可以开始匹配'));
      } else {
        toast(esc(r.message ?? '数据源均不可达'), true);
      }
    } catch (e) {
      toast(esc(String((e as { message?: string })?.message ?? e)), true);
    }
    return;
  }
  if (act === 'match') await runMatch();
}

/** 动作按钮：doAction 是 async，异常（尤其对话框插件失败）必须兜底成 toast，
 *  否则既没有任何提示，又会留下未捕获的 Promise 拒绝 */
export function wireActions(body: HTMLElement): void {
  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void doAction((btn as HTMLElement).dataset.act!).catch((e) => {
        toast(esc(String((e as { message?: string })?.message ?? e)), true);
      });
    });
  });
}
