/* 本地 E2E 冒烟：启动发布版 → CDP 驱动四屏 → 断言关键节点 → 退出。
 *
 * 前置：`npx tauri build`（用 src-tauri/target/release/stash.exe）
 * 运行：`npm run smoke`（单实例锁：先关掉正在运行的 Stash）
 * 可用 STASH_EXE 指定其它 exe；失败以非 0 退出，便于本地/CI 复用。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const EXE = process.env.STASH_EXE || path.join('src-tauri', 'target', 'release', 'stash.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = globalThis.WebSocket || require('ws');

if (!fs.existsSync(EXE)) {
  console.error(`[smoke] 找不到 ${EXE}，先运行 npx tauri build`);
  process.exit(1);
}

async function cdpTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* 端口未就绪 */
    }
    await sleep(500);
  }
  return null;
}

(async () => {
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
  });
  const cleanup = () => {
    if (!child.killed) child.kill();
  };
  process.on('exit', cleanup);

  const page = await cdpTarget();
  if (!page) {
    console.error('[smoke] CDP 未就绪：可能有另一份 Stash 在运行（单实例锁）');
    cleanup();
    process.exit(1);
  }

  const ws = new WS(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await call('Runtime.enable');
  // WebView2 会先暴露一个 about:blank 目标，再导航到应用页；等真正文档就绪再采样，
  // 否则会在导航瞬间拿到「Execution context was destroyed」，checks 变 undefined。
  for (let i = 0; i < 60; i++) {
    const probe = await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    const title = probe.result?.result?.value;
    if (typeof title === 'string' && title.includes('Stash')) break;
    await sleep(250);
  }
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };

  const checks = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: '', bubbles: true, cancelable: true }));
    const q = (s) => document.querySelector(s);
    const n = (s) => document.querySelectorAll(s).length;
    const shown = (id) => !!document.getElementById(id)?.classList.contains('show');
    const out = {};
    key('Digit1'); await sleep(800);
    out.cards = n('#railTrack .card');
    out.focus = q('#railTrack .card.focus')?.dataset.i ?? null;
    key('End'); await sleep(350);
    out.endFocus = q('#railTrack .card.focus')?.dataset.i ?? null;
    key('Home'); await sleep(350);
    key('Slash'); await sleep(350); out.search = shown('searchPanel'); key('Escape'); await sleep(250);
    key('KeyF'); await sleep(350); out.filter = shown('filterPanel'); key('Escape'); await sleep(250);
    key('ContextMenu'); await sleep(500); out.menu = n('#qmenu .qitem'); key('Escape'); await sleep(300);
    key('Digit4'); await sleep(450);
    out.tabs = n('#snav button');
    // 设置 · 元数据 → 改绑：候选模态层立即出现（不再埋在页签最底部）
    document.querySelectorAll('#snav button')[6]?.click(); await sleep(600);
    const rebind = q('#matchedList [data-rebind]');
    out.rebindBtn = !!rebind;
    rebind?.click(); await sleep(500);
    out.candPanel = shown('candPanel');
    key('Escape'); await sleep(350);
    out.candClosed = !shown('candPanel');
    key('Digit2'); await sleep(400);
    key('Enter'); await sleep(1200);
    out.detail = !!q('[data-s="detail"].on');
    out.detailTitle = q('.d-cn')?.textContent ?? '';
    // 详情 · 更多操作 → 背景图：候选卡片墙（上图下文），Esc 关闭
    q('#dMore')?.click(); await sleep(500);
    const bgItem = [...document.querySelectorAll('#qmenu .qitem')].find((b) => (b.textContent ?? '').includes('背景图'));
    out.bgMenuItem = !!bgItem;
    bgItem?.click();
    await sleep(2500);
    out.bgPanel = shown('bgPanel');
    out.bgCards = n('#bgGrid .bg-card');
    out.bgTip = !!q('#bgGrid .bg-tip');
    out.bgTipText = q('#bgGrid .bg-tip')?.textContent ?? '';
    key('Escape'); await sleep(400);
    out.bgClosed = !shown('bgPanel');
    key('Escape'); await sleep(350);
    out.back = !!q('[data-s="library"].on');
    return out;
  })()`);

  ws.close();
  cleanup();

  const fail = [];
  const expect = (ok, msg) => {
    if (!ok) fail.push(msg);
  };
  expect(checks.cards > 0, `库屏卡片数应为正，实际 ${checks.cards}`);
  expect(checks.focus === '0', `初始焦点应为 0，实际 ${checks.focus}`);
  expect(checks.endFocus === String(checks.cards - 1), `End 应落到最后一张，实际 ${checks.endFocus}`);
  expect(checks.search, '搜索面板未打开');
  expect(checks.filter, '筛选面板未打开');
  expect(checks.menu >= 5, `快捷菜单项过少：${checks.menu}`);
  expect(checks.tabs === 8, `设置页签应为 8 个，实际 ${checks.tabs}`);
  expect(checks.rebindBtn, '已匹配作品列表里没有「改绑…」按钮');
  expect(checks.candPanel, '改绑候选面板未打开');
  expect(checks.candClosed, 'Esc 未关闭改绑候选面板');
  expect(checks.detail, '详情屏未打开');
  expect(!!checks.detailTitle, '详情标题为空');
  expect(checks.bgMenuItem, '详情菜单缺少「背景图」入口');
  expect(checks.bgPanel, '背景候选面板未打开');
  // 有候选就应有卡片；没有任何候选时必须是明确提示，不能是空白面板
  expect(checks.bgCards > 0 || checks.bgTip, '背景候选面板既没有卡片也没有提示');
  expect(checks.bgClosed, 'Esc 未关闭背景候选面板');
  expect(checks.back, 'Esc 未回到库屏');
  expect(errors.length === 0, `页面异常：${errors.join(' | ')}`);

  if (fail.length) {
    console.error('[smoke] FAIL');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[smoke] PASS', JSON.stringify(checks));
  process.exit(0);
})().catch((e) => {
  console.error('[smoke] 执行失败：', e?.message ?? e);
  process.exit(1);
});
