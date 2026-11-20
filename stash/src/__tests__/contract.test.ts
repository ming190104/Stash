/** 前后端字段契约快照：TS 接口与 Rust models.rs 的 serde 输出必须同名、同集合。
 *  清单在 contract/fields.json，Rust 侧 models::tests::serialized_fields_match_shared_contract
 *  读的是同一份文件。fixture 用 Required<Game> / Required<Settings> 标注：
 *  接口少一个字段会报「多余属性」，多一个字段会报「缺少属性」，编译期就能拦住。 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Game, Settings } from '../types';

const CONTRACT = JSON.parse(readFileSync(new URL('../../contract/fields.json', import.meta.url), 'utf8')) as {
  game: string[];
  settings: string[];
};

const GAME: Required<Game> = {
  id: '0123456789abcdef',
  title: 'AIR',
  titleOriginal: 'AIR',
  romaji: 'AIR',
  dir: 'D:\\games\\AIR',
  exe: 'D:\\games\\AIR\\game.exe',
  engine: 'kirikiri',
  engineLabel: '吉里吉里',
  engineEvidence: '*.xp3',
  cover: null,
  thumb: null,
  shots: [],
  peProduct: null,
  peCompany: null,
  developer: 'Key',
  sizeGb: 1.5,
  lastPlayed: null,
  playCount: 0,
  playSeconds: 0,
  endings: [],
  favorite: false,
  addedAt: 0,
  needsLocale: false,
  localeOverride: null,
  matched: true,
  launchArgs: [],
  bangumiId: null,
  kungalId: null,
  matchScore: null,
  pending: false,
  summary: null,
  tags: [],
  aliases: [],
  year: 2000,
  titleOverride: null,
  coverOverride: null,
  hidden: false,
  userTags: [],
  notes: '',
  rating: 0,
  sessions: [],
  metaManual: false,
  manual: false,
  lengthMinutes: null,
  metaScore: null,
  metaScoreSource: null,
  metaScoreCount: null,
  metaSource: null,
};

const SETTINGS: Required<Settings> = {
  version: 2,
  theme: 'cinema',
  layout: 'classic',
  fpsMode: 'auto',
  sort: 'lastPlayed',
  motion: 0,
  fontScale: 1,
  animSpeed: 1,
  bootAnim: 'warp',
  verticalTitle: true,
  autostart: false,
  fullscreen: true,
  gamepadMouse: false,
  abSwap: false,
  padMap: { accept: 'south', back: 'east', menu: 'start', x: 'west', y: 'north', r: 'rb', lb: 'lb', random: 'l3' },
  padTuning: { deadzone: 0.28, repeatMs: 60, mouseSpeed: 11 },
  power60: false,
  sound: { enabled: true, gain: 0.6 },
  network: { metadataEnabled: true, moegirlFallback: true, sgdbKey: null },
  locale: { warnOnly: true, toolPath: null, launch: false },
  views: [],
  libraryRoots: [],
};

const keysOf = (o: object): string[] => Object.keys(o).sort();

describe('前后端字段契约', () => {
  it('Game 字段集合与 Rust 序列化一致', () => {
    expect(keysOf(GAME)).toEqual([...CONTRACT.game].sort());
  });

  it('Settings 字段集合与 Rust 序列化一致', () => {
    expect(keysOf(SETTINGS)).toEqual([...CONTRACT.settings].sort());
  });
});
