// @vitest-environment happy-dom
/** 启动音效的时间表：连续层跟运动、两记硬事件落在白闪与就绪，
 *  速度倍率只压缩整段时间，不改变各层的相对位置。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sfx', () => ({ audioBus: vi.fn() }));

import { audioBus } from '../sfx';
import { playBootSfx, stopBootSfx } from '../boot-sfx';

interface Param {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

function param(): Param {
  return {
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

interface FakeGain {
  gain: Param;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/** 只实现被用到的那几个节点：断言看的是「排了哪些时刻」，不是波形本身 */
function harness() {
  const starts: number[] = [];
  const gains: FakeGain[] = [];
  const master = { connect: vi.fn() } as unknown as GainNode;
  const comp = {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
    connect: vi.fn(),
  } as unknown as DynamicsCompressorNode;

  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    createGain: () => {
      const g: FakeGain = { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(g);
      return g;
    },
    createOscillator: () => ({
      type: 'sine',
      frequency: param(),
      connect: vi.fn(),
      start: (t: number) => starts.push(t),
      stop: vi.fn(),
    }),
    createBufferSource: () => ({
      buffer: null,
      loop: false,
      connect: vi.fn(),
      start: (t: number) => starts.push(t),
      stop: vi.fn(),
    }),
    createBiquadFilter: () => ({
      type: 'bandpass',
      frequency: param(),
      Q: { value: 1 },
      connect: vi.fn(),
    }),
    createStereoPanner: () => ({ pan: param(), connect: vi.fn() }),
    createDynamicsCompressor: () => comp,
    createBuffer: (_ch: number, len: number, sr: number) => ({
      sampleRate: sr,
      getChannelData: () => new Float32Array(len),
    }),
  };

  vi.mocked(audioBus).mockReturnValue({
    ctx: ctx as unknown as AudioContext,
    master,
  });
  return { starts, gains, master, comp };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(audioBus).mockReset();
});

afterEach(() => {
  stopBootSfx();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('playBootSfx', () => {
  it('穿越从 0 就开始，白闪前后有硬事件，尾音不比 5s 长', () => {
    const { starts, gains, master } = harness();
    playBootSfx(5000);

    expect(starts.length).toBeGreaterThan(20); // 刻度节拍本身就几十个
    expect(Math.min(...starts)).toBeCloseTo(0.03, 2);
    expect(starts.some((t) => Math.abs(t - 3.0) < 0.06)).toBe(true); // 白闪 2.97
    expect(Math.max(...starts)).toBeLessThanOrEqual(5.2);
    // 总线接到 sfx 的 master 上，音量才由设置统一控制
    expect(gains[0].connect).toHaveBeenCalledWith(master);
  });

  it('2× 时整段减半：同一层的时刻按比例前移', () => {
    const { starts } = harness();
    playBootSfx(2500);

    // K = 0.5，第一个音 0.03 + 0
    expect(Math.min(...starts)).toBeCloseTo(0.03, 2);
    expect(starts.some((t) => Math.abs(t - 1.515) < 0.06)).toBe(true); // 白闪 2.97 × .5
    expect(Math.max(...starts)).toBeLessThanOrEqual(2.7);
  });

  it('EVA 三档：各自排程，白闪落在 3.3s，压缩器接在总线上', () => {
    for (const mode of ['eva01', 'eva02', 'evaNerv'] as const) {
      const { starts, gains, comp } = harness();
      playBootSfx(5000, mode);

      expect(starts.length).toBeGreaterThan(30);
      expect(starts.some((t) => Math.abs(t - 3.3) < 0.06)).toBe(true);
      expect(Math.max(...starts)).toBeLessThanOrEqual(5.2);
      expect(gains[0].connect).toHaveBeenCalledWith(comp);
      stopBootSfx();
    }
  });

  it('EVA 2×：白闪跟着速度档前移到 1.65s', () => {
    const { starts } = harness();
    playBootSfx(2500, 'eva02');

    expect(starts.some((t) => Math.abs(t - 1.65) < 0.06)).toBe(true);
    expect(Math.max(...starts)).toBeLessThanOrEqual(2.7);
  });

  it('没有音频设备 / 音效关闭时静默降级，不抛错', () => {
    vi.mocked(audioBus).mockReturnValue(null);
    expect(() => playBootSfx(5000)).not.toThrow();
    expect(() => stopBootSfx()).not.toThrow();
  });
});

describe('stopBootSfx', () => {
  it('停止时总线 90ms 淡出，再断开——不留咔哒声', () => {
    const { gains } = harness();
    playBootSfx(5000);
    const bus = gains[0];

    stopBootSfx();
    expect(bus.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 0.09);
    vi.advanceTimersByTime(200);
    expect(bus.disconnect).toHaveBeenCalled();
  });

  it('连续起播会先停掉上一段，不会两层声音叠在一起', () => {
    const { gains } = harness();
    playBootSfx(5000);
    const first = gains[0];
    playBootSfx(5000);

    expect(first.gain.exponentialRampToValueAtTime).toHaveBeenCalled();
  });

  it('重复停止是幂等的', () => {
    const { gains } = harness();
    playBootSfx(5000);
    stopBootSfx();
    expect(() => stopBootSfx()).not.toThrow();
    expect(gains.length).toBeGreaterThan(1);
  });
});
