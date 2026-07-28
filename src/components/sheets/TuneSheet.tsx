// src/components/sheets/TuneSheet.tsx
// FPS と追跡アルゴリズムの設定。
// 詳細設定は既定で畳んでおき、スマホの狭い画面を圧迫しないようにする。

import React, { useState } from 'react';
import {
  FpsSettings, TrackingSettings, MarkerMode, DEFAULT_TRACKING,
} from '../../types';
import { Card, Slider, Switch } from '../ui';
import { Timer, Settings2, RotateCcw, Eraser, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  fpsSettings: FpsSettings;
  onUpdateFpsSettings: (f: FpsSettings) => void;
  tracking: TrackingSettings;
  onUpdateTracking: (t: TrackingSettings) => void;
  onResetData: () => void;
}

const MARKER_MODES: { id: MarkerMode; label: string }[] = [
  { id: 'white', label: '白いマーカー' },
  { id: 'dark', label: '黒いマーカー' },
];

export const TuneSheet: React.FC<Props> = ({
  fpsSettings, onUpdateFpsSettings, tracking, onUpdateTracking, onResetData,
}) => {
  const [advanced, setAdvanced] = useState(false);

  return (
    <>
      {/* ---- FPS ---- */}
      <Card title={<><Timer size={16} color="var(--accent-primary)" />FPS 設定</>}>
        <div className={`notice ${fpsSettings.source === 'auto' ? 'notice-info' : 'notice-warn'}`}>
          {fpsSettings.source === 'auto'
            ? `自動計測中 — 再生すると実フレーム間隔から更新されます（現在 ${fpsSettings.value.toFixed(2)} fps）`
            : '手動入力（自動計測は行いません）'}
        </div>

        <div style={{ marginTop: 10 }}>
          <input
            type="number" inputMode="decimal" step="0.001" min="1" max="1000"
            className="num-lg"
            value={fpsSettings.value}
            onFocus={e => e.currentTarget.select()}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (v > 0) onUpdateFpsSettings({ value: v, source: 'manual' });
            }}
          />
        </div>

        <div className="chips" style={{ marginTop: 9 }}>
          {[24, 25, 30, 60, 120, 240].map(f => (
            <button
              key={f}
              className={`chip ${Math.abs(fpsSettings.value - f) < 0.01 ? 'is-active' : ''}`}
              onClick={() => onUpdateFpsSettings({ value: f, source: 'manual' })}
            >
              {f}
            </button>
          ))}
          <button
            className={`chip ${fpsSettings.source === 'auto' ? 'is-active' : ''}`}
            onClick={() => onUpdateFpsSettings({ ...fpsSettings, source: 'auto' })}
          >
            自動
          </button>
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          速度計算には動画本来のタイムスタンプを直接使うため、この値がずれても速度の精度には影響しません。
          コマ送りの刻み幅と表示に使われます。
        </div>
      </Card>

      {/* ---- 追跡の詳細設定 ---- */}
      <Card
        title={<><Settings2 size={16} color="var(--accent-primary)" />追跡の詳細設定</>}
        right={
          <button className="btn btn-secondary btn-sm" onClick={() => setAdvanced(v => !v)}>
            {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {advanced ? '閉じる' : '開く'}
          </button>
        }
      >
        {!advanced ? (
          <div className="hint">
            サブピクセル補間 {tracking.subpixel ? 'ON' : 'OFF'} ／
            探索範囲 {tracking.searchScale.toFixed(1)}× ／
            ロスト判定 {tracking.lostThreshold.toFixed(2)}
          </div>
        ) : (
          <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Switch
              checked={tracking.subpixel}
              onChange={v => onUpdateTracking({ ...tracking, subpixel: v })}
              label="サブピクセル補間（強く推奨）"
              hint={<>相関ピーク近傍に2次曲面をあてはめ、1px より細かい位置を求めます。
                実測でガタつきが 1.06px → 0.35px に低減しました。</>}
            />

            <Switch
              checked={tracking.centroidRefine}
              onChange={v => onUpdateTracking({ ...tracking, centroidRefine: v })}
              label="マーカー重心での追加補正（上級者向け）"
              hint={<>マーカーが背景から色ではっきり分離できる場合だけ有効です。
                背景が明るい／マーカーが小さい映像ではむしろ悪化します。既定は OFF。</>}
            />

            {tracking.centroidRefine && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="segmented" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  {MARKER_MODES.map(m => (
                    <button
                      key={m.id}
                      className={`btn ${tracking.markerMode === m.id ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => onUpdateTracking({ ...tracking, markerMode: m.id })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <Slider
                  label="重心のしきい値"
                  value={tracking.centroidLevel}
                  display={tracking.centroidLevel.toFixed(2)}
                  min={0.2} max={0.8} step={0.05}
                  onChange={v => onUpdateTracking({ ...tracking, centroidLevel: v })}
                  hint="高いほどマーカーの芯だけを使います"
                />
              </div>
            )}

            <Slider
              label="ロスト判定の厳しさ"
              value={tracking.lostThreshold}
              display={tracking.lostThreshold.toFixed(2)}
              min={0.2} max={0.8} step={0.05}
              onChange={v => onUpdateTracking({ ...tracking, lostThreshold: v })}
              hint="高いほど「見失った」と判定しやすくなります"
            />

            <Slider
              label="探索範囲"
              value={tracking.searchScale}
              display={`${tracking.searchScale.toFixed(1)}×`}
              min={0.6} max={4} step={0.2}
              onChange={v => onUpdateTracking({ ...tracking, searchScale: v })}
              hint="速く動く対象では大きめに。大きいほど処理は重くなります（スマホでは 1.8 前後を推奨）"
            />

            <Switch
              checked={tracking.stopOnExit}
              onChange={v => onUpdateTracking({ ...tracking, stopOnExit: v })}
              label="画面外に出たら、その物体の追尾を打ち切る"
            />

            {tracking.stopOnExit && (
              <Slider
                label="画面外と判定する余白"
                value={tracking.exitMargin}
                display={`${tracking.exitMargin} px`}
                min={0} max={40} step={1}
                onChange={v => onUpdateTracking({ ...tracking, exitMargin: Math.round(v) })}
              />
            )}

            <button
              className="btn btn-secondary"
              onClick={() => onUpdateTracking({ ...DEFAULT_TRACKING })}
            >
              <RotateCcw size={14} />既定値に戻す
            </button>
          </div>
        )}
      </Card>

      {/* ---- 全消去 ---- */}
      <Card title="データの初期化">
        <button className="btn btn-danger" style={{ width: '100%' }} onClick={onResetData}>
          <Eraser size={16} />枠と記録をすべて消去
        </button>
        <div className="hint" style={{ marginTop: 8 }}>
          軌跡だけ消して枠を残したいときは、再生バーの「先頭へ戻す」を使ってください。
        </div>
      </Card>
    </>
  );
};
