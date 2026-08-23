// src/components/sheets/ObjectsSheet.tsx
// 追跡する物体の追加・選択・状態確認。
// スマホでは「いま何を触っているか」が見えないと迷子になるので、
// 枠を置くための導線を最上部に大きく出している。

import React from 'react';
import { TrackedObject } from '../../types';
import { RECOMMENDED_ROI_SIZE } from '../../utils/tracker';
import { Card } from '../ui';
import type { StageTool } from '../VideoStage';
import {
  Plus, Trash2, RefreshCw, AlertTriangle, LogOut, CheckCircle, Square, Layers,
} from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  selectedObjId: string;
  onSelectObjId: (id: string) => void;
  onAddObject: () => void;
  onRemoveObject: (id: string) => void;
  onRecalibrateObject: (id: string) => void;
  setTool: (t: StageTool) => void;
  roiSize: number;
  setRoiSize: (n: number) => void;
  videoLoaded: boolean;
}

export const ObjectsSheet: React.FC<Props> = ({
  objects, selectedObjId, onSelectObjId, onAddObject, onRemoveObject,
  onRecalibrateObject, setTool, roiSize, setRoiSize, videoLoaded,
}) => {
  const active = objects.filter(o => o.active);
  const lost = active.filter(o => o.status === 'lost');
  const exited = active.filter(o => o.status === 'exited');
  const attention = [...lost, ...exited];

  return (
    <>
      {/* ---- 要対応 ---- */}
      {attention.length > 0 && (
        <div className={lost.length ? 'notice notice-danger' : 'notice notice-warn'}
          style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="row" style={{ fontWeight: 700 }}>
            {lost.length ? <AlertTriangle size={15} /> : <LogOut size={15} />}
            {lost.length
              ? `追跡ロスト — ${lost.length}個の枠を置き直してください`
              : `画面外へ退出 — ${exited.map(o => o.id).join(', ')} の追尾を終了しました`}
          </div>
          {attention.map(o => (
            <button
              key={o.id}
              className={`btn btn-sm ${o.status === 'lost' ? 'btn-danger' : 'btn-secondary'}`}
              style={{ justifyContent: 'flex-start' }}
              onClick={() => { onRecalibrateObject(o.id); setTool('roi'); }}
            >
              <span className="obj-swatch" style={{ background: o.color, width: 11, height: 11 }} />
              <RefreshCw size={12} />
              {o.name} の枠を置き直す
            </button>
          ))}
        </div>
      )}

      {/* ---- 枠の指定 ---- */}
      <Card title={<><Square size={16} color="var(--accent-primary)" />枠を指定する</>}>
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={!videoLoaded}
          onClick={() => setTool('roi')}
        >
          <Square size={16} />
          映像で {selectedObjId} の枠を置く
        </button>

        <div style={{ marginTop: 12 }}>
          <div className="row-between" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>タップで置く枠の大きさ</span>
            <span className="mono" style={{
              fontWeight: 700,
              color: roiSize < RECOMMENDED_ROI_SIZE ? 'var(--color-warning)' : 'var(--text-primary)',
            }}>
              {roiSize} px
            </span>
          </div>
          <input
            type="range" min={12} max={160} step={2} value={roiSize}
            onChange={e => setRoiSize(parseInt(e.target.value, 10))}
          />
        </div>

        <div className="hint">
          マーカーを<b>タップ</b>すると、その点を中心にこの大きさの枠が置かれます。
          囲むように<b>ドラッグ</b>しても構いません。
          枠は <b>{RECOMMENDED_ROI_SIZE}px 以上</b>にしてください。
          小さすぎる枠は画面のどこにでも一致してしまい、軌跡が暴走します。
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          <b>枠の中は、マーカーと一緒に動くものだけで埋めてください。</b>
          物体の面が広ければ枠を大きく取って構いませんが、動かない背景が入るぶんだけ
          精度が落ちます（合成データで実測。背景が入ると誤差が 13 倍）。
          背景を避けられない対象では、枠をマーカーぎりぎりまで詰めるのが正解です。
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          細かい位置合わせは<b>2本指でピンチ</b>して拡大してから行うと確実です。
        </div>
      </Card>

      {/* ---- 物体一覧 ---- */}
      <Card
        title={<><Layers size={16} color="var(--accent-primary)" />追跡オブジェクト ({active.length}/5)</>}
        right={
          <button className="btn btn-secondary btn-sm" onClick={onAddObject} disabled={active.length >= 5}>
            <Plus size={13} />追加
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {active.map(obj => {
            const sel = obj.id === selectedObjId;
            const small = !!obj.roi && Math.min(obj.roi.width, obj.roi.height) < RECOMMENDED_ROI_SIZE;
            return (
              <div
                key={obj.id}
                className={`obj-row ${sel ? 'is-selected' : ''}`}
                style={{
                  color: sel ? obj.color : undefined,
                  background: sel ? `${obj.color}18` : undefined,
                  opacity: obj.status === 'exited' ? 0.72 : 1,
                }}
                onClick={() => onSelectObjId(obj.id)}
              >
                <div className={`status-dot ${obj.status}`} />
                <div className="obj-swatch" style={{ background: obj.color }} />
                <div style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{obj.name}</div>
                  <div style={{
                    fontSize: '0.71rem',
                    color: small ? 'var(--color-warning)' : 'var(--text-secondary)',
                    fontWeight: small ? 700 : 400,
                  }}>
                    {obj.roi
                      ? `枠 ${Math.round(obj.roi.width)}×${Math.round(obj.roi.height)}px${small ? ' ⚠小' : ''}`
                      : '枠未指定'}
                  </div>
                </div>

                {obj.status === 'lost' ? (
                  <span className="badge badge-danger"><AlertTriangle size={10} />LOST</span>
                ) : obj.status === 'exited' ? (
                  <span className="badge badge-warn"><LogOut size={10} />EXIT</span>
                ) : obj.status === 'tracking' ? (
                  <span className="badge badge-ok"><CheckCircle size={10} />OK</span>
                ) : null}

                <button
                  className="btn btn-secondary btn-icon btn-sm"
                  aria-label="枠を置き直す"
                  onClick={e => { e.stopPropagation(); onRecalibrateObject(obj.id); setTool('roi'); }}
                >
                  <RefreshCw size={13} />
                </button>

                {active.length > 1 && (
                  <button
                    className="btn btn-danger btn-icon btn-sm"
                    aria-label="削除"
                    onClick={e => { e.stopPropagation(); onRemoveObject(obj.id); }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
};
