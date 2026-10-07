// src/components/sheets/TrimSheet.tsx
// 解析区間（トリム）。作業の最初の一歩として独立させている。
//
// なぜ最初に置くか
//   「終点を決める → 始点へ戻る → そのコマで枠を置く」の順に進めると、
//   枠を置いたコマと区間の始点が一致する。警告で後追いしていた事故が、
//   手順だけで起きなくなる。
//
// なぜ再生バーから出したか
//   始点・終点の操作は、動画を見ながらの数十秒だけ必要になる。
//   それがどのタブでも出続けていたので、映像とグラフの場所を
//   常時奪っていた（スマホでは致命的に効く）。

import React from 'react';
import { TrackedObject, FrameData, FpsSettings } from '../../types';
import {
  TimeRange, FULL_RANGE, hasRange, rangeSpan, countInRange,
  MIN_RANGE_POINTS, earliestRoiTime, restartTimeFor,
} from '../../utils/timeRange';
import { timeScale } from '../../utils/timeScale';
import { Card } from '../ui';
import { Scissors, XCircle } from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  timeRange: TimeRange;
  onChangeTimeRange: (r: TimeRange) => void;
  duration: number;
  historyData: FrameData[];
  fpsSettings: FpsSettings;
  videoLoaded: boolean;
}

export const TrimSheet: React.FC<Props> = ({
  objects, timeRange, onChangeTimeRange, duration, historyData, fpsSettings, videoLoaded,
}) => {
  const active = hasRange(timeRange);
  const spanSec = rangeSpan(timeRange, duration);
  const spanReal = spanSec * timeScale(fpsSettings);
  const points = countInRange(historyData, timeRange);
  const tooFew = active && points > 0 && points < MIN_RANGE_POINTS;

  const roiTimes = objects
    .filter(o => o.active && o.initialTime !== null)
    .map(o => o.initialTime as number);
  const roiStart = earliestRoiTime(roiTimes);
  const restart = restartTimeFor(timeRange, roiTimes);

  if (!videoLoaded) {
    return (
      <div className="notice notice-info">
        先に動画を選んでください。
      </div>
    );
  }

  return (
    <>
      <Card title={<><Scissors size={16} color="var(--accent-primary)" />解析区間</>}>
        <div className="row-between" style={{ fontSize: '0.9rem' }}>
          <span>いまの区間</span>
          <b className="mono">
            {active ? (
              <>
                {timeRange.start !== null ? timeRange.start.toFixed(2) : '先頭'}
                〜
                {timeRange.end !== null ? timeRange.end.toFixed(2) : '末尾'} s
              </>
            ) : '動画全体'}
          </b>
        </div>
        {active && spanSec > 0 && (
          <div className="hint" style={{ marginTop: 4 }}>
            長さ {spanSec.toFixed(2)} s
            {Math.abs(spanReal - spanSec) > 1e-6 && <>（実時間 {spanReal.toFixed(2)} s）</>}
            {historyData.length > 0 && <>・区間内 {points} 点</>}
          </div>
        )}
        {active && (
          <button
            className="btn btn-secondary"
            style={{ width: '100%', marginTop: 10 }}
            onClick={() => onChangeTimeRange(FULL_RANGE)}
          >
            <XCircle size={15} />区間を解除して動画全体に戻す
          </button>
        )}
      </Card>

      <Card title="進め方">
        <ol style={{ margin: 0, paddingLeft: '1.2em', lineHeight: 1.9, fontSize: '0.84rem' }}>
          <li>映像の下の <b>▶</b> と <b>◀▶</b> で、使いたい<b>終わりのコマ</b>まで送る</li>
          <li><b>終点</b> を押す</li>
          <li><b>始点へ</b>（⏮）で戻り、使いたい<b>始まりのコマ</b>で <b>始点</b> を押す</li>
          <li>そのコマのまま、<b>対象</b>タブへ進んで枠を置く</li>
        </ol>
        <div className="hint" style={{ marginTop: 8 }}>
          始点・終点のボタンは、このタブを開いている間だけ映像の下に出ます。
          4 のときにコマを動かさないでください。枠を置いたコマと始点がずれると、
          始点のコマに物体がいない＝追跡が始まらない、という状態になります。
        </div>
      </Card>

      <Card title="何に効くか">
        <div className="hint" style={{ lineHeight: 1.7 }}>
          区間の外は<b>追跡も記録もしません</b>。終点で自動的に停止します。
          グラフ・フィルタ・CSV も、この区間のデータだけを使います。
          <br />
          頭の準備時間や着地後の跳ね返りを外すと、平滑化の自動遮断周波数が
          運動している区間だけを見るようになり、数値が安定します。
          <br />
          あとから狭めるのは<b>非破壊</b>です。記録は残っているので、広げれば元に戻ります。
        </div>
      </Card>

      {tooFew && (
        <div className="notice notice-warn">
          ⚠ 区間内が {points} 点しかありません。{MIN_RANGE_POINTS} 点を切ると
          Butterworth の遮断周波数の自動選択が不安定になります。区間を広げるか、
          撮影 fps を上げてください。
        </div>
      )}

      <div className="hint">
        いま「やり直し」で戻る先は <b className="mono">{restart.toFixed(3)} s</b> です
        {timeRange.start !== null
          ? '（区間の始点）'
          : roiStart !== null ? '（枠を置いたコマ）' : '（動画の先頭）'}。
      </div>
    </>
  );
};
