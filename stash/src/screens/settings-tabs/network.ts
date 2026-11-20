/** 网络页签：元数据开关 / 代理地址 / 萌娘百科兜底 / 连接测试 / SteamGridDB。 */
import type { Settings } from '../../types';
import { esc } from '../../ui';

export function networkHTML(s: Settings): string {
  const net = s.network;
  return `
    <h2 class="sh">网络</h2>
    <div class="spanel">
      <div class="srow"><div class="lab"><b>在线元数据</b><span>Bangumi / 鲲 Galgame 匹配（中文译名 / 封面 / 简介）· 关闭时全功能离线可用</span></div>
        <button class="tg${net.metadataEnabled ? ' on' : ''}" id="tgNet"></button></div>
      <div class="srow"><div class="lab"><b>萌娘百科兜底</b><span>Bangumi 召回差时再用萌娘百科补中文简介 / 原名 / 类型（冷门同人 / 早期作品）</span></div>
        <button class="tg${net.moegirlFallback !== false ? ' on' : ''}" id="tgMoegirl"></button></div>
      <div class="srow"><div class="lab"><b>批评空间评分</b><span>匹配时额外查 EGS 中央值 / 时长 · 每部多 2 次请求，是整轮最慢的一环；关闭可明显加快</span></div>
        <button class="tg${net.egs ? ' on' : ''}" id="tgEgs"></button></div>
      <div class="srow"><div class="lab"><b>连接测试</b><span>先测 Bangumi · 不可达且开着「萌娘百科兜底」时再测一次 · 跟随 Windows 系统代理</span></div><span class="mini" data-act="testnet">测试连接</span></div>
      <div class="srow"><div class="lab"><b>SteamGridDB</b><span>封面 / 横幅备用源 · 主源没图时自动补一张，也可在详情「在线取封面…」手动用 · 留空即跳过</span></div>
        <input class="inp" id="inpSgdb" type="password" placeholder="API Key" value="${esc(net.sgdbKey ?? '')}"/></div>
      <div class="srow"><div class="lab"><b>限速说明</b><span>每个站点独立：并发 1、间隔 ≥1s；不同站点之间并行，互不阻塞</span></div>
        <div class="stat"><b>1</b><span>req/s · 每站</span></div></div>
    </div>`;
}
