// src/components/GuideBar.tsx
// ============================================================
// ガイド — 次にやることだけを 1 行で出す。
//
// 設計の芯：**状態から導くだけで、別の状態を持たない。**
//   「今どのステップか」を自分で覚えると、利用者が順番を飛ばしたときや
//   やり直したときに必ず食い違う（ステップ 5 を表示しながら枠が無い、
//   のような状態が作れてしまう）。ここでは毎回アプリの状態を見て
//   「まだ終わっていない最初のこと」を出す。だから「次へ」ボタンが要らない。
//   やれば勝手に進み、やり直せば勝手に戻る。
//
// 高さは 1 行ぶんに抑える。スマホでは映像とグラフの場所がいちばん貴重で、
// 常時出る案内がそれを奪うと、ガイド自体が邪魔者になる。
// ============================================================

import React from 'react';
import { ChevronRight, X, Check } from 'lucide-react';

export interface GuideStep {
  id: string;
  /** 1 行で出す「やること」 */
  what: string;
  done: boolean;
  /** とばせる手順か（速い対象だけに必要、など） */
  optional?: boolean;
  /** 押したときに開く場所 */
  go?: () => void;
}

interface Props {
  steps: GuideStep[];
  /** とばした手順の id */
  skipped: string[];
  onSkip: (id: string) => void;
  onClose: () => void;
}

export const GuideBar: React.FC<Props> = ({ steps, skipped, onSkip, onClose }) => {
  const total = steps.length;
  const doneCount = steps.filter(s => s.done || skipped.includes(s.id)).length;
  const current = steps.find(s => !s.done && !skipped.includes(s.id));

  if (!current) {
    return (
      <div className="guidebar guidebar--done">
        <Check size={14} />
        <span className="guidebar__what">ひと通り終わりました。解析タブで数値を出せます</span>
        <button className="guidebar__x" aria-label="ガイドを閉じる" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="guidebar">
      <span className="guidebar__step">{doneCount + 1}/{total}</span>
      <button
        className="guidebar__what guidebar__go"
        onClick={current.go}
        disabled={!current.go}
      >
        {current.what}
        {current.go && <ChevronRight size={13} />}
      </button>
      {current.optional && (
        <button className="guidebar__skip" onClick={() => onSkip(current.id)}>
          とばす
        </button>
      )}
      <button className="guidebar__x" aria-label="ガイドを閉じる" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
};
