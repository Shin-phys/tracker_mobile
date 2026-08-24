// src/components/sheets/DataSheet.tsx
// 計測値の表示・平滑化フィルタ・CSV 書き出し。
//
// 計算内容は Ver.2 の DataPanel と同一（中心差分による速度、
// Butterworth 零位相 / Savitzky-Golay の平滑化）。
// 変更点は表示レイアウトと、スマホからのファイル取り出し手段。
// iOS では <a download> がファイルアプリに入らないことがあるので、
// Web Share API が使えるときは共有シート経由も選べるようにした。

import React, { useCallback, useMemo, useState } from 'react';
import {
  TrackedObject, FrameData, FilterSettings, ScaleCalibration, FpsSettings,
} from '../../types';
import { timeScale, isTimeScaled, toFileTime } from '../../utils/timeScale';
import {
  applySavitzkyGolay, sgWindowSeconds, recommendSgWindow, SG_WINDOW_WARN_SEC,
} from '../../utils/savitzkyGolay';
import { autoFilter, butterworthZeroPhase, derivative, medianDt } from '../../utils/butterworth';
import { outputUnit } from '../../utils/calibration';
import { smoothSeries } from '../../utils/graphSmooth';
import {
  TimeRange, clipToRange, hasRange, MIN_RANGE_POINTS,
} from '../../utils/timeRange';
import { Card, Slider, Switch } from '../ui';
import { GraphPanel } from '../GraphPanel';
import { AxisKey } from '../MotionGraph';
import {
  Download, Share2, Sliders, Activity, ArrowRightLeft, ChevronDown, ChevronUp,
  LineChart, Maximize2, X, Scissors,
} from 'lucide-react';

interface Props {
  objects: TrackedObject[];
  historyData: FrameData[];
  /** 解析区間。ここで絞られたデータだけがグラフ・フィルタ・CSV に入る */
  timeRange: TimeRange;
  filterSettings: FilterSettings;
  onUpdateFilterSettings: (s: FilterSettings) => void;
  calibration: ScaleCalibration;
  /** 時間軸の換算（スロー動画対応）に使う */
  fpsSettings: FpsSettings;
  /** グラフをタップしたとき、その時刻へ動画をシークする */
  onSeek?: (t: number) => void;
  /** グラフの軸の選択。シートを閉じても保つよう App が持っている */
  graphX: AxisKey;
  graphY: AxisKey;
  onChangeGraphX: (k: AxisKey) => void;
  onChangeGraphY: (k: AxisKey) => void;
  hiddenGraphIds: string[];
  onToggleGraphId: (id: string) => void;

  /** グラフ表示だけにかける追加の平滑化（CSV には影響しない） */
  graphSmooth: boolean;
  graphSmoothWindow: number;
  onChangeGraphSmooth: (on: boolean) => void;
  onChangeGraphSmoothWindow: (w: number) => void;
}

export const DataSheet: React.FC<Props> = ({
  objects, historyData: historyDataAll, timeRange,
  filterSettings, onUpdateFilterSettings, calibration,
  fpsSettings, onSeek,
  graphX, graphY, onChangeGraphX, onChangeGraphY, hiddenGraphIds, onToggleGraphId,
  graphSmooth, graphSmoothWindow, onChangeGraphSmooth, onChangeGraphSmoothWindow,
}) => {
  /**
   * 区間で絞ったデータ。以降の処理はすべてこちらを見る。
   * 記録側でも区間外は弾いているので通常はここで減らない。効くのは
   * 「一度記録したあとで区間を狭めた」場合で、取り直さずに追随する。
   * 記録そのものは残るので、区間を広げれば戻る（非破壊）。
   */
  const historyData = useMemo(
    () => clipToRange(historyDataAll, timeRange),
    [historyDataAll, timeRange]
  );
  const clippedCount = historyDataAll.length - historyData.length;
  const tooFewInRange =
    hasRange(timeRange) && historyData.length > 0 && historyData.length < MIN_RANGE_POINTS;

  const activeObjects = useMemo(() => objects.filter(o => o.active), [objects]);
  const [showFilter, setShowFilter] = useState(false);
  // 出力は m に統一する（校正の入力単位が cm でも、記録される値は m）
  const unitLabel = outputUnit(calibration);
  const [graphFull, setGraphFull] = useState(false);

  // -------------------------------------------------
  // 平滑化と速度の再計算
  // -------------------------------------------------

  const { processedData, report } = useMemo(() => {
    const cutoffs: { [id: string]: number } = {};
    if (historyData.length === 0) {
      return { processedData: historyData, report: { cutoffs, sampleRate: 0 } };
    }

    // ここで時刻を実時間へ換算する。historyData 側は「ファイル上の時刻」の
    // ままにしてあるので、撮影fps を後から直しても追跡をやり直さずに済む。
    // 換算はこの 1 箇所だけ。以降の速度・フィルタ・グラフ・CSV は
    // すべてこの copyData の時刻を見るので、自動的に実時間になる。
    const scale = timeScale(fpsSettings);
    const copyData: FrameData[] = historyData.map(fd => ({
      frameIndex: fd.frameIndex,
      timestamp: fd.timestamp * scale,
      objects: Object.fromEntries(Object.entries(fd.objects).map(([k, v]) => [k, { ...v }])),
      distances: { ...fd.distances },
    }));

    const dtAll = medianDt(copyData.map(f => f.timestamp));
    const sampleRate = dtAll > 0 ? 1 / dtAll : 0;

    activeObjects.forEach(obj => {
      const idx: number[] = [];
      for (let i = 0; i < copyData.length; i++) {
        if (copyData[i].objects[obj.id]) idx.push(i);
      }
      if (idx.length === 0) return;

      const rawX = idx.map(i => copyData[i].objects[obj.id].xM);
      const rawY = idx.map(i => copyData[i].objects[obj.id].yM);
      const t = idx.map(i => copyData[i].timestamp);
      const dt = medianDt(t);

      let sx = rawX;
      let sy = rawY;

      if (filterSettings.enabled && filterSettings.kind === 'butterworth' && dt > 0) {
        if (filterSettings.autoCutoff) {
          const rx = autoFilter(rawX, dt);
          const ry = autoFilter(rawY, dt);
          sx = rx.values;
          sy = ry.values;
          cutoffs[obj.id] = (rx.cutoff + ry.cutoff) / 2;
        } else {
          sx = butterworthZeroPhase(rawX, dt, filterSettings.cutoffHz);
          sy = butterworthZeroPhase(rawY, dt, filterSettings.cutoffHz);
          cutoffs[obj.id] = filterSettings.cutoffHz;
        }
      } else if (filterSettings.enabled && filterSettings.kind === 'savgol') {
        sx = applySavitzkyGolay(rawX, filterSettings.windowSize, filterSettings.polynomialOrder);
        sy = applySavitzkyGolay(rawY, filterSettings.windowSize, filterSettings.polynomialOrder);
      }

      const vxs = derivative(sx, t);
      const vys = derivative(sy, t);

      for (let k = 0; k < idx.length; k++) {
        const item = copyData[idx[k]].objects[obj.id];
        item.xM = sx[k];
        item.yM = sy[k];
        item.vx = vxs[k];
        item.vy = vys[k];
        item.speedMs = Math.hypot(vxs[k], vys[k]);
      }
    });

    copyData.forEach(fd => {
      for (let i = 0; i < activeObjects.length; i++) {
        for (let j = i + 1; j < activeObjects.length; j++) {
          const idA = activeObjects[i].id;
          const idB = activeObjects[j].id;
          const a = fd.objects[idA];
          const b = fd.objects[idB];
          if (a && b && !a.lost && !b.lost) {
            fd.distances[`${idA}-${idB}`] = Math.hypot(a.xM - b.xM, a.yM - b.yM);
          }
        }
      }
    });

    return { processedData: copyData, report: { cutoffs, sampleRate } };
  }, [historyData, filterSettings, activeObjects, fpsSettings]);

  /**
   * グラフのタップから動画へシークするときは、実時間 → ファイル上の時刻へ
   * 戻す必要がある。ここを忘れるとスロー動画で 8 倍ずれた位置へ飛ぶ。
   */
  const handleGraphSeek = useCallback(
    (t: number) => { onSeek?.(toFileTime(t, fpsSettings)); },
    [onSeek, fpsSettings]
  );

  /** 記録されている実時間の長さ（換算が効いているかの確認用） */
  const realSpan = processedData.length > 1
    ? processedData[processedData.length - 1].timestamp - processedData[0].timestamp
    : 0;

  // -------------------------------------------------
  // グラフ表示用の追加平滑化
  // -------------------------------------------------
  //
  // 位置 x, y を均し、速度は「均した位置」から中心差分で取り直す。
  // 速度をそのまま平均すると、位置と速度が別々の量になってしまい
  // 「この x-t の傾きがこの vx-t」という対応が崩れる。
  //
  // 平滑化するのはグラフに渡すデータだけで、
  // processedData（CSV と計測値カードの元）には手を触れない。

  const graphData = useMemo(() => {
    if (!graphSmooth || graphSmoothWindow < 5 || processedData.length === 0) {
      return processedData;
    }

    const copy: FrameData[] = processedData.map(fd => ({
      frameIndex: fd.frameIndex,
      timestamp: fd.timestamp,
      objects: Object.fromEntries(
        Object.entries(fd.objects).map(([k, v]) => [k, { ...v }])
      ),
      distances: { ...fd.distances },
    }));

    activeObjects.forEach(obj => {
      // 見失った区間をまたいで均すと、追跡が飛んだ事実が消えてしまう。
      // 連続して追跡できているフレームの塊ごとに処理する。
      let run: number[] = [];

      const flush = () => {
        // 窓より短い塊は smoothSeries が素通しするので、そのまま渡してよい
        if (run.length >= 3) {
          const t = run.map(i => copy[i].timestamp);
          const sx = smoothSeries(
            run.map(i => copy[i].objects[obj.id].xM), graphSmoothWindow
          );
          const sy = smoothSeries(
            run.map(i => copy[i].objects[obj.id].yM), graphSmoothWindow
          );
          const vxs = derivative(sx, t);
          const vys = derivative(sy, t);
          run.forEach((fi, k) => {
            const it = copy[fi].objects[obj.id];
            it.xM = sx[k];
            it.yM = sy[k];
            it.vx = vxs[k];
            it.vy = vys[k];
            it.speedMs = Math.hypot(vxs[k], vys[k]);
          });
        }
        run = [];
      };

      for (let i = 0; i < copy.length; i++) {
        const it = copy[i].objects[obj.id];
        if (it && !it.lost) run.push(i);
        else flush();
      }
      flush();
    });

    return copy;
  }, [processedData, graphSmooth, graphSmoothWindow, activeObjects]);

  const latest = processedData.length > 0 ? processedData[processedData.length - 1] : null;

  // -------------------------------------------------
  // CSV
  // -------------------------------------------------

  const buildCsv = (): string => {
    const u = outputUnit(calibration);
    const headers: string[] = ['Timestamp(s)'];

    activeObjects.forEach(obj => {
      headers.push(
        `${obj.id}_X(px)`, `${obj.id}_Y(px)`,
        `${obj.id}_X(${u})`, `${obj.id}_Y(${u})`,
        `${obj.id}_Vx(${u}/s)`, `${obj.id}_Vy(${u}/s)`, `${obj.id}_Speed(${u}/s)`,
        `${obj.id}_Score`, `${obj.id}_Lost`, `${obj.id}_Manual`,
      );
    });
    for (let i = 0; i < activeObjects.length; i++) {
      for (let j = i + 1; j < activeObjects.length; j++) {
        headers.push(`Dist_${activeObjects[i].id}_${activeObjects[j].id}(${u})`);
      }
    }

    const rows: string[] = [headers.join(',')];
    processedData.forEach(fd => {
      const row: (string | number)[] = [fd.timestamp.toFixed(6)];
      activeObjects.forEach(obj => {
        const it = fd.objects[obj.id];
        if (it) {
          row.push(
            it.xPx.toFixed(3), it.yPx.toFixed(3),
            it.xM.toFixed(6), it.yM.toFixed(6),
            it.vx.toFixed(6), it.vy.toFixed(6), it.speedMs.toFixed(6),
            it.score.toFixed(3), it.lost ? '1' : '0', it.manual ? '1' : '0',
          );
        } else {
          row.push('', '', '', '', '', '', '', '', '', '');
        }
      });
      for (let i = 0; i < activeObjects.length; i++) {
        for (let j = i + 1; j < activeObjects.length; j++) {
          const d = fd.distances[`${activeObjects[i].id}-${activeObjects[j].id}`];
          row.push(d !== undefined ? d.toFixed(5) : '');
        }
      }
      rows.push(row.join(','));
    });

    // BOM 付き UTF-8（Excel で文字化けしないように）
    return '\uFEFF' + rows.join('\n');
  };

  const fileName = () =>
    `motion_trace_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;

  const downloadCSV = () => {
    if (processedData.length === 0) return;
    const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // -------------------------------------------------
  // 位置だけの CSV（平滑化前の生の値）
  // -------------------------------------------------
  //
  // 速度を自分で求める過程そのものが学習の中身なので、速度も加速度も出さない。
  // 平滑化もかけない。平滑化後の位置を渡すと、そこから求めた速度は
  // 「こちらのフィルタの結果」を引き継いだものになり、差分を取るとなぜノイズが
  // 荒れるのか、なぜ平滑化が要るのかを手を動かして確かめられなくなる。
  // そのぶん、この値は画面のグラフとは一致しない。

  const buildPositionCsv = (): string => {
    const scale = timeScale(fpsSettings);
    const u = outputUnit(calibration);
    const headers = [
      'Timestamp(s)',
      ...activeObjects.flatMap(o => [`${o.id}_X(${u})`, `${o.id}_Y(${u})`]),
    ];
    const rows: string[] = [headers.join(',')];
    historyData.forEach(fd => {
      const row: string[] = [(fd.timestamp * scale).toFixed(6)];
      activeObjects.forEach(o => {
        const it = fd.objects[o.id];
        // 見失ったコマは空欄にする。0 を入れると原点に居たように読めてしまう
        if (!it || it.lost) row.push('', '');
        else row.push(it.xM.toFixed(6), it.yM.toFixed(6));
      });
      rows.push(row.join(','));
    });
    return '\uFEFF' + rows.join('\n');
  };

  const positionFileName = () =>
    `motion_position_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;

  const downloadPositionCSV = () => {
    if (historyData.length === 0) return;
    const blob = new Blob([buildPositionCsv()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = positionFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sharePositionCSV = async () => {
    if (historyData.length === 0) return;
    try {
      const file = new File([buildPositionCsv()], positionFileName(), { type: 'text/csv' });
      const nav = navigator as any;
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: 'MotionTrace 位置データ' });
        return;
      }
    } catch (err) {
      console.warn('[DataSheet] 共有できませんでした:', err);
    }
    downloadPositionCSV();
  };

  /** 共有シート経由でファイルを渡す（iOS ではこちらの方が確実） */
  const canShare = typeof navigator !== 'undefined' && 'canShare' in navigator;
  const shareCSV = async () => {
    if (processedData.length === 0) return;
    try {
      const file = new File([buildCsv()], fileName(), { type: 'text/csv' });
      const nav = navigator as any;
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title: 'MotionTrace 計測データ' });
        return;
      }
    } catch (err) {
      console.warn('[DataSheet] 共有できませんでした:', err);
    }
    downloadCSV();
  };

  // -------------------------------------------------

  return (
    <>
      {/* ---- 解析区間が効いていることの明示 ---- */}
      {hasRange(timeRange) && (
        <div
          className="hint"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10,
            padding: '9px 11px', borderRadius: 10, lineHeight: 1.6,
            background: tooFewInRange ? 'rgba(245,158,11,0.10)' : 'rgba(99,102,241,0.08)',
            border: `1px solid ${tooFewInRange ? 'rgba(245,158,11,0.4)' : 'rgba(99,102,241,0.25)'}`,
          }}
        >
          <Scissors
            size={14}
            color={tooFewInRange ? '#f59e0b' : 'var(--accent-primary)'}
            style={{ flexShrink: 0, marginTop: 3 }}
          />
          <span>
            <b style={{ color: 'var(--text-primary)' }}>
              区間 {timeRange.start !== null ? `${timeRange.start.toFixed(3)} s` : '先頭'}
              {' 〜 '}
              {timeRange.end !== null ? `${timeRange.end.toFixed(3)} s` : '末尾'}
            </b>
            {' '}のデータだけを使っています（{historyData.length} 点
            {clippedCount > 0 && ` ／ 区間外 ${clippedCount} 点を除外`}）。
            {tooFewInRange && (
              <span style={{ color: '#fcd34d', fontWeight: 600 }}>
                {' '}⚠ {MIN_RANGE_POINTS} 点未満です。Butterworth の遮断周波数の自動選択が
                不安定になります。区間を広げてください。
              </span>
            )}
          </span>
        </div>
      )}

      {/* ---- グラフ概形 ---- */}
      <Card
        title={<><LineChart size={16} color="var(--accent-primary)" />グラフ概形</>}
        right={
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setGraphFull(true)}
            disabled={processedData.length === 0}
            aria-label="全画面で見る"
          >
            <Maximize2 size={14} />拡大
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <GraphPanel
            objects={objects}
            data={graphData}
            unit={unitLabel}
            xKey={graphX}
            yKey={graphY}
            onChangeX={onChangeGraphX}
            onChangeY={onChangeGraphY}
            hiddenIds={hiddenGraphIds}
            onToggleId={onToggleGraphId}
            onSeek={handleGraphSeek}
            smooth={graphSmooth}
            smoothWindow={graphSmoothWindow}
            onChangeSmooth={onChangeGraphSmooth}
            onChangeSmoothWindow={onChangeGraphSmoothWindow}
            height={196}
          />
          <div className="hint">
            グラフをタップするとその時刻へ動画が移動します。
            vx-t / vy-t に鋭いスパイクが出ていたら、そこで追跡が飛んでいます。
            タップして飛び、映像の「修正」ツールで直してください。
          </div>
        </div>
      </Card>

      {/* ---- 全画面グラフ ---- */}
      {graphFull && (
        <div className="graph-full">
          <div className="graph-full__head">
            <div className="card__title" style={{ marginBottom: 0 }}>
              <LineChart size={16} color="var(--accent-primary)" />
              グラフ概形
              {graphSmooth && (
                <span className="badge" style={{ color: '#fcd34d' }}>
                  平滑化 {graphSmoothWindow} 点
                </span>
              )}
              {isTimeScaled(fpsSettings) && (
                <span className="badge" style={{ color: '#fcd34d' }}>
                  実時間 ×{timeScale(fpsSettings).toFixed(3)}
                  {realSpan > 0 && ` / ${realSpan.toFixed(3)} s`}
                </span>
              )}
            </div>
            <button
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => setGraphFull(false)}
              aria-label="閉じる"
            >
              <X size={17} />
            </button>
          </div>
          <GraphPanel
            objects={objects}
            data={graphData}
            unit={unitLabel}
            xKey={graphX}
            yKey={graphY}
            onChangeX={onChangeGraphX}
            onChangeY={onChangeGraphY}
            hiddenIds={hiddenGraphIds}
            onToggleId={onToggleGraphId}
            onSeek={handleGraphSeek}
            smooth={graphSmooth}
            smoothWindow={graphSmoothWindow}
            onChangeSmooth={onChangeGraphSmooth}
            onChangeSmoothWindow={onChangeGraphSmoothWindow}
          />
        </div>
      )}

      {/* ---- 現在値 ---- */}
      <Card
        title={<><Activity size={16} color="var(--accent-primary)" />計測値</>}
        right={<span className="badge">単位 {unitLabel}</span>}
      >
        {activeObjects.length === 0 ? (
          <div className="hint" style={{ textAlign: 'center', padding: '10px 0' }}>追跡オブジェクトなし</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {activeObjects.map(obj => {
              const it = latest?.objects[obj.id];
              const lost = obj.status === 'lost';
              const exited = obj.status === 'exited';
              return (
                <div
                  key={obj.id}
                  style={{
                    background: 'var(--bg-secondary)',
                    padding: '9px 12px',
                    borderRadius: 'var(--radius-sm)',
                    borderLeft: `4px solid ${lost ? 'var(--color-danger)' : exited ? 'var(--color-warning)' : obj.color}`,
                    opacity: lost || exited ? 0.72 : 1,
                  }}
                >
                  <div className="row-between" style={{ marginBottom: 5 }}>
                    <div className="row">
                      <div className={`status-dot ${obj.status}`} />
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{obj.name}</span>
                      {exited && <span className="badge badge-warn">追尾終了</span>}
                    </div>
                    <span className="mono" style={{ fontSize: '0.82rem', color: '#a5b4fc', fontWeight: 700 }}>
                      {it ? it.speedMs.toFixed(3) : '0.000'} {unitLabel}/s
                    </span>
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4,
                    fontSize: '0.76rem', color: 'var(--text-secondary)',
                  }}>
                    <div>X <span className="mono" style={{ color: 'var(--text-primary)' }}>
                      {it ? it.xM.toFixed(4) : '—'}</span></div>
                    <div>Y <span className="mono" style={{ color: 'var(--text-primary)' }}>
                      {it ? it.yM.toFixed(4) : '—'}</span></div>
                    <div>Vx <span className="mono" style={{ color: 'var(--text-primary)' }}>
                      {it ? it.vx.toFixed(3) : '—'}</span></div>
                    <div>Vy <span className="mono" style={{ color: 'var(--text-primary)' }}>
                      {it ? it.vy.toFixed(3) : '—'}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeObjects.length >= 2 && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
            <div className="row" style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginBottom: 7 }}>
              <ArrowRightLeft size={13} />相対距離
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {activeObjects.flatMap((a, i) =>
                activeObjects.slice(i + 1).map(b => {
                  const d = latest?.distances[`${a.id}-${b.id}`];
                  return (
                    <div key={`${a.id}-${b.id}`} className="row-between" style={{
                      fontSize: '0.77rem', background: 'rgba(255,255,255,0.03)',
                      padding: '6px 10px', borderRadius: 7,
                    }}>
                      <span className="row">
                        <span className="obj-swatch" style={{ background: a.color, width: 9, height: 9 }} />
                        <span className="obj-swatch" style={{ background: b.color, width: 9, height: 9 }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{a.id} ↔ {b.id}</span>
                      </span>
                      <span className="mono" style={{ fontWeight: 700 }}>
                        {d !== undefined ? `${d.toFixed(4)} ${unitLabel}` : '—'}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ---- 書き出し ---- */}
      <Card>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={downloadCSV}
            disabled={processedData.length === 0}
          >
            <Download size={17} />CSV 保存
          </button>
          {canShare && (
            <button
              className="btn btn-secondary"
              onClick={shareCSV}
              disabled={processedData.length === 0}
              aria-label="共有"
            >
              <Share2 size={17} />共有
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="btn btn-secondary"
            style={{ flex: 1, fontSize: '0.82rem' }}
            onClick={downloadPositionCSV}
            disabled={historyData.length === 0}
          >
            <Download size={16} />位置だけの CSV
          </button>
          {canShare && (
            <button
              className="btn btn-secondary"
              onClick={sharePositionCSV}
              disabled={historyData.length === 0}
              aria-label="位置だけの CSV を共有"
            >
              <Share2 size={16} />
            </button>
          )}
        </div>
        <div
          className="hint"
          style={{
            marginTop: 8, padding: '9px 11px', borderRadius: 10, lineHeight: 1.7,
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.22)',
          }}
        >
          <b>位置だけの CSV</b> は<b>時刻と x, y だけ</b>を出します。速度も加速度も
          入っていないので、表計算で自分で求められます。
          <b style={{ color: '#fcd34d' }}> 平滑化はかけていません。</b>
          差分を取るとノイズがどれだけ荒れるか、なぜ平滑化が要るのかを、
          そのまま確かめられるようにするためです。そのぶん、この値は
          グラフや通常の CSV とは一致しません。
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          {processedData.length} フレーム分 ／ BOM付きUTF-8（Excel対応）
          {hasRange(timeRange) &&
            ` ／ 区間 ${timeRange.start !== null ? timeRange.start.toFixed(3) : '先頭'}〜${
              timeRange.end !== null ? timeRange.end.toFixed(3) : '末尾'
            } s のみ`}
          {calibration.mode === 'plane' && calibration.homography && ' ／ 射影変換で遠近補正済み'}
          {filterSettings.enabled && ' ／ フィルタ適用後の値'}
          {isTimeScaled(fpsSettings) &&
            ` ／ 撮影 ${fpsSettings.captureFps} fps として実時間に換算済み`}
        </div>
      </Card>

      {/* ---- フィルタ ---- */}
      <Card
        title={<><Sliders size={16} color="var(--accent-primary)" />座標フィルタ</>}
        right={
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFilter(v => !v)}>
            {showFilter ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        }
      >
        <Switch
          checked={filterSettings.enabled}
          onChange={v => onUpdateFilterSettings({ ...filterSettings, enabled: v })}
          label="ノイズ除去を使う"
        />

        {filterSettings.enabled && (
          <div className="hint" style={{ marginTop: 4 }}>
            {filterSettings.kind === 'butterworth'
              ? `Butterworth 零位相${filterSettings.autoCutoff ? '・遮断周波数は自動' : `・${filterSettings.cutoffHz}Hz 固定`}`
              : `Savitzky-Golay・${filterSettings.windowSize}点 ${filterSettings.polynomialOrder}次`}
            {report.sampleRate > 0 && `（サンプリング ${report.sampleRate.toFixed(1)} Hz）`}
          </div>
        )}

        {showFilter && filterSettings.enabled && (
          <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            <div className="segmented" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <button
                className={`btn ${filterSettings.kind === 'butterworth' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => onUpdateFilterSettings({ ...filterSettings, kind: 'butterworth' })}
              >
                Butterworth
              </button>
              <button
                className={`btn ${filterSettings.kind === 'savgol' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => onUpdateFilterSettings({ ...filterSettings, kind: 'savgol' })}
              >
                Savitzky-Golay
              </button>
            </div>

            {filterSettings.kind === 'butterworth' && (
              <>
                <Switch
                  checked={filterSettings.autoCutoff}
                  onChange={v => onUpdateFilterSettings({ ...filterSettings, autoCutoff: v })}
                  label="遮断周波数を自動で決める（推奨）"
                />
                {filterSettings.autoCutoff ? (
                  <div className="notice notice-info" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                    <span>
                      残差の自己相関（Durbin-Watson 統計量）が最小になる遮断周波数を、
                      0.5Hz からナイキスト周波数まで走査して自動で選びます。
                    </span>
                    {activeObjects.map(o => (
                      report.cutoffs[o.id] !== undefined ? (
                        <span key={o.id} className="mono" style={{ color: '#10d97c', fontSize: '0.74rem' }}>
                          {o.id}: {report.cutoffs[o.id].toFixed(2)} Hz
                        </span>
                      ) : null
                    ))}
                  </div>
                ) : (
                  <Slider
                    label="遮断周波数"
                    value={filterSettings.cutoffHz}
                    display={`${filterSettings.cutoffHz.toFixed(1)} Hz`}
                    min={0.5}
                    max={Math.max(2, report.sampleRate > 0 ? report.sampleRate / 2 : 15)}
                    step={0.1}
                    onChange={v => onUpdateFilterSettings({ ...filterSettings, cutoffHz: v })}
                    hint="低くするほど滑らかになりますが、下げすぎると本物の運動まで削られます"
                  />
                )}
              </>
            )}

            {filterSettings.kind === 'savgol' && (
              <>
                <div className="row-between">
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>ウィンドウ幅</span>
                  <select
                    style={{ width: 120 }}
                    value={filterSettings.windowSize}
                    onChange={e => onUpdateFilterSettings({
                      ...filterSettings, windowSize: parseInt(e.target.value, 10),
                    })}
                  >
                    {[3, 5, 7, 9, 11, 15].map(n => <option key={n} value={n}>{n} 点</option>)}
                  </select>
                </div>

                {/* 点数だけでは判断できない。効くかどうかは
                    「時間として何ms均すか」で決まる */}
                {report.sampleRate > 0 && (() => {
                  const sec = sgWindowSeconds(filterSettings.windowSize, report.sampleRate);
                  const tooWide = sec > SG_WINDOW_WARN_SEC;
                  const rec = recommendSgWindow(report.sampleRate);
                  return (
                    <div className={`notice ${tooWide ? 'notice-warn' : 'notice-info'}`}>
                      この設定で均す時間: <b className="mono">{(sec * 1000).toFixed(0)} ms</b>
                      （サンプリング {report.sampleRate.toFixed(1)} Hz）
                      {tooWide && (
                        <div style={{ marginTop: 3 }}>
                          長すぎます。実際の運動まで削られ、速度の誤差がかえって増えます。
                          この動画なら <b>{rec} 点</b> 相当が上限の目安です。
                          {rec <= 3 && '（この条件で Savitzky-Golay を使う意味は薄いということです）'}
                          {' '}Butterworth はサンプリング間隔に自動で追随します。
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="row-between">
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>多項式次数</span>
                  <select
                    style={{ width: 120 }}
                    value={filterSettings.polynomialOrder}
                    onChange={e => onUpdateFilterSettings({
                      ...filterSettings, polynomialOrder: parseInt(e.target.value, 10),
                    })}
                  >
                    <option value={2}>2次</option>
                    <option value={3}>3次</option>
                  </select>
                </div>
              </>
            )}

            <div className="hint">
              位置を微分して速度を出すとノイズが Δt で割られて増幅されます。
              微分の前に平滑化するのが定石で、合成データでは Butterworth（自動遮断）が
              どの条件でも速度の誤差を 35〜77% 減らしました。
              Savitzky-Golay は窓が時間として長すぎると逆効果になるので、
              迷う場合は Butterworth を選んでください。
              フィルタは画面表示と CSV 出力の両方に効きます。
            </div>
          </div>
        )}
      </Card>
    </>
  );
};
