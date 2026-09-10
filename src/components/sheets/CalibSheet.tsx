// src/components/sheets/CalibSheet.tsx
// スケール校正。手順を 1→2 のステップに分け、いまどこにいるかを常に示す。
//
// スマホ固有の工夫
//   ・点の指定は「映像をタップ」。キーボードが無いので、
//     1px 単位の微調整用に十字キー（dpad）を用意した。
//   ・数値入力欄は 16px 以上・右寄せ・inputMode="decimal" で
//     テンキーが出るようにしている。

import React from 'react';
import {
  TrackedObject, ScaleCalibration, LengthUnit,
} from '../../types';
import {
  recalcScale, convertValue, pixelDistance, fmt,
  isCalibrated as calibDone, scaleVariation,
  calibrationAdvice, calibrationGrade, referenceLengthPx,
} from '../../utils/calibration';
import { Card } from '../ui';
import type { StageTool } from '../VideoStage';
import {
  Ruler, Crosshair, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ArrowUpDown,
  Target, Eraser,
} from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  selectedObjId: string;
  calibration: ScaleCalibration;
  onUpdateCalibration: (c: ScaleCalibration) => void;
  isLineCalibrating: boolean;
  setIsLineCalibrating: (v: boolean) => void;
  tool: StageTool;
  setTool: (t: StageTool) => void;
  calibHandle: number;
  setCalibHandle: (i: number) => void;
  videoWidth: number;
  videoHeight: number;
  videoLoaded: boolean;
}

const UNITS: LengthUnit[] = ['mm', 'cm', 'm'];

const PLANE_PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'A4 横', w: 29.7, h: 21 },
  { label: 'A4 縦', w: 21, h: 29.7 },
  { label: 'A3 横', w: 42, h: 29.7 },
  { label: '方眼 50', w: 50, h: 50 },
  { label: 'タイル 30', w: 30, h: 30 },
];

const LENGTH_PRESETS: { v: number; u: LengthUnit; label: string }[] = [
  { v: 1, u: 'cm', label: '1cm' },
  { v: 5, u: 'cm', label: '5cm' },
  { v: 10, u: 'cm', label: '10cm' },
  { v: 20, u: 'cm', label: '20cm' },
  { v: 30, u: 'cm', label: '30cm' },
  { v: 50, u: 'cm', label: '50cm' },
  { v: 1, u: 'm', label: '1m' },
];

export const CalibSheet: React.FC<Props> = ({
  objects, selectedObjId, calibration, onUpdateCalibration,
  isLineCalibrating, setIsLineCalibrating, tool, setTool,
  calibHandle, setCalibHandle, videoWidth, videoHeight, videoLoaded,
}) => {
  const activeObjects = objects.filter(o => o.active);
  const hasLine = calibration.mode === 'line' && calibration.linePoints.length === 2;
  const hasPlane = calibration.mode === 'plane' && calibration.homography !== null;
  const done = calibDone(calibration);
  const linePx = hasLine
    ? pixelDistance(calibration.linePoints[0], calibration.linePoints[1])
    : 0;
  const variation = scaleVariation(calibration, videoWidth, videoHeight);

  const startPicking = () => {
    if (calibration.mode === 'plane') {
      onUpdateCalibration({ ...calibration, planePoints: [], homography: null });
    }
    setIsLineCalibrating(true);
    setTool('calib');
  };

  const stopPicking = () => {
    setIsLineCalibrating(false);
    setTool('pan');
  };

  const picking = isLineCalibrating && tool === 'calib';

  /** 選択中の校正点を dx, dy だけ動かす */
  const nudge = (dx: number, dy: number) => {
    if (calibration.mode === 'plane') {
      const pts = calibration.planePoints;
      if (pts.length !== 4 || calibHandle < 0 || calibHandle > 3) return;
      onUpdateCalibration(recalcScale({
        ...calibration,
        planePoints: pts.map((p, i) => (i === calibHandle ? { x: p.x + dx, y: p.y + dy } : p)),
      }));
    } else {
      const pts = calibration.linePoints;
      if (pts.length !== 2 || calibHandle < 0 || calibHandle > 1) return;
      onUpdateCalibration(recalcScale({
        ...calibration,
        linePoints: pts.map((p, i) => (i === calibHandle ? { x: p.x + dx, y: p.y + dy } : p)),
      }));
    }
  };

  const canNudge = calibration.mode === 'plane'
    ? calibration.planePoints.length === 4
    : calibration.linePoints.length === 2;

  const handleLabels = calibration.mode === 'plane'
    ? ['① 左上', '② 右上', '③ 右下', '④ 左下']
    : ['始点', '終点'];

  return (
    <>
      {/* ---- モード ---- */}
      <Card
        title={<><Ruler size={16} color="var(--accent-primary)" />スケール校正</>}
        right={<span className={`badge ${done ? 'badge-ok' : 'badge-warn'}`}>{done ? '校正済み' : '未校正'}</span>}
      >
        <div className="segmented" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          {([
            { m: 'plane', label: '平面(四隅)' },
            { m: 'line', label: '2点間' },
            { m: 'box', label: '枠の幅' },
          ] as const).map(x => (
            <button
              key={x.m}
              className={`btn ${calibration.mode === x.m ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                stopPicking();
                const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
                onUpdateCalibration(recalcScale(
                  { ...calibration, mode: x.m },
                  x.m === 'box' ? target?.roi?.width : undefined
                ));
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          {calibration.mode === 'plane'
            ? '斜めから撮っていても遠近を補正できます。基準物は運動面と同じ平面に置いてください。'
            : '光軸が運動面に垂直なときだけ正確です。斜めなら「平面(四隅)」を使ってください。'}
        </div>
      </Card>

      {/* ================= 平面モード ================= */}
      {calibration.mode === 'plane' && (
        <>
          <div className={`step ${hasPlane ? 'is-done' : 'is-todo'}`}>
            <div className="step__head" style={{ color: hasPlane ? 'var(--color-success)' : 'var(--color-warning)' }}>
              <span className="step__no" style={{ background: hasPlane ? '#10d97c' : '#f59e0b' }}>1</span>
              基準になる四角形の四隅をタップ
            </div>
            <button
              className={`btn ${picking ? 'btn-warning' : hasPlane ? 'btn-secondary' : 'btn-primary'}`}
              style={{ width: '100%' }}
              disabled={!videoLoaded}
              onClick={() => (picking ? stopPicking() : startPicking())}
            >
              <Crosshair size={15} />
              {picking
                ? `タップ中 ${calibration.planePoints.length}/4（やめる）`
                : hasPlane ? '四隅を取り直す' : '四隅の指定を開始'}
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              <b>左上 → 右上 → 右下 → 左下</b> の順にタップします。
              置いたあとは ● をドラッグ、または下の十字キーで 1px ずつ動かせます。
            </div>
          </div>

          <div className="step" style={{ opacity: calibration.planePoints.length === 4 ? 1 : 0.55 }}>
            <div className="step__head">
              <span className="step__no" style={{ background: 'var(--accent-primary)', color: '#fff' }}>2</span>
              その四角形の実寸
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <div className="hint" style={{ marginBottom: 3 }}>横</div>
                <input
                  type="number" inputMode="decimal" step="any" min="0"
                  className="num-lg"
                  value={calibration.planeWidth}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    onUpdateCalibration(recalcScale({ ...calibration, planeWidth: isNaN(v) ? 0 : v }));
                  }}
                />
              </div>
              <span style={{ paddingBottom: 12, color: 'var(--text-muted)' }}>×</span>
              <div style={{ flex: 1 }}>
                <div className="hint" style={{ marginBottom: 3 }}>縦</div>
                <input
                  type="number" inputMode="decimal" step="any" min="0"
                  className="num-lg"
                  value={calibration.planeHeight}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    onUpdateCalibration(recalcScale({ ...calibration, planeHeight: isNaN(v) ? 0 : v }));
                  }}
                />
              </div>
            </div>

            <div className="chips" style={{ marginTop: 9 }}>
              {UNITS.map(u => (
                <button
                  key={u}
                  className={`chip ${calibration.unit === u ? 'is-active' : ''}`}
                  onClick={() => {
                    const w = convertValue(calibration.planeWidth, calibration.unit, u);
                    const h = convertValue(calibration.planeHeight, calibration.unit, u);
                    onUpdateCalibration(recalcScale({ ...calibration, unit: u, planeWidth: w, planeHeight: h }));
                  }}
                >
                  {u}
                </button>
              ))}
            </div>

            <div className="chips" style={{ marginTop: 9 }}>
              {PLANE_PRESETS.map(p => {
                const w = convertValue(p.w, 'cm', calibration.unit);
                const h = convertValue(p.h, 'cm', calibration.unit);
                const on = Math.abs(calibration.planeWidth - w) < 1e-9
                  && Math.abs(calibration.planeHeight - h) < 1e-9;
                return (
                  <button
                    key={p.label}
                    className={`chip ${on ? 'is-active' : ''}`}
                    onClick={() => onUpdateCalibration(recalcScale({ ...calibration, planeWidth: w, planeHeight: h }))}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {variation && (
            <div className={`notice ${variation.spreadPct > 3 ? 'notice-warn' : 'notice-info'}`}
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
              <div>
                画面内の縮尺のばらつき:{' '}
                <b className="mono">{variation.spreadPct.toFixed(1)}%</b>
              </div>
              <div style={{ opacity: 0.8, fontSize: '0.73rem' }}>
                {variation.spreadPct > 3
                  ? 'それなりに斜めから撮れています。単一スケール校正だとこの分がそのまま誤差になります。'
                  : 'ほぼ正対しています。2点間校正でも大きな差は出ません。'}
                （{fmt(variation.min, 2)}〜{fmt(variation.max, 2)} px/{calibration.unit}）
              </div>
            </div>
          )}
        </>
      )}

      {/* ================= 2点間モード ================= */}
      {calibration.mode === 'line' && (
        <>
          <div className={`step ${hasLine ? 'is-done' : 'is-todo'}`}>
            <div className="step__head" style={{ color: hasLine ? 'var(--color-success)' : 'var(--color-warning)' }}>
              <span className="step__no" style={{ background: hasLine ? '#10d97c' : '#f59e0b' }}>1</span>
              長さの分かる部分をなぞる
            </div>
            <button
              className={`btn ${picking ? 'btn-warning' : hasLine ? 'btn-secondary' : 'btn-primary'}`}
              style={{ width: '100%' }}
              disabled={!videoLoaded}
              onClick={() => (picking ? stopPicking() : startPicking())}
            >
              <Crosshair size={15} />
              {picking ? '指定中（やめる）' : hasLine ? '線を引き直す' : '映像で2点を指定'}
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              端から端まで<b>なぞる</b>か、<b>2回タップ</b>して指定します。
              {hasLine && (
                <>
                  <br />引いた長さ: <b className="mono" style={{ color: '#fbbf24' }}>{linePx.toFixed(1)} px</b>
                </>
              )}
            </div>
          </div>

          <div className="step" style={{ opacity: hasLine ? 1 : 0.55 }}>
            <div className="step__head">
              <span className="step__no" style={{ background: 'var(--accent-primary)', color: '#fff' }}>2</span>
              その長さは実際に何cm？
            </div>
            <input
              type="number" inputMode="decimal" step="any" min="0"
              className="num-lg"
              value={calibration.realSizeValue}
              onFocus={e => e.currentTarget.select()}
              onChange={e => {
                const v = parseFloat(e.target.value);
                onUpdateCalibration(recalcScale({ ...calibration, realSizeValue: isNaN(v) ? 0 : v }));
              }}
            />
            <div className="chips" style={{ marginTop: 9 }}>
              {UNITS.map(u => (
                <button
                  key={u}
                  className={`chip ${calibration.unit === u ? 'is-active' : ''}`}
                  onClick={() => {
                    const v = convertValue(calibration.realSizeValue, calibration.unit, u);
                    onUpdateCalibration(recalcScale({ ...calibration, unit: u, realSizeValue: v }));
                  }}
                >
                  {u}
                </button>
              ))}
            </div>
            <div className="chips" style={{ marginTop: 9 }}>
              {LENGTH_PRESETS.map(p => {
                const on = calibration.unit === p.u
                  && Math.abs(calibration.realSizeValue - p.v) < 1e-9;
                return (
                  <button
                    key={p.label}
                    className={`chip ${on ? 'is-active' : ''}`}
                    onClick={() => onUpdateCalibration(
                      recalcScale({ ...calibration, realSizeValue: p.v, unit: p.u })
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ================= 枠の幅モード ================= */}
      {calibration.mode === 'box' && (
        <Card title="基準にする追跡枠">
          <select
            value={calibration.targetObjId || selectedObjId}
            onChange={e => {
              const id = e.target.value;
              const target = activeObjects.find(o => o.id === id);
              onUpdateCalibration(recalcScale({ ...calibration, targetObjId: id }, target?.roi?.width));
            }}
          >
            {activeObjects.map(o => (
              <option key={o.id} value={o.id}>
                {o.name}{o.roi ? ` (幅 ${Math.round(o.roi.width)}px)` : ' (枠未指定)'}
              </option>
            ))}
          </select>

          <div className="hint" style={{ margin: '10px 0 4px' }}>その枠の幅は実際に何cm？</div>
          <input
            type="number" inputMode="decimal" step="any" min="0"
            className="num-lg"
            value={calibration.realSizeValue}
            onFocus={e => e.currentTarget.select()}
            onChange={e => {
              const v = parseFloat(e.target.value);
              const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
              onUpdateCalibration(
                recalcScale({ ...calibration, realSizeValue: isNaN(v) ? 0 : v }, target?.roi?.width)
              );
            }}
          />
          <div className="chips" style={{ marginTop: 9 }}>
            {UNITS.map(u => (
              <button
                key={u}
                className={`chip ${calibration.unit === u ? 'is-active' : ''}`}
                onClick={() => {
                  const v = convertValue(calibration.realSizeValue, calibration.unit, u);
                  const target = activeObjects.find(o => o.id === (calibration.targetObjId || selectedObjId));
                  onUpdateCalibration(recalcScale({ ...calibration, unit: u, realSizeValue: v }, target?.roi?.width));
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* ---- 微調整（十字キー） ---- */}
      {calibration.mode !== 'box' && canNudge && (
        <Card title="校正点の微調整">
          <div className="chips" style={{ marginBottom: 10 }}>
            {handleLabels.map((lb, i) => (
              <button
                key={lb}
                className={`chip ${calibHandle === i ? 'is-active' : ''}`}
                onClick={() => { setCalibHandle(i); setTool('calib'); setIsLineCalibrating(false); }}
              >
                {lb}
              </button>
            ))}
          </div>
          <div className="dpad">
            <span />
            <button aria-label="上へ" onClick={() => nudge(0, -1)}><ChevronUp size={18} /></button>
            <span />
            <button aria-label="左へ" onClick={() => nudge(-1, 0)}><ChevronLeft size={18} /></button>
            <span className="dpad-center">1px</span>
            <button aria-label="右へ" onClick={() => nudge(1, 0)}><ChevronRight size={18} /></button>
            <span />
            <button aria-label="下へ" onClick={() => nudge(0, 1)}><ChevronDown size={18} /></button>
            <span />
          </div>
          <div className="hint" style={{ marginTop: 8, textAlign: 'center' }}>
            選んだ点は映像上で太い十字になります（中心は塗らないので、狙っている画素が見えます）
          </div>
        </Card>
      )}

      {/* ---- 結果 ---- */}
      <div className={`notice ${done ? 'notice-info' : 'notice-warn'}`}
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
        {!done ? (
          <span>
            未校正です。校正すると速度や距離が実寸で表示されます
            （未校正のままでも px 単位で記録は取れます）。
          </span>
        ) : calibration.mode === 'plane' ? (
          <>
            <span>射影変換で校正済み — 画面内の位置に応じて縮尺が自動補正されます。</span>
            <span style={{ opacity: 0.8, fontSize: '0.73rem' }}>
              原点は四角形の{calibration.yUp ? '左下' : '左上'}の角、単位は {calibration.unit}。
            </span>
          </>
        ) : (
          <>
            <span>
              縮尺: <b className="mono">{fmt(calibration.pxPerUnit, 3)} px / {calibration.unit}</b>
            </span>
            <span style={{ opacity: 0.8, fontSize: '0.73rem' }}>
              1 px = <span className="mono">{fmt(1 / calibration.pxPerUnit, 4)} {calibration.unit}</span>
            </span>
          </>
        )}
      </div>

      {/* ---- 基準の短さの警告 ---- */}
      {/* 基準が短いと、その 1px がそのまま長さ・速度・加速度の誤差になる。
          黙って通り過ぎるといちばん気づけないので、ここで必ず出す。 */}
      {calibrationAdvice(calibration) && (
        <div
          className="notice notice-warn"
          style={{
            flexDirection: 'column', alignItems: 'stretch', gap: 3,
            ...(calibrationGrade(calibration) === 'poor'
              ? { borderColor: 'rgba(239,68,68,0.45)', color: '#fca5a5' }
              : null),
          }}
        >
          <span>⚠ {calibrationAdvice(calibration)}</span>
          <span style={{ opacity: 0.8, fontSize: '0.73rem' }}>
            いまの基準: <span className="mono">{referenceLengthPx(calibration).toFixed(1)} px</span>
          </span>
        </div>
      )}

      {/* ---- 座標系 ---- */}
      <Card>
        <div
          className="switch"
          role="switch"
          aria-checked={calibration.yUp}
          onClick={() => onUpdateCalibration(recalcScale({ ...calibration, yUp: !calibration.yUp }))}
        >
          <div className={`switch__track ${calibration.yUp ? 'is-on' : ''}`}>
            <div className="switch__knob" />
          </div>
          <span className="switch__label">
            <ArrowUpDown size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Y軸を上向きにする（物理の座標系に合わせる）
          </span>
        </div>

        {/* 原点。指定は映像側の「原点」ツールで行う */}
        <div className="notice notice-info" style={{ marginTop: 10 }}>
          原点:{' '}
          {calibration.origin ? (
            <b className="mono">
              ({calibration.origin.x}, {calibration.origin.y}) px
            </b>
          ) : (
            <b>画像の{calibration.yUp ? '左下' : '左上'}（既定）</b>
          )}
          <div style={{ marginTop: 3, opacity: 0.85, fontSize: '0.73rem' }}>
            映像の
            <Target size={11} style={{ verticalAlign: -1, margin: '0 2px' }} />
            ボタンから、斜面の始点などを原点にできます。
            CSV の x, y がその点からの値になります。
          </div>
        </div>

        {calibration.origin && (
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
            onClick={() => onUpdateCalibration({ ...calibration, origin: null })}
          >
            <Eraser size={14} />
            原点を解除（画像の隅に戻す）
          </button>
        )}
      </Card>
    </>
  );
};
