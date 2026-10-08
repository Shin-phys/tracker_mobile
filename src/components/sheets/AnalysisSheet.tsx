// src/components/sheets/AnalysisSheet.tsx
// ============================================================
// 解析 — 当てはめて数値を出すタブ。
//
// データタブ（グラフ概形・CSV）と分けてあるのは、やることが違うから。
// あちらは「計測が使い物になるか」を見る場所で、平滑化も効く。
// こちらは「数値をいくつとして報告するか」を決める場所なので、
//   ・当てはめるのは**生データ**（平滑化すると不確かさが過小評価される）
//   ・傾きには**標準誤差を必ず添える**
//   ・残差を見せる（構造が残っていたらモデルが違う）
// の 3 つを外さない。
// ============================================================

import React, { useMemo, useState } from 'react';
import { TrackedObject, FrameData, FpsSettings, ScaleCalibration } from '../../types';
import {
  fitSeries, rawSeries, pickQuantity, accelerationOf, velocityOf,
  secondDiffStats, FitModel, FitQuantity, G_STANDARD,
} from '../../utils/fit';
import { timeScale } from '../../utils/timeScale';
import { TimeRange } from '../../utils/timeRange';
import { Card } from '../ui';
import { Sigma } from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  selectedObjId: string;
  onSelectObjId: (id: string) => void;
  historyData: FrameData[];
  timeRange: TimeRange;
  fpsSettings: FpsSettings;
  calibration: ScaleCalibration;
  videoLoaded: boolean;
  /** 残差の外れ点から動画へ飛ぶ（ファイル上の時刻で渡す） */
  onSeek?: (t: number) => void;
}

const QUANTITIES: { key: FitQuantity; label: string }[] = [
  { key: 'x', label: 'x-t' },
  { key: 'y', label: 'y-t' },
  { key: 'vx', label: 'vx-t' },
  { key: 'vy', label: 'vy-t' },
];

const fmt = (v: number, d = 4): string => {
  if (!isFinite(v)) return '---';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(d);
};

/** 残差グラフ。構造（曲がり・うねり）が見えたらモデルが違う */
const ResidualPlot: React.FC<{
  residuals: { t: number; r: number }[];
  rmse: number;
  color: string;
  scale: number;
  onSeek?: (t: number) => void;
}> = ({ residuals, rmse, color, scale, onSeek }) => {
  const W = 320;
  const H = 110;
  const pad = { l: 8, r: 8, t: 10, b: 16 };
  if (residuals.length < 2) return null;
  const ts = residuals.map(p => p.t);
  const rs = residuals.map(p => p.r);
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  const rAbs = Math.max(...rs.map(Math.abs), 1e-12);
  const px = (t: number) =>
    pad.l + ((t - tMin) / Math.max(1e-12, tMax - tMin)) * (W - pad.l - pad.r);
  const py = (r: number) =>
    pad.t + (0.5 - (r / (rAbs * 1.15)) * 0.5) * (H - pad.t - pad.b);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <rect
        x={pad.l} y={py(rmse)} width={W - pad.l - pad.r}
        height={Math.max(1, py(-rmse) - py(rmse))}
        fill="rgba(99,102,241,0.14)"
      />
      <line x1={pad.l} y1={py(0)} x2={W - pad.r} y2={py(0)}
        stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
      {residuals.map((p, i) => (
        <circle
          key={i} cx={px(p.t)} cy={py(p.r)} r={3.2}
          fill={Math.abs(p.r) > 2.5 * rmse ? '#ef4444' : color}
          onClick={() => onSeek?.(scale > 0 ? p.t / scale : p.t)}
        />
      ))}
      <text x={pad.l} y={H - 4} fill="var(--text-muted)" fontSize={9}>
        ±{rAbs.toExponential(1)}
      </text>
      <text x={W - pad.r} y={H - 4} fill="var(--text-muted)" fontSize={9}
        textAnchor="end">
        {tMin.toFixed(2)} 〜 {tMax.toFixed(2)} s
      </text>
    </svg>
  );
};

export const AnalysisSheet: React.FC<Props> = ({
  objects, selectedObjId, onSelectObjId, historyData, timeRange,
  fpsSettings, calibration, videoLoaded, onSeek,
}) => {
  const active = useMemo(() => objects.filter(o => o.active), [objects]);
  const [quantity, setQuantity] = useState<FitQuantity>('vy');
  const [model, setModel] = useState<FitModel>('linear');
  const [showDt, setShowDt] = useState(false);

  const unit = calibration.unit;
  const scale = timeScale(fpsSettings);
  const target = active.find(o => o.id === selectedObjId) ?? active[0];

  const series = useMemo(
    () => rawSeries(historyData, target?.id ?? selectedObjId, scale, timeRange),
    [historyData, target?.id, selectedObjId, scale, timeRange]
  );
  const values = pickQuantity(series, quantity);
  const pts = useMemo(
    () => series.t.map((t, i) => ({ t, y: values[i] })),
    [series.t, values]
  );
  const fit = useMemo(() => fitSeries(pts, model), [pts, model]);
  const sdStats = useMemo(() => {
    if (quantity === 'vx' || quantity === 'vy') return [];
    return secondDiffStats(series.t, values);
  }, [series.t, values, quantity]);

  const accel = fit ? accelerationOf(quantity, fit) : null;
  const vel = fit ? velocityOf(quantity, fit) : null;
  const isVel = quantity === 'vx' || quantity === 'vy';
  const qUnit = isVel ? `${unit}/s` : unit;

  if (!videoLoaded) {
    return <div className="notice notice-info">先に動画を選んでください。</div>;
  }

  return (
    <>
      <Card title={<><Sigma size={16} color="var(--accent-primary)" />当てはめ</>}>
        {active.length > 1 && (
          <div className="chips" style={{ marginBottom: 8 }}>
            {active.map(o => (
              <button
                key={o.id}
                className={`chip ${o.id === (target?.id ?? '') ? 'is-active' : ''}`}
                onClick={() => onSelectObjId(o.id)}
              >
                {o.id}
              </button>
            ))}
          </div>
        )}
        <div className="chips" style={{ marginBottom: 8 }}>
          {QUANTITIES.map(q => (
            <button
              key={q.key}
              className={`chip ${q.key === quantity ? 'is-active' : ''}`}
              onClick={() => {
                setQuantity(q.key);
                // 位置なら放物線、速度なら直線。加速度を読みたい場面が
                // ほとんどなので、既定をそこへ寄せる。
                setModel(q.key === 'vx' || q.key === 'vy' ? 'linear' : 'quadratic');
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="chips">
          <button className={`chip ${model === 'linear' ? 'is-active' : ''}`}
            onClick={() => setModel('linear')}>直線</button>
          <button className={`chip ${model === 'quadratic' ? 'is-active' : ''}`}
            onClick={() => setModel('quadratic')}>放物線</button>
        </div>
      </Card>

      {!fit && (
        <div className="notice notice-info">
          当てはめに足りる点がありません（{pts.length} 点）。
          区間を広げるか、先に追跡してください。
        </div>
      )}

      {fit && (
        <>
          {(accel || vel) && (
            <Card>
              {accel && (
                <>
                  <div className="hint" style={{ margin: 0 }}>
                    加速度{isVel ? '（速度の傾き）' : '（t² の係数 × 2）'}
                  </div>
                  <div className="mono" style={{
                    fontSize: '1.25rem', fontWeight: 700,
                    color: 'var(--text-primary)', lineHeight: 1.35,
                  }}>
                    {fmt(accel.value, 3)} ± {fmt(accel.err, 3)}
                    <span style={{ fontSize: '0.8rem' }}> {qUnit}{isVel ? '/s' : '²'}</span>
                  </div>
                  {unit === 'm' && Math.abs(accel.value) > G_STANDARD * 0.3
                    && Math.abs(accel.value) < G_STANDARD * 3 && (
                    <div className="hint" style={{ margin: '4px 0 0' }}>
                      g の <b>{(Math.abs(accel.value) / G_STANDARD).toFixed(3)} 倍</b>
                      （標準重力 {G_STANDARD} m/s²）
                    </div>
                  )}
                </>
              )}
              {vel && (
                <>
                  <div className="hint" style={{ margin: 0 }}>速度（位置の傾き）</div>
                  <div className="mono" style={{
                    fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)',
                  }}>
                    {fmt(vel.value, 3)} ± {fmt(vel.err, 3)}
                    <span style={{ fontSize: '0.8rem' }}> {unit}/s</span>
                  </div>
                </>
              )}
            </Card>
          )}

          <Card title="当てはめの中身">
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
              fontSize: '0.8rem',
            }}>
              <div className="row-between"><span>点の数</span>
                <b className="mono">{fit.n}</b></div>
              <div className="row-between"><span>R²</span>
                <b className="mono">{fit.r2.toFixed(5)}</b></div>
              <div className="row-between" style={{ gridColumn: '1 / -1' }}>
                <span>RMSE</span>
                <b className="mono">{fmt(fit.rmse, 5)} {qUnit}</b>
              </div>
            </div>
          </Card>

          <Card title="残差（実測 − 当てはめ）">
            <ResidualPlot
              residuals={fit.residuals} rmse={fit.rmse}
              color={target?.color ?? '#6366f1'} scale={scale} onSeek={onSeek}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              ばらついているだけなら、そのモデルで足りています。
              <b>弓なりに曲がっていたらモデルが違います</b>。
              赤い点は RMSE の 2.5 倍を超えた点で、タップするとその時刻へ飛びます。
            </div>
          </Card>

          {sdStats.length > 0 && (
            <Card
              title="Δt の選び方"
              right={
                <button className="btn btn-secondary btn-sm"
                  onClick={() => setShowDt(v => !v)}>
                  {showDt ? '閉じる' : '開く'}
                </button>
              }
            >
              {!showDt ? (
                <div className="hint" style={{ margin: 0 }}>
                  2 階差分で加速度を出すときの Δt を、ばらつきから選べます。
                </div>
              ) : (
                <>
                  <table style={{
                    width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem',
                  }}>
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th style={{ textAlign: 'left', padding: '3px 4px' }}>Δt</th>
                        <th style={{ textAlign: 'right', padding: '3px 4px' }}>平均 a</th>
                        <th style={{ textAlign: 'right', padding: '3px 4px' }}>SD</th>
                      </tr>
                    </thead>
                    <tbody className="mono">
                      {sdStats.map(s => (
                        <tr key={s.k} style={{ borderTop: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '3px 4px' }}>
                            {(s.dt * 1000).toFixed(1)} ms
                            <span style={{ color: 'var(--text-muted)' }}> ({s.k})</span>
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                            {fmt(s.mean, 2)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 4px' }}>
                            {fmt(s.sd, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="hint" style={{ marginTop: 6 }}>
                    分母が (Δt)² なので、<b>Δt を 2 倍にするとばらつきは 1/4</b> です。
                    一方で広げると「その区間で加速度が一定」という前提が効いてきます。
                    <b>平均が動かなくなって、ばらつきが十分小さい最小の Δt</b> を選んでください。
                  </div>
                </>
              )}
            </Card>
          )}

          <div className="hint">
            当てはめているのは<b>平滑化していない生データ</b>です。平滑化したデータに
            当てはめると、傾きはほとんど変わらないのに R² と標準誤差だけが良くなります
            （隣の点と相関ができて「独立な n 点」という前提が崩れるため）。
            <br />
            <b>スケールの誤差は加速度に比例、時間軸の誤差は 2 乗で効きます。</b>
            撮影 fps を 2 倍間違えると加速度は 4 倍ずれます。
          </div>
        </>
      )}
    </>
  );
};
