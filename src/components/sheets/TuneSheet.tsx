// src/components/sheets/TuneSheet.tsx
// FPS と追跡アルゴリズムの設定。
// 詳細設定は既定で畳んでおき、スマホの狭い画面を圧迫しないようにする。

import React, { useState } from 'react';
import {
  FpsSettings, TrackingSettings, MarkerMode, DEFAULT_TRACKING,
} from '../../types';
import { Card, Slider, Switch } from '../ui';
import { CAPTURE_FPS_PRESETS, describeTimeScale, isTimeScaled } from '../../utils/timeScale';
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
      {/* ---- フレームレートと時間軸 ---- */}
      <Card title={<><Timer size={16} color="var(--accent-primary)" />フレームレートと時間軸</>}>
        <div className="notice notice-info">
          ファイルのfps: <b>{fpsSettings.value.toFixed(2)} fps</b>（自動計測）
          <div style={{ marginTop: 3, opacity: 0.85 }}>
            再生すると実フレーム間隔から自動で決まります。コマ送りの刻み幅に使われます。
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: '0.81rem', color: 'var(--text-secondary)' }}>
          撮影fps（スロー動画のときに指定）
        </div>
        <div style={{ marginTop: 5 }}>
          <input
            type="number" inputMode="numeric" step="1" min="0" max="2000"
            className="num-lg"
            value={fpsSettings.captureFps || ''}
            placeholder="未指定（通常の動画）"
            onFocus={e => e.currentTarget.select()}
            onChange={e => {
              const v = parseFloat(e.target.value);
              onUpdateFpsSettings({
                ...fpsSettings,
                captureFps: isFinite(v) && v > 0 ? v : 0,
              });
            }}
          />
        </div>

        <div className="chips" style={{ marginTop: 9 }}>
          <button
            className={`chip ${!fpsSettings.captureFps ? 'is-active' : ''}`}
            onClick={() => onUpdateFpsSettings({ ...fpsSettings, captureFps: 0 })}
          >
            通常
          </button>
          {CAPTURE_FPS_PRESETS.map(f => (
            <button
              key={f}
              className={`chip ${Math.abs(fpsSettings.captureFps - f) < 0.01 ? 'is-active' : ''}`}
              onClick={() => onUpdateFpsSettings({ ...fpsSettings, captureFps: f })}
            >
              {f}
            </button>
          ))}
        </div>

        <div
          className={`notice ${isTimeScaled(fpsSettings) ? 'notice-warn' : 'notice-info'}`}
          style={{ marginTop: 10 }}
        >
          時間軸: <b>{describeTimeScale(fpsSettings)}</b>
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          240fps で撮って 30fps で書き出したスロー動画なら「撮影fps = 240」。
          グラフと CSV の時刻・速度がこの倍率で実時間に直されます。
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
