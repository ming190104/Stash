/** 库操作窄接口：核心层 / 其它屏只依赖这里，不直接 import screens/library。
 *
 *  原先 detail / grid / 设置页 / 筛选面板都直接 import library，而 library 又反向
 *  动态载入 grid / detail，形成「核心 ↔ 屏幕」的静态环（改一个文件会牵出整棵依赖）。
 *  library.ts 在模块加载时注册实现；调用方拿到的函数在应用启动后恒为可用。
 *  接口只做转发，不含任何业务逻辑。 */

export interface LibraryApi {
  /** 重新读库并重建库屏（缩略图回填也走这里） */
  refresh: () => Promise<void>;
  openDetail: (id: string, fromSearch?: boolean) => void;
  toggleFav: (id: string) => void;
  updateEmpty: () => void;
  updateCount: () => void;
  renderRail: () => void;
}

let api: LibraryApi | null = null;

export function bindLibraryApi(impl: LibraryApi): void {
  api = impl;
}

export function refreshLibrary(): Promise<void> {
  return api ? api.refresh() : Promise.resolve();
}

export function openDetail(id: string, fromSearch = false): void {
  api?.openDetail(id, fromSearch);
}

export function toggleFav(id: string): void {
  api?.toggleFav(id);
}

export function updateEmpty(): void {
  api?.updateEmpty();
}

export function updateCount(): void {
  api?.updateCount();
}

export function renderRail(): void {
  api?.renderRail();
}
