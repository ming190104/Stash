/**
 * 生成自动更新清单 latest.json（上传到 GitHub Release 的资产里）。
 *
 * tauri build 在签名后会在安装包旁留下 `<安装包>.sig`，本脚本读取当前版本对应的
 * 安装包与签名，拼成 tauri-plugin-updater 需要的清单，避免手填签名 / 版本出错。
 *
 * 用法：npm run latest-json -- "本次更新说明"
 * 产物：src-tauri/target/release/bundle/nsis/latest.json
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;

// 仓库地址从 updater endpoint 里取：换仓库 / 加镜像时只改配置，脚本不用跟着改
const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? '';
const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(endpoint)?.[1];
if (!repo) {
  throw new Error(`无法从 plugins.updater.endpoints 解析仓库地址：${endpoint || '（未配置）'}`);
}

const bundleDir = path.join(root, 'src-tauri/target/release/bundle/nsis');
const exeName = `Stash_${version}_x64-setup.exe`;
const exePath = path.join(bundleDir, exeName);
const sigPath = `${exePath}.sig`;

// 签名是构建时按版本生成的：版本号改了却没重新打包时，这里必须报错而不是拿旧签名凑数
try {
  await access(sigPath);
} catch {
  throw new Error(`找不到签名文件：${sigPath}\n先执行带签名环境的 npm run tauri build`);
}

const signature = (await readFile(sigPath, 'utf8')).trim();
const url = `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(exeName)}`;
const notes = process.argv.slice(2).join(' ').trim() || `Stash ${version}`;

const manifest = {
  version,
  notes,
  // Tauri 按 RFC 3339 解析；toISOString 的 Z 结尾即 UTC
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature, url },
  },
};

const outPath = path.join(bundleDir, 'latest.json');
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`已生成 ${outPath}`);
console.log(`  版本 ${version}`);
console.log(`  安装包 ${url}`);
