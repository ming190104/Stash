// @vitest-environment happy-dom
/** 四源候选的 IPC 边界：命令名 / 参数 / 结构兜底。
 *  候选墙本身在 settings-candidates 与 detail-menu 里测，这里只钉后端契约。 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

type Ipc = typeof import('../ipc');
let ipc: Ipc;

beforeAll(async () => {
  // ipc.ts 在模块加载时读取该标记决定是否走 Tauri；必须先打标记再 import
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  ipc = await import('../ipc');
});

beforeEach(() => invoke.mockReset());

const bangumi = {
  source: 'bangumi',
  key: '42',
  title: 'Kanon',
  original: 'Kanon',
  year: 1999,
  score: 98,
  summary: null,
  thumb: null,
  egs: null,
};
const egs = {
  source: 'egs',
  key: 'Kanon',
  title: 'Kanon',
  original: null,
  year: null,
  score: 60,
  summary: null,
  thumb: null,
  egs: { score: 78, votes: 120, minutes: 1500 },
};

const kungal = {
  source: 'kungal',
  key: '4145',
  title: '甜蜜女友 3',
  original: 'アマカノ３',
  year: 2025,
  score: 100,
  summary: '简介',
  thumb: null,
  egs: null,
};

describe('四源并行候选 IPC', () => {
  it('metaCandidates 调 match_candidates_all，带 id 与 limit，四源结果都保留', async () => {
    invoke.mockResolvedValue([bangumi, kungal, egs]);
    const out = await ipc.metaCandidates('0123456789abcdef', 6);
    expect(invoke).toHaveBeenCalledWith('match_candidates_all', {
      id: '0123456789abcdef',
      limit: 6,
    });
    expect(out.map((c) => c.source)).toEqual(['bangumi', 'kungal', 'egs']);
  });

  it('未知来源 / 缺 key / null 在 IPC 层就被丢弃，EGS 统计字段原样透传', async () => {
    invoke.mockResolvedValue([
      bangumi,
      { ...egs, source: 'vndb' },
      { ...bangumi, key: '' },
      null,
    ]);
    const out = await ipc.metaCandidates('0123456789abcdef');
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('bangumi');
    expect(out[0]!.egs).toBeNull();

    invoke.mockResolvedValue([egs]);
    const [hit] = await ipc.metaCandidates('0123456789abcdef');
    expect(hit!.egs).toEqual({ score: 78, votes: 120, minutes: 1500 });
  });

  it('applyCandidate 把 source + key 原样交给后端（四源共用一条命令）', async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.applyCandidate('0123456789abcdef', 'kungal', '4145');
    expect(invoke).toHaveBeenCalledWith('apply_candidate', {
      id: '0123456789abcdef',
      source: 'kungal',
      key: '4145',
    });
  });
});
