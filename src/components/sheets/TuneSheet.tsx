// src/components/sheets/TuneSheet.tsx
// 追跡アルゴリズムの設定。
// 詳細設定は既定で畳んでおき、スマホの狭い画面を圧迫しないようにする。
//
// 撮影 fps（時間軸の換算）はここではなくデータタブにある。
// 数値が合うかどうかを見ながら決める設定なので、CSV とグラフの隣に置くほうが
// 迷わない（実際、240fps で撮っていても 120 を入れたほうが合う、という
// ことが起きる。説明より、出てくる秒数を見て合わせるほうが確実）。

import React, { useState } from 'react';
import {
  TrackingSettings, MarkerMode, DEFAULT_TRACKING, ColorKey,
} from '../../types';
import { describeKey } from '../../utils/colorKey';
import { Card, Slider, Switch } from '../ui';
import { Settings2, RotateCcw, Eraser, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  /** 次にやることを 1 行で出す帯を表示するか */
  guideOn: boolean;
  onChangeGuideOn: (v: boolean) => void;
  tracking: TrackingSettings;
  onUpdateTracking: (t: TrackingSettings) => void;
  /** 選んでいる物体の彩度の鍵。枠を置くと実測で入る */
  colorKey: ColorKey | null;
  /** 枠を置き終えているか（鍵が無い理由の出し分けに使う） */
  hasRoi: boolean;
  onUpdateColorKey: (key: ColorKey) => void;
  onResetData: () => void;
}

const MARKER_MODES: { id: MarkerMode; label: string }[] = [
  { id: 'white', label: '白いマーカー' },
  { id: 'dark', label: '黒いマーカー' },
];

export const TuneSheet: React.FC<Props> = ({
  tracking, onUpdateTracking, onResetData, guideOn, onChangeGuideOn,
  colorKey, hasRoi, onUpdateColorKey,
}) => {
  const [advanced, setAdvanced] = useState(false);

  return (
    <>
      <Card title="ガイド">
        <Switch
          checked={guideOn}
          onChange={onChangeGuideOn}
          label="次にやることを画面の上に出す"
          hint="状態から導いているだけなので、順番を飛ばしても勝手に追いつきます"
        />
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
            彩度で絞る {tracking.useColorKey ? (colorKey ? 'ON' : '測定なし') : 'OFF'} ／
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
              label="探索範囲（上限）"
              value={tracking.searchScale}
              display={`${tracking.searchScale.toFixed(1)}×`}
              min={0.4} max={4} step={0.2}
              onChange={v => onUpdateTracking({ ...tracking, searchScale: v })}
              hint="普段の窓は動きの変化から自動で決まります。ここはその上限（既定 1.0×）。目印を使っているなら小さいほうが有利です。広い窓は似た模様に乗り移る機会を増やすだけで、追跡の役には立ちません"
            />

            <Switch
              checked={tracking.useColorKey}
              onChange={v => onUpdateTracking({ ...tracking, useColorKey: v })}
              label="彩度で絞る"
              hint={<>彩度が合わない画素を照合から外します。周囲の模様が消えるので、
                似た明るさのものに乗り移りにくくなります。対象のほうが彩度が高いのか
                低いのかは、枠を置いたときに実測して決めます。</>}
            />

            {tracking.useColorKey && (
              colorKey ? (
                <Slider
                  label="彩度のしきい値"
                  value={Math.round(colorKey.thr)}
                  display={`${Math.round(colorKey.thr)}`}
                  min={0} max={255} step={1}
                  onChange={v => onUpdateColorKey({ ...colorKey, thr: v })}
                  hint={`${describeKey(colorKey)}。暴れるときは、対象だけが残る側へ`
                    + '寄せてください。動かすとテンプレートを作り直すので、'
                    + 'やり直してから再生します'}
                />
              ) : (
                <div className="hint">
                  {hasRoi
                    ? 'この枠では彩度で分けられませんでした。輝度だけで追跡しています。'
                    : '枠を置くと、対象と周囲の彩度を測ります。'}
                </div>
              )
            )}

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
          軌跡だけ消して枠を残したいときは、再生バーの「やり直し」（↺）を使ってください。
        </div>
      </Card>
    </>
  );
};
