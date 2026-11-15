/** mock 数据：与 demo-library 的 demo-games.json 同源。
 *  浏览器直开（无 Tauri）时使用；cover 为 null → 前端走占位美术降级。 */

import type { Game, Settings } from './types';

const M = (o: Partial<Game> & { id: string; title: string }): Game => ({
  titleOriginal: null, romaji: null, dir: '', exe: '', engine: 'unknown',
  engineLabel: '未知引擎', engineEvidence: '', cover: null, thumb: null, shots: [],
  peProduct: null, peCompany: null, developer: null, sizeGb: 4.2,
  lastPlayed: null, playCount: 0, playSeconds: 0, endings: [], favorite: false, addedAt: Date.now() / 1000 - 86400 * 30,
  needsLocale: false, matched: true, launchArgs: [], bangumiId: null, matchScore: null, pending: false,
  summary: null, tags: [], aliases: [], year: null,
  progress: 0, hidden: false, userTags: [], notes: '', rating: 0, sessions: [],
  titleOverride: null, coverOverride: null, ...o,
});

export const MOCK_GAMES: Game[] = [
  M({ id: 'd01', title: '千恋＊万花', titleOriginal: '千恋＊万花', romaji: 'SENREN*BANKA', developer: '柚子社', year: 2016, tags: ['和风', '恋爱', '喜剧'], engine: 'kirikiri', engineLabel: '吉里吉里', progress: 0.62, summary: '穗织镇流传的因缘之说——被选中的少年少女，将与人柱的宿命相纠缠。一把神刀，一场巫女与学生的物语，在温泉与祭典的小镇缓缓展开。', lastPlayed: Date.now() / 1000 - 3600 * 5, playCount: 12 }),
  M({ id: 'd02', title: 'CLANNAD', titleOriginal: 'CLANNAD', romaji: 'CLANNAD', developer: 'Key', year: 2004, tags: ['催泪', '家族', '奇迹'], engine: 'nScripter', engineLabel: 'NScripter', progress: 1, summary: '家族的物语。在坂道尽头遇见的少女古河渚，让浑噩度日的不良少年冈崎朋也重新看见了小镇的温柔。光玉汇聚之时，奇迹将被点亮。', lastPlayed: Date.now() / 1000 - 86400 * 30, playCount: 3 }),
  M({ id: 'd03', title: '白色相簿2', titleOriginal: 'WHITE ALBUM 2', romaji: 'WHITE ALBUM 2', developer: 'Leaf', year: 2012, tags: ['恋爱', '冬季', '三角'], engine: 'oNScripter', engineLabel: 'ONScripter', progress: 0.35, summary: '冬雪将至的东京，两把吉他和一段未曾开始就已注定的三角关系。关于推卸、逃避，以及无法回头的恋爱物语。', lastPlayed: Date.now() / 1000 - 86400 * 3, playCount: 7 }),
  M({ id: 'd04', title: '素晴らしき日々', titleOriginal: '素晴らしき日々', romaji: 'SUBARASHIKI HIBI', developer: 'KeroQ', year: 2010, tags: ['哲学', '轮回', '文学'], engine: 'renPy', engineLabel: "Ren'Py", progress: 0.8, needsLocale: true, summary: '不连续的存在。七个相互镜像的故事，向日葵、航空信、逻辑学与轮回。当终之空降临，世界以语言重建。' }),
  M({ id: 'd05', title: 'AIR', titleOriginal: 'AIR', romaji: 'AIR', developer: 'Key', year: 2000, tags: ['催泪', '传说', '夏空'], engine: 'siglus', engineLabel: 'SiglusEngine', progress: 1, summary: '夏天，海边小镇，翼人传说。流浪的少年国崎往人在旅途中遇见的三位少女，各自的悲伤在千年宿命中交汇。鸟之诗，起。', lastPlayed: Date.now() / 1000 - 86400 * 90, playCount: 2 }),
  M({ id: 'd06', title: '命运石之门', titleOriginal: 'STEINS;GATE', romaji: 'STEINS;GATE', developer: 'MAGES.', year: 2009, tags: ['科幻', '悬疑', '时间'], engine: 'unity', engineLabel: 'Unity', progress: 0.55, summary: '凤凰堂地下室里的电话微波炉（暂定），竟意外连向了世界线的彼岸。中二病科学家冈部伦司，在命运石之门的选择前——El Psy Kongroo。', lastPlayed: Date.now() / 1000 - 86400, playCount: 21 }),
  M({ id: 'd07', title: '樱之诗', titleOriginal: 'サクラノ詩', romaji: 'SAKURA NO UTA', developer: '枕', year: 2015, tags: ['艺术', '青春', '群像'], engine: 'catSystem2', engineLabel: 'CatSystem2', progress: 0, needsLocale: true, summary: '在樱之森下漫步。天才少年画家草薙直哉重新执笔的那个春天，美、艺术与日常，将以樱花的速度凋零与盛放。' }),
  M({ id: 'd08', title: 'G线上的魔王', titleOriginal: 'G線上の魔王', romaji: 'G-SENJOU NO MAOU', developer: 'AKABEISOFT2', year: 2008, tags: ['悬疑', '都市', '犯罪'], engine: 'wolfRpg', engineLabel: 'Wolf RPG', progress: 1, needsLocale: true, summary: '夜晚的涩谷，爵士酒吧。平凡的少年与转学的少女，以及潜伏在都市阴影中的『魔王』。一场以人心为棋盘的对局，无声开始。', lastPlayed: Date.now() / 1000 - 86400 * 7, playCount: 5 }),
  M({ id: 'd09', title: '装甲恶鬼村正', titleOriginal: '装甲悪鬼村正', romaji: 'SOUKOU AKUKI MURAMASA', developer: 'Nitroplus', year: 2009, tags: ['战斗', '黑暗', '时代剧'], engine: 'yuRis', engineLabel: 'YU-RIS', progress: 0.25, needsLocale: true, summary: '钢——是杀人之剑，亦是护人之剑。背负斩杀千人诅咒的装甲恶鬼村正，在侠道与霸道之间，斩开属于自己的正义。' }),
  M({ id: 'd10', title: 'planetarian', titleOriginal: 'planetarian', romaji: 'PLANETARIAN', developer: 'Key', year: 2004, tags: ['短篇', '末日', '治愈'], engine: 'artemis', engineLabel: 'Artemis', progress: 0.9, summary: '封印都市的废墟天文馆，营业少女型机器人星梦，等待了二十九年的一声『欢迎光临』。雨与星光的短篇物语。' }),
];

export function mockSettings(): Settings {
  return {
    version: 2,
    theme: 'cinema',
    layout: 'classic',
    fpsMode: 'auto',
    sort: 'lastPlayed',
    motion: 0,
    animSpeed: 1,
    bootAnim: 'core',
    fontScale: 1,
    verticalTitle: true,
    autostart: false,
    fullscreen: true,
    gamepadMouse: false,
    padMap: { accept: 'south', back: 'east', menu: 'start', x: 'west', y: 'north', r: 'rb', lb: 'lb', shot: 'select' },
    power60: false,
    sound: { enabled: true, gain: 0.6 },
    locale: { warnOnly: true, toolPath: null, launch: false },
    network: { metadataEnabled: false, moegirlFallback: true },
  };
}
