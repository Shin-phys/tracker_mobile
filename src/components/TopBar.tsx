// src/components/TopBar.tsx
// 画面上端の細いバー。高さを稼ぐため情報は最小限に絞り、
// 詳しい状態はバッジ 2 つ（OpenCV の準備状況・記録点数）だけにした。

import React from 'react';
import { Target, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';

interface Props {
  isOpenCVReady: boolean;
  cvError?: string | null;
  activeCount: number;
  totalDataCount: number;
  fps: number;
}

export const TopBar: React.FC<Props> = ({
  isOpenCVReady, cvError, activeCount, totalDataCount, fps,
}) => (
  <header className="topbar">
    <div className="topbar__logo">
      <Target size={17} color="#fff" />
    </div>
    <div style={{ minWidth: 0 }}>
      <div className="topbar__title">MotionTrace</div>
      <div className="topbar__sub">
        {activeCount} obj ／ {fps.toFixed(1)} fps
      </div>
    </div>

    <div className="topbar__stats">
      {cvError ? (
        <span className="badge badge-danger" title={cvError}>
          <AlertTriangle size={11} />CV エラー
        </span>
      ) : isOpenCVReady ? (
        <span className="badge badge-ok"><CheckCircle2 size={11} />Ready</span>
      ) : (
        <span className="badge badge-warn"><Loader2 size={11} className="spin" />読込中</span>
      )}
      <span className="badge mono">{totalDataCount} pts</span>
    </div>
  </header>
);
