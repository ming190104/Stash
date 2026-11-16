/** DOM 测试骨架：按 index.html 的四屏 + 状态层节点搭最小结构。
 *  happy-dom 不实现滚动：统一补一个 no-op，避免 render* 的 scrollIntoView 抛错。 */

import type { Game } from '../types';
import { state } from '../state';

export function game(id: string, over: Partial<Game> = {}): Game {
  return {
    id,
    title: id,
    titleOriginal: null,
    romaji: null,
    dir: '',
    exe: '',
    engine: 'unknown',
    engineLabel: '',
    engineEvidence: '',
    cover: null,
    thumb: null,
    shots: [],
    peProduct: null,
    peCompany: null,
    developer: null,
    sizeGb: 0,
    lastPlayed: null,
    playCount: 0,
    playSeconds: 0,
    endings: [],
    favorite: false,
    addedAt: 0,
    needsLocale: false,
    matched: true,
    launchArgs: [],
    bangumiId: null,
    matchScore: null,
    pending: false,
    summary: null,
    tags: [],
    aliases: [],
    year: null,
    hidden: false,
    userTags: [],
    notes: '',
    ...over,
  };
}

export function mountSkeleton(): void {
  document.body.innerHTML = `
    <div id="app">
      <section class="screen on" data-s="library"><div class="keybar"></div></section>
      <section class="screen" data-s="grid"><div class="keybar"></div></section>
      <section class="screen" data-s="detail"><div class="keybar"></div></section>
      <section class="screen" data-s="settings"><div class="keybar"></div></section>
      <div id="heroInfo"></div><div id="heroArt"></div><div id="heroWm"></div>
      <div id="ambA"></div><div id="ambB"></div>
      <div id="emptyState" class="state"><div id="emptyBody"></div></div>
      <div id="loadingState" class="state"><div id="skCap"></div></div>
      <div id="errorState" class="state"><div class="state-sub"></div><button data-state="retry"></button></div>
      <div id="searchPanel" class="state">
        <input id="spInput" />
        <div id="spList"></div>
        <div id="spSort"><b></b><b></b><b></b></div>
      </div>
      <div id="filterPanel" class="state"><div id="fltCols"></div><button id="saveView"></button></div>
      <div id="endPanel" class="state"><div id="endTitle"></div><div id="endList"></div></div>
      <div id="bgPanel" class="state">
        <div id="bgTitle"></div><div id="bgGrid"></div>
        <button id="bgPick"></button><button id="bgAuto"></button>
      </div>
      <div id="candPanel" class="state">
        <div id="candTitle"></div>
        <div class="cand-body"><div id="candGrid"></div><div id="candPrev"></div></div>
        <div id="candQueue"></div>
        <button id="candUnmatch"></button>
      </div>
      <div id="helpPanel" class="state"></div>
      <div id="qmenu" class="qmenu"><div class="qbox"><div class="qt"></div><div class="qlist"></div></div></div>
      <div id="launchLayer"></div>
      <div id="toast"></div>
      <button id="fBtn"></button>
      <button id="llStop"></button>
    </div>`;
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => undefined;
  }
}

/** 每个用例前复位单例状态，避免上一个用例的作品 / 筛选 / 屏幕串进来 */
export function resetState(): void {
  state.games = [];
  state.settings = null;
  state.screen = 'library';
  state.focus = 0;
  state.gridFocus = 0;
  state.gridFilter = 'all';
  state.gridMulti = false;
  state.gridSel.clear();
  state.tagFilter = null;
  state.devFilter = null;
  state.yearFilter = null;
  state.collection = null;
  state.viewName = null;
  state.detailId = null;
  state.running = null;
  state.sortBy = 'lastPlayed';
  state.query = '';
  state.motion = 0;
  state.verticalTitle = true;
  localStorage.clear();
}

/** 构造可断言的可取消键盘事件（默认 KeyboardEvent 不可取消，preventDefault 不会生效） */
export function key(code: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true, ...extra });
}
