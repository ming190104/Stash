import { describe, expect, it } from 'vitest';
import { suggestTitle, sameDir } from '../screens/settings/actions';

describe('suggestTitle', () => {
  it('用文件名当标题（作品名通常就是主程序名）', () => {
    expect(suggestTitle(String.raw`D:\Galgame\千恋万花\千恋万花.exe`)).toBe('千恋万花');
  });
  it('主程序名太泛时改用所在目录名', () => {
    expect(suggestTitle(String.raw`D:\Galgame\CLANNAD\game.exe`)).toBe('CLANNAD');
    expect(suggestTitle(String.raw`D:\Galgame\AIR\Launcher.EXE`)).toBe('AIR');
  });
  it('目录名也泛化时保留文件名', () => {
    expect(suggestTitle(String.raw`D:\Games\setup.exe`)).toBe('setup');
    expect(suggestTitle(String.raw`D:\game.exe`)).toBe('game');
  });
  it('纯数字 / 极短文件名同样视为泛化', () => {
    expect(suggestTitle(String.raw`D:\Galgame\沙耶之歌\12.exe`)).toBe('沙耶之歌');
    expect(suggestTitle(String.raw`D:\Galgame\素晴日\ab.exe`)).toBe('素晴日');
  });
});

describe('sameDir', () => {
  it('忽略分隔符、尾斜杠与大小写', () => {
    expect(sameDir(String.raw`D:\Galgame\AIR`, 'd:/galgame/air/')).toBe(true);
    expect(sameDir(String.raw`D:\Galgame\AIR`, String.raw`D:\Galgame\CLANNAD`)).toBe(false);
  });
});
