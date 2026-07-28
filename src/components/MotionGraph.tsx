// src/components/MotionGraph.tsx — グラフ概形確認モード
// ============================================================
// 目的は「きれいなグラフを見せること」ではなく、
// **その場で計測が使い物になるか判断すること**。
// 追跡が飛んだ箇所は vx-t / vy-t に鋭いスパイクとして出るので、
// 映像の軌跡オーバーレイより破綻が見つけやすい。
// そのためグラフをタップすると、その時刻へ動画をシークして
// 修正ツールですぐ直せるようにしてある。
//
// 実装メモ
//   ・描画は Canvas 自前。recharts 等はバンドルが重くなるので使わない。
//   ・縦軸 (x/y/vx/vy/v) と横軸 (t/x/vx) を別々に選ぶ方式。
//     x-t, y-t, vx-t, vy-t, y-x, vy-vx をすべて含み、
//     v-t のような組み合わせも自然に出せる。
//   ・軌道 (y-x) と速度平面 (vy-vx) は**等縮尺**で描く。
//     縦横で縮尺が違うと放物線が放物線に見えず、形の判断ができない。
//   ・見失ったフレームでは線を切る。つないで描くと、追跡が飛んだ区間まで
//     滑らかな曲線に見えてしまい、データが正しいと誤解する。
// ============================================================

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { TrackedObject, FrameData } from '../types';

export type AxisKey = 't' | 'x' | 'y' | 'vx' | 'vy' | 'v';

/** 縦軸に選べる量 */
export const Y_AXES: { key: AxisKey; label: string }[] = [
  { key: 'x', label: 'x' },
  { key: 'y', label: 'y' },
  { key: 'vx', label: 'vx' },
  { key: 'vy', label: 'vy' },
  { key: 'v', label: '速さ' },
];

/** 横軸に選べる量 */
export const X_AXES: { key: AxisKey; label: string }[] = [
  { key: 't', label: 't' },
  { key: 'x', label: 'x' },
  { key: 'vx', label: 'vx' },
];

/** 量の種類。位置どうし／速度どうしの組み合わせは等縮尺で描く */
const family = (k: AxisKey): 'time' | 'pos' | 'vel' =>
  k === 't' ? 'time' : (k === 'x' || k === 'y') ? 'pos' : 'vel';

export const axisLabel = (k: AxisKey, unit: string): string => {
  switch (k) {
    case 't': return 't (s)';
    case 'x': return `x (${unit})`;
    case 'y': return `y (${unit})`;
    case 'vx': return `vx (${unit}/s)`;
    case 'vy': return `vy (${unit}/s)`;
    case 'v': return `速さ (${unit}/s)`;
  }
};

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Series {
  id: string;
  color: string;
  /** 見失いで切れた区間ごとの点列 */
  segments: Sample[][];
}

interface Props {
  objects: TrackedObject[];
  data: FrameData[];
  unit: string;
  xKey: AxisKey;
  yKey: AxisKey;
  /** 描画する物体 ID */
  visibleIds: string[];
  /** 固定高さ [px]。省略すると親の flex に従って伸びる（全画面表示用） */
  height?: number;
  /** グラフ上をタップしたときに、その点の時刻を返す */
  onSeek?: (t: number) => void;
}

/**
 * 目盛り間隔を 1 / 2 / 5 × 10^n から選ぶ。
 * 「raw 以上で最小の候補」を採る素朴なやり方だと、5 と 10 の間が開きすぎて
 * 目盛りが 2 本しか出ないことがある（例: 範囲 2.43 → 間隔 1）。
 * そこで候補ごとに本数を出し、目標本数に一番近いものを選ぶ。
 */
const niceStep = (range: number, target: number): number => {
  if (!(range > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(range / Math.max(1, target))));
  const cands = [mag, 2 * mag, 5 * mag, 10 * mag];
  let best = cands[0];
  let bestErr = Infinity;
  for (const s of cands) {
    const err = Math.abs(range / s - target);
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
};

/** 目盛りラベルの桁数を間隔から決める。
 *  間隔は 1/2/5×10^n に限られるので、この式で必要十分。 */
const fmtTick = (v: number, step: number): string => {
  if (Math.abs(v) < step * 1e-6) return '0';
  if (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-4) return v.toExponential(1);
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  return v.toFixed(decimals);
};

/** 描画点が多すぎるときの間引き（スマホの描画負荷を抑える） */
const MAX_POINTS_PER_SERIES = 1200;

export const MotionGraph: React.FC<Props> = ({
  objects, data, unit, xKey, yKey, visibleIds, height, onSeek,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [picked, setPicked] = useState<{ sx: number; sy: number; t: number } | null>(null);

  // 画面上の座標 ← → データ座標 の変換に使う情報。
  // タップ判定でも使うので描画時に保存しておく。
  const mapRef = useRef<{
    plot: { l: number; t: number; w: number; h: number };
    xMin: number; xMax: number; yMin: number; yMax: number;
  } | null>(null);

  // -------------------------------------------------
  // サイズ追従
  // -------------------------------------------------

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // -------------------------------------------------
  // 系列の組み立て
  // -------------------------------------------------

  const value = (
    it: FrameData['objects'][string], key: AxisKey, t: number
  ): number => {
    switch (key) {
      case 't': return t;
      case 'x': return it.xM;
      case 'y': return it.yM;
      case 'vx': return it.vx;
      case 'vy': return it.vy;
      case 'v': return it.speedMs;
    }
  };

  const series = useMemo<Series[]>(() => {
    const shown = objects.filter(o => o.active && visibleIds.includes(o.id));
    return shown.map(obj => {
      const segments: Sample[][] = [];
      let cur: Sample[] = [];
      for (let i = 0; i < data.length; i++) {
        const it = data[i].objects[obj.id];
        // 見失ったフレームで線を切る
        if (!it || it.lost) {
          if (cur.length > 0) { segments.push(cur); cur = []; }
          continue;
        }
        const t = data[i].timestamp;
        const vx = value(it, xKey, t);
        const vy = value(it, yKey, t);
        if (!isFinite(vx) || !isFinite(vy)) {
          if (cur.length > 0) { segments.push(cur); cur = []; }
          continue;
        }
        cur.push({ x: vx, y: vy, t });
      }
      if (cur.length > 0) segments.push(cur);

      // 点が多すぎる場合は間引く（区間の端は必ず残す）
      const total = segments.reduce((n, s) => n + s.length, 0);
      if (total > MAX_POINTS_PER_SERIES) {
        const stride = Math.ceil(total / MAX_POINTS_PER_SERIES);
        return {
          id: obj.id,
          color: obj.color,
          segments: segments.map(seg =>
            seg.filter((_, i) => i % stride === 0 || i === seg.length - 1)
          ),
        };
      }
      return { id: obj.id, color: obj.color, segments };
    });
  }, [objects, data, xKey, yKey, visibleIds]);

  const hasData = series.some(s => s.segments.some(seg => seg.length >= 1));

  // -------------------------------------------------
  // 描画
  // -------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(size.w);
    const H = Math.round(size.h);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 上を広めに取るのは、縦軸ラベルを枠の上に横書きで置くため。
    // 回転させて左端に置くと、桁の多い目盛り数字（1.0e+6 など）と重なる。
    const pad = { l: 48, r: 12, t: 26, b: 34 };
    const plot = {
      l: pad.l,
      t: pad.t,
      w: Math.max(10, W - pad.l - pad.r),
      h: Math.max(10, H - pad.t - pad.b),
    };

    // ---- 値域 ----
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    series.forEach(s => s.segments.forEach(seg => seg.forEach(p => {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    })));

    if (!isFinite(xMin) || !isFinite(yMin)) {
      mapRef.current = null;
      ctx.fillStyle = 'rgba(139,155,180,0.8)';
      ctx.font = '13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('データがありません', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    // 幅ゼロ（定数データ）は潰れるので少し広げる
    const spanX = xMax - xMin;
    const spanY = yMax - yMin;
    if (spanX < 1e-9) { xMin -= 0.5; xMax += 0.5; }
    if (spanY < 1e-9) { yMin -= 0.5; yMax += 0.5; }

    // 余白 5%
    const mx = (xMax - xMin) * 0.05;
    const my = (yMax - yMin) * 0.05;
    xMin -= mx; xMax += mx;
    yMin -= my; yMax += my;

    // ---- 等縮尺（軌道図・速度平面）----
    // 縦横の縮尺が違うと放物線が放物線に見えないため、
    // 同種の量どうしを比べるときは px/単位 をそろえる。
    const equal = xKey !== 't' && family(xKey) === family(yKey);
    if (equal) {
      const sx = plot.w / (xMax - xMin);
      const sy = plot.h / (yMax - yMin);
      const s = Math.min(sx, sy);
      const cx = (xMin + xMax) / 2;
      const cy = (yMin + yMax) / 2;
      const rx = plot.w / s / 2;
      const ry = plot.h / s / 2;
      xMin = cx - rx; xMax = cx + rx;
      yMin = cy - ry; yMax = cy + ry;
    }

    mapRef.current = { plot, xMin, xMax, yMin, yMax };

    const X = (v: number) => plot.l + ((v - xMin) / (xMax - xMin)) * plot.w;
    const Y = (v: number) => plot.t + plot.h - ((v - yMin) / (yMax - yMin)) * plot.h;

    // ---- 目盛り ----
    // 目安として横は 60px、縦は 38px ごとに 1 本
    const stepX = niceStep(xMax - xMin, Math.max(3, Math.round(plot.w / 60)));
    const stepY = niceStep(yMax - yMin, Math.max(3, Math.round(plot.h / 38)));

    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = 'rgba(139,155,180,0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = Math.ceil(xMin / stepX) * stepX; v <= xMax; v += stepX) {
      const px = X(v);
      ctx.beginPath();
      ctx.moveTo(px, plot.t);
      ctx.lineTo(px, plot.t + plot.h);
      ctx.stroke();
      ctx.fillText(fmtTick(v, stepX), px, plot.t + plot.h + 6);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / stepY) * stepY; v <= yMax; v += stepY) {
      const py = Y(v);
      ctx.beginPath();
      ctx.moveTo(plot.l, py);
      ctx.lineTo(plot.l + plot.w, py);
      ctx.stroke();
      ctx.fillText(fmtTick(v, stepY), plot.l - 6, py);
    }

    // ---- 0 の線 ----
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    if (yMin < 0 && yMax > 0) {
      ctx.beginPath();
      ctx.moveTo(plot.l, Y(0));
      ctx.lineTo(plot.l + plot.w, Y(0));
      ctx.stroke();
    }
    if (xMin < 0 && xMax > 0) {
      ctx.beginPath();
      ctx.moveTo(X(0), plot.t);
      ctx.lineTo(X(0), plot.t + plot.h);
      ctx.stroke();
    }

    // ---- 枠 ----
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.strokeRect(plot.l, plot.t, plot.w, plot.h);

    // ---- 軸ラベル ----
    ctx.fillStyle = 'rgba(139,155,180,0.95)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(axisLabel(xKey, unit), plot.l + plot.w, H - 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(axisLabel(yKey, unit), 2, 3);

    if (equal) {
      ctx.fillStyle = 'rgba(16,217,124,0.9)';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('等縮尺', plot.l + plot.w, 4);
    }

    // ---- 系列 ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.l, plot.t, plot.w, plot.h);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    series.forEach(s => {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      s.segments.forEach(seg => {
        if (seg.length < 2) {
          if (seg.length === 1) {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(X(seg[0].x), Y(seg[0].y), 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          return;
        }
        ctx.beginPath();
        ctx.moveTo(X(seg[0].x), Y(seg[0].y));
        for (let i = 1; i < seg.length; i++) ctx.lineTo(X(seg[i].x), Y(seg[i].y));
        ctx.stroke();
      });

      // 点が少ないうちはサンプル位置も見せる（何点で描いているか分かる）
      const n = s.segments.reduce((a, b) => a + b.length, 0);
      if (n > 0 && n <= 120) {
        ctx.fillStyle = s.color;
        s.segments.forEach(seg => seg.forEach(p => {
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), 1.8, 0, Math.PI * 2);
          ctx.fill();
        }));
      }
    });
    ctx.restore();

    // ---- タップした点 ----
    if (picked) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(picked.sx, picked.sy, 7, 0, Math.PI * 2);
      ctx.stroke();

      const label = `t = ${picked.t.toFixed(3)} s`;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width;
      const bx = Math.min(Math.max(picked.sx - tw / 2 - 6, plot.l), plot.l + plot.w - tw - 12);
      const by = Math.max(picked.sy - 30, plot.t + 2);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(bx, by, tw + 12, 19);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + 10);
    }
  }, [size, series, xKey, yKey, unit, picked]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  /** 軸を変えたら、前に打った印の画面位置は無意味になるので消す */
  useEffect(() => { setPicked(null); }, [xKey, yKey]);

  // -------------------------------------------------
  // タップ → 最寄りのサンプルを探して動画をシーク
  // -------------------------------------------------
  //
  // canvas の touch-action は pan-y にしてある。
  // こうしないとシート内のスクロールがグラフの上で止まってしまう。
  // そのぶん「スクロールのつもりの指」でも pointerdown は飛んでくるので、
  // 指が動かなかったとき（＝タップ）だけシークする。

  const tapStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    tapStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = tapStartRef.current;
    tapStartRef.current = null;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;

    const m = mapRef.current;
    const canvas = canvasRef.current;
    if (!m || !canvas || !onSeek) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    const X = (v: number) => m.plot.l + ((v - m.xMin) / (m.xMax - m.xMin)) * m.plot.w;
    const Y = (v: number) =>
      m.plot.t + m.plot.h - ((v - m.yMin) / (m.yMax - m.yMin)) * m.plot.h;

    let bestD = Infinity;
    let bestSx = 0;
    let bestSy = 0;
    let bestT = NaN;
    series.forEach(s => s.segments.forEach(seg => seg.forEach(p => {
      const sx = X(p.x);
      const sy = Y(p.y);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; bestSx = sx; bestSy = sy; bestT = p.t; }
    })));

    // 遠すぎるタップは無視（誤操作でシークが飛ぶのを防ぐ）
    if (isFinite(bestT) && bestD <= 44) {
      setPicked({ sx: bestSx, sy: bestSy, t: bestT });
      onSeek(bestT);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="graph-wrap"
      style={height !== undefined ? { height } : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'pan-y' }}
        onPointerDown={handleDown}
        onPointerUp={handleUp}
        onPointerCancel={() => { tapStartRef.current = null; }}
      />
      {!hasData && (
        <div className="graph-empty">
          まだ記録がありません。枠を指定して再生すると描かれます。
        </div>
      )}
    </div>
  );
};
