// src/App.tsx — MotionTrace Mobile
// ============================================================
// スマートフォン専用のシェル。
// 追跡・校正・平滑化のアルゴリズムは Ver.2 とまったく同じものを
// utils/ からそのまま使っている（結果の互換性を保つため）。
// 変えたのは画面構成と入力方法だけ。
//
//   ┌──────────────┐
//   │ TopBar       │ 状態バッジのみの細いバー
//   ├──────────────┤
//   │ VideoStage   │ 映像（ピンチズーム・パン）＋再生バー
//   ├──────────────┤
//   │ Sheet        │ 高さを 3 段階に変えられる操作パネル
//   ├──────────────┤
//   │ TabBar       │ 対象／校正／設定／データ
//   └──────────────┘
// ============================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrackedObject, ScaleCalibration, FilterSettings,
  FrameData, Rect, FpsSettings, TrackingSettings,
  DEFAULT_TRACKING, ObjectStatus, Point,
} from './types';
import { waitForOpenCV } from './utils/opencvLoader';
import { ObjectTracker, MIN_ROI_SIZE, RECOMMENDED_ROI_SIZE } from './utils/tracker';
import { FrameSource } from './utils/frameSource';
import { toReal } from './utils/calibration';
import { medianDt } from './utils/butterworth';
import {
  placeManualPoint, undoManualPoint, isFrameComplete, ManualEdit,
} from './utils/manualTrack';

import { TopBar } from './components/TopBar';
import { VideoStage, StageTool } from './components/VideoStage';
import { ObjectsSheet } from './components/sheets/ObjectsSheet';
import { CalibSheet } from './components/sheets/CalibSheet';
import { TuneSheet } from './components/sheets/TuneSheet';
import { DataSheet } from './components/sheets/DataSheet';
import { AxisKey } from './components/MotionGraph';
import { DEFAULT_SMOOTH_WINDOW } from './utils/graphSmooth';

import { Layers, Ruler, SlidersHorizontal, LineChart, X } from 'lucide-react';

// -------------------------------------------------
// 定数
// -------------------------------------------------

const OBJECT_DEFS: Pick<TrackedObject, 'id' | 'name' | 'color'>[] = [
  { id: 'Obj1', name: 'Object 1', color: '#ff3b30' },
  { id: 'Obj2', name: 'Object 2', color: '#0a84ff' },
  { id: 'Obj3', name: 'Object 3', color: '#30d158' },
  { id: 'Obj4', name: 'Object 4', color: '#ffd60a' },
  { id: 'Obj5', name: 'Object 5', color: '#bf5af2' },
];

const makeDefaultObjects = (): TrackedObject[] =>
  OBJECT_DEFS.map((def, i) => ({
    ...def,
    active: i === 0,
    status: 'idle' as ObjectStatus,
    roi: null,
    center: null,
  }));

/** 記録データを state へ反映する最小間隔 (ms)。
 *  毎フレーム setState すると再計算が追いつかずフレーム落ちする。
 *  スマホは PC より余裕がないので Ver.2 の 200ms より少し長く取る。 */
const HISTORY_FLUSH_MS = 300;

type TabId = 'objects' | 'calib' | 'tune' | 'data';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'objects', label: '対象', icon: <Layers size={19} /> },
  { id: 'calib', label: '校正', icon: <Ruler size={19} /> },
  { id: 'tune', label: '設定', icon: <SlidersHorizontal size={19} /> },
  { id: 'data', label: 'データ', icon: <LineChart size={19} /> },
];

// -------------------------------------------------

export const App: React.FC = () => {
  // ---- OpenCV ----
  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState<string | null>(null);
  const cvRef = useRef<any>(null);

  // ---- 追跡対象 ----
  const [objects, setObjects] = useState<TrackedObject[]>(makeDefaultObjects);
  const [selectedObjId, setSelectedObjId] = useState<string>('Obj1');

  // ---- 校正 ----
  const [calibration, setCalibration] = useState<ScaleCalibration>({
    mode: 'plane',
    targetObjId: 'Obj1',
    realSizeValue: 10,
    unit: 'cm',
    linePoints: [],
    pxPerUnit: 0,
    planePoints: [],
    planeWidth: 29.7,
    planeHeight: 21,
    homography: null,
    yUp: true,
    origin: null,
  });

  const [tracking, setTracking] = useState<TrackingSettings>(DEFAULT_TRACKING);

  const [filterSettings, setFilterSettings] = useState<FilterSettings>({
    enabled: true,
    kind: 'butterworth',
    autoCutoff: true,
    cutoffHz: 6,
    windowSize: 7,
    polynomialOrder: 2,
  });

  const [isPlaying, setIsPlaying] = useState(false);
  // value（ファイルfps）は再生中に実フレーム間隔から自動計測して上書きされる。
  // captureFps はユーザー入力で、0 は「通常の動画」＝時間軸の換算なし。
  const [fpsSettings, setFpsSettings] = useState<FpsSettings>({ value: 30, captureFps: 0 });
  const [historyData, setHistoryData] = useState<FrameData[]>([]);
  const [isLineCalibrating, setIsLineCalibrating] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- モバイル UI の状態 ----
  const [tool, setTool] = useState<StageTool>('roi');
  const [roiSize, setRoiSize] = useState(40);
  const [calibHandle, setCalibHandle] = useState(0);
  const [tab, setTab] = useState<TabId>('objects');
  /** グラフのタップから動画をシークさせるための指示 */
  const [seekRequest, setSeekRequest] = useState<{ t: number; n: number } | null>(null);
  const seekSeqRef = useRef(0);

  // ---- グラフ概形の表示状態 ----
  // シートを閉じると DataSheet が外れるので、選んだ軸は App 側で持っておく。
  const [graphX, setGraphX] = useState<AxisKey>('t');
  const [graphY, setGraphY] = useState<AxisKey>('x');
  const [hiddenGraphIds, setHiddenGraphIds] = useState<string[]>([]);
  // グラフ表示だけにかける平滑化。既定は OFF。
  // 既定を ON にすると、追跡が飛んだ箇所が均されて見えなくなり、
  // このモード本来の目的（計測が使い物になるかの判断）を損なうため。
  const [graphSmooth, setGraphSmooth] = useState(false);
  const [graphSmoothWindow, setGraphSmoothWindow] = useState(DEFAULT_SMOOTH_WINDOW);

  const toggleGraphId = useCallback((id: string) => {
    setHiddenGraphIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);
  const [sheetH, setSheetH] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetDragRef = useRef<{ startY: number; startH: number } | null>(null);

  // ----- Refs -----
  const trackersRef = useRef<{ [objId: string]: ObjectTracker }>({});
  const frameSourceRef = useRef<FrameSource | null>(null);
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;
  const historyDataRef = useRef<FrameData[]>([]);
  const lastFlushRef = useRef(0);

  const getFrameSource = useCallback((): FrameSource => {
    if (!frameSourceRef.current) frameSourceRef.current = new FrameSource();
    return frameSourceRef.current;
  }, []);

  // -------------------------------------------------
  // シートの高さ（閉じる／半分／広い の 3 段階）
  // -------------------------------------------------

  const snapPoints = useCallback((): number[] => {
    const h = window.innerHeight;
    return [0, Math.round(h * 0.4), Math.round(h * 0.72)];
  }, []);

  useEffect(() => {
    setSheetH(snapPoints()[1]);
  }, [snapPoints]);

  const snapTo = (h: number) => {
    const pts = snapPoints();
    let best = pts[0];
    let bd = Infinity;
    pts.forEach(p => {
      const d = Math.abs(p - h);
      if (d < bd) { bd = d; best = p; }
    });
    setSheetH(best);
  };

  const onGripDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sheetDragRef.current = { startY: e.clientY, startH: sheetH };
    setSheetDragging(true);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = sheetDragRef.current;
    if (!d) return;
    const next = Math.max(0, Math.min(window.innerHeight * 0.85, d.startH - (e.clientY - d.startY)));
    setSheetH(next);
  };
  const onGripUp = (e: React.PointerEvent) => {
    const d = sheetDragRef.current;
    sheetDragRef.current = null;
    setSheetDragging(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    if (!d) return;
    // ほとんど動かなかったらタップ扱いで「半分 ⇄ 広い」を切り替える
    if (Math.abs(e.clientY - d.startY) < 6) {
      const pts = snapPoints();
      setSheetH(sheetH >= pts[2] - 4 ? pts[1] : pts[2]);
    } else {
      snapTo(sheetH);
    }
  };

  const handleSeek = useCallback((t: number) => {
    seekSeqRef.current += 1;
    setSeekRequest({ t, n: seekSeqRef.current });
  }, []);

  const openTab = (id: TabId) => {
    const pts = snapPoints();
    if (tab === id && sheetH > 8) {
      setSheetH(0);
    } else {
      setTab(id);
      if (sheetH <= 8) setSheetH(pts[1]);
    }
  };

  // -------------------------------------------------
  // OpenCV
  // -------------------------------------------------

  useEffect(() => {
    waitForOpenCV().then(cv => {
      cvRef.current = cv;
      setCvReady(true);
    }).catch(err => {
      console.error('[App] OpenCV初期化失敗:', err);
      setCvError(String(err?.message || err));
    });
  }, []);

  useEffect(() => {
    Object.values(trackersRef.current).forEach(t => t.setConfig(tracking));
  }, [tracking]);

  // -------------------------------------------------
  // 記録データ
  // -------------------------------------------------

  const flushHistory = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastFlushRef.current < HISTORY_FLUSH_MS) return;
    lastFlushRef.current = now;
    setHistoryData(historyDataRef.current.slice());
  }, []);

  useEffect(() => {
    if (!isPlaying) flushHistory(true);
  }, [isPlaying, flushHistory]);

  // -------------------------------------------------
  // オブジェクト管理
  // -------------------------------------------------

  const handleAddObject = () => {
    const inactive = objects.find(o => !o.active);
    if (!inactive) return;
    setObjects(prev => prev.map(o =>
      o.id === inactive.id
        ? { ...o, active: true, status: 'idle' as ObjectStatus, roi: null, center: null }
        : o
    ));
    setSelectedObjId(inactive.id);
    setTool('roi');
  };

  const handleRemoveObject = (id: string) => {
    if (objects.filter(o => o.active).length <= 1) return;
    if (trackersRef.current[id]) {
      trackersRef.current[id].cleanup();
      delete trackersRef.current[id];
    }
    setObjects(prev => prev.map(o =>
      o.id === id
        ? { ...o, active: false, status: 'idle' as ObjectStatus, roi: null, center: null }
        : o
    ));
    if (selectedObjId === id) {
      const remaining = objects.filter(o => o.active && o.id !== id);
      if (remaining.length > 0) setSelectedObjId(remaining[0].id);
    }
  };

  // -------------------------------------------------
  // ROI 更新
  // -------------------------------------------------

  const handleUpdateRoi = useCallback(
    (objId: string, roi: Rect, videoEl?: HTMLVideoElement) => {
      let center: Point = { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 };

      if (roi.width < MIN_ROI_SIZE || roi.height < MIN_ROI_SIZE) {
        setNotice(
          `枠が小さすぎます（${Math.round(roi.width)}×${Math.round(roi.height)}px）。` +
          `${RECOMMENDED_ROI_SIZE}px 前後まで大きくしてください。` +
          `小さい枠は画面のどこにでも一致してしまい、軌跡が暴走します。`
        );
        return;
      }

      if (cvRef.current && cvReady && videoEl) {
        const cv = cvRef.current;
        try {
          const src = getFrameSource();
          if (src.capture(videoEl)) {
            let tracker = trackersRef.current[objId];
            if (!tracker) {
              tracker = new ObjectTracker(cv, objId, trackingRef.current);
              trackersRef.current[objId] = tracker;
            } else {
              tracker.setConfig(trackingRef.current);
            }
            if (!tracker.init(src, roi)) {
              setNotice(`${objId} の追跡を開始できませんでした。枠を大きめに取り直してください。`);
              return;
            }
            const probe = tracker.update(src);
            if (probe.state !== 'exited') center = probe.center;
            setNotice(null);
          }
        } catch (err) {
          console.error(`[App] ROI初期化失敗 (${objId}):`, err);
        }
      }

      setObjects(prev => prev.map(o =>
        o.id === objId
          ? { ...o, roi, status: 'idle' as ObjectStatus, center }
          : o
      ));

      // box モード: 基準オブジェクトの枠幅から pxPerUnit を出す
      setCalibration(prev => {
        if (prev.mode === 'box' && (prev.targetObjId === objId || !prev.targetObjId)) {
          const pxPerUnit = roi.width > 0 && prev.realSizeValue > 0
            ? roi.width / prev.realSizeValue
            : prev.pxPerUnit;
          return { ...prev, targetObjId: objId, pxPerUnit };
        }
        return prev;
      });
    },
    [cvReady, getFrameSource]
  );

  // -------------------------------------------------
  // 手動修正（キーフレーム編集）
  // -------------------------------------------------

  // -------------------------------------------------
  // 手動トラッキング
  // -------------------------------------------------
  //
  // 自動追跡が使えない対象（変形する物体、低コントラスト、遮蔽が多い）を
  // コマごとに人が指してデータにする。記録先は自動追跡と同じ historyData で、
  // 手で打った点には manual: true が付く。

  /** 取り消し用の履歴。手動で打った操作だけを積む */
  const manualUndoRef = useRef<ManualEdit[]>([]);

  /** 同じコマとみなす時刻の許容差 */
  const frameTolerance = useCallback(() => {
    const hist = historyDataRef.current;
    const dt = hist.length > 1 ? medianDt(hist.map(f => f.timestamp)) : 0;
    const base = dt > 0 ? dt : 1 / Math.max(1, fpsSettings.value);
    return base * 0.5;
  }, [fpsSettings.value]);

  /**
   * 手動で 1 点打つ。
   * @param fileTime 実際に表示されているフレームの時刻（要求時刻ではない）
   */
  const handleManualPlace = useCallback(
    (objId: string, center: Point, fileTime: number): boolean => {
      const real = toReal(
        calibrationRef.current, center, frameSourceRef.current?.height || 0
      );
      const edit = placeManualPoint(
        historyDataRef.current, objId, fileTime, center, real,
        frameTolerance(),
        Math.round(fileTime * Math.max(1, fpsSettings.value))
      );
      manualUndoRef.current.push(edit);
      flushHistory(true);
      setObjects(prev => prev.map(o =>
        o.id === objId ? { ...o, center, status: 'tracking' as ObjectStatus } : o
      ));

      // 打った直後の状態を持っているのは historyDataRef だけ。
      // 打つ順番を入れ替えられるので「残り 1 つか」は事前に決められない
      const order = objectsRef.current.filter(o => o.active).map(o => o.id);
      return isFrameComplete(
        historyDataRef.current, order, fileTime, frameTolerance()
      );
    },
    [flushHistory, frameTolerance, fpsSettings.value]
  );

  /** 直前に打った点を取り消す */
  const handleManualUndo = useCallback((): boolean => {
    const edit = manualUndoRef.current.pop();
    if (!edit) return false;
    const ok = undoManualPoint(historyDataRef.current, edit, frameTolerance());
    flushHistory(true);
    return ok;
  }, [flushHistory, frameTolerance]);

  /**
   * @returns 記録データを実際に書き換えられたか。
   *   false のときは枠だけが動いた状態なので、呼び出し側で知らせる必要がある。
   */
  const handleManualCorrect = useCallback(
    (objId: string, center: Point, timestamp: number, videoEl?: HTMLVideoElement): boolean => {
      const obj = objectsRef.current.find(o => o.id === objId);
      const size = obj?.roi ? { w: obj.roi.width, h: obj.roi.height } : { w: 30, h: 30 };
      const roi: Rect = {
        x: Math.round(center.x - size.w / 2),
        y: Math.round(center.y - size.h / 2),
        width: Math.round(size.w),
        height: Math.round(size.h),
      };

      if (cvRef.current && cvReady && videoEl) {
        try {
          const src = getFrameSource();
          if (src.capture(videoEl)) {
            const tracker = new ObjectTracker(cvRef.current, objId, trackingRef.current);
            if (tracker.init(src, roi)) {
              trackersRef.current[objId]?.cleanup();
              trackersRef.current[objId] = tracker;
            }
          }
        } catch (err) {
          console.error(`[App] 手動修正でのトラッカー再初期化に失敗 (${objId}):`, err);
        }
      }

      let applied = false;
      const hist = historyDataRef.current;
      if (hist.length > 0) {
        let bestIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < hist.length; i++) {
          const d = Math.abs(hist[i].timestamp - timestamp);
          if (d < bestDiff) { bestDiff = d; bestIdx = i; }
        }
        // 許容差は「実際に記録されている間隔」から出す。
        // 以前は 1/fpsSettings.value を使っていたが、これだと
        // スロー動画で撮影 fps（240 など）を手入力したときに
        // 許容差が実間隔よりずっと狭くなり、書き換えが黙って失敗していた。
        // （最近傍フレームまでの距離は最大で間隔の半分なので 0.75 倍で足りる）
        const recordedDt = medianDt(hist.map(f => f.timestamp));
        const tol =
          (recordedDt > 0 ? recordedDt : 1 / Math.max(1, fpsSettings.value)) * 0.75;
        if (bestDiff <= tol) {
          const fd = hist[bestIdx];
          const item = fd.objects[objId];
          const realPt = toReal(calibrationRef.current, center, frameSourceRef.current?.height || 0);
          if (item) {
            item.xPx = center.x;
            item.yPx = center.y;
            item.xM = realPt.x;
            item.yM = realPt.y;
            item.lost = false;
            item.manual = true;
          } else {
            fd.objects[objId] = {
              xPx: center.x, yPx: center.y,
              xM: realPt.x, yM: realPt.y,
              vx: 0, vy: 0, speedMs: 0, score: 1, lost: false, manual: true,
            };
          }
          flushHistory(true);
          applied = true;
        }
      }

      setObjects(prev => prev.map(o =>
        o.id === objId ? { ...o, roi, center, status: 'tracking' as ObjectStatus } : o
      ));

      return applied;
    },
    [cvReady, getFrameSource, flushHistory, fpsSettings.value]
  );

  // -------------------------------------------------

  const handleRecalibrateObject = (objId: string) => {
    setSelectedObjId(objId);
    setIsPlaying(false);
    if (trackersRef.current[objId]) {
      trackersRef.current[objId].cleanup();
      delete trackersRef.current[objId];
    }
    setObjects(prev => prev.map(o =>
      o.id === objId ? { ...o, status: 'idle' as ObjectStatus } : o
    ));
  };

  const handleResetData = useCallback(() => {
    historyDataRef.current = [];
    lastFlushRef.current = 0;
    setHistoryData([]);
    Object.values(trackersRef.current).forEach(t => t.cleanup());
    trackersRef.current = {};
    setObjects(prev => prev.map(o => ({
      ...o, status: 'idle' as ObjectStatus, roi: null, center: null,
    })));
  }, []);

  /** 軌跡だけ消して枠は保持する（同じ設定で取り直す用） */
  const handleClearTrail = useCallback(() => {
    historyDataRef.current = [];
    lastFlushRef.current = 0;
    setHistoryData([]);
    Object.values(trackersRef.current).forEach(t => t.cleanup());
    trackersRef.current = {};
    setObjects(prev => prev.map(o => (o.roi ? { ...o, status: 'idle' as ObjectStatus } : o)));
  }, []);

  // -------------------------------------------------
  // フレーム処理
  // -------------------------------------------------

  const handleProcessFrame = useCallback(
    (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => {
      if (!cvRef.current || !cvReady) return;
      const cv = cvRef.current;
      const cfg = trackingRef.current;

      try {
        const src = getFrameSource();
        if (!src.capture(videoEl)) return;

        const currentHistory = historyDataRef.current;
        const prevFrame = currentHistory.length > 0
          ? currentHistory[currentHistory.length - 1]
          : null;

        // シークで時刻が巻き戻った／同じフレームが再提示された場合は記録しない
        if (prevFrame && timestamp <= prevFrame.timestamp) return;

        const currentCalibration = calibrationRef.current;
        const activeObjs = objectsRef.current.filter(o => o.active);

        const frameObjects: FrameData['objects'] = {};
        const updates: { id: string; status: ObjectStatus; roi?: Rect; center?: Point }[] = [];

        activeObjs.forEach(obj => {
          if (!obj.roi) return;
          if (obj.status === 'exited') return;

          try {
            let tracker = trackersRef.current[obj.id];
            if (!tracker) {
              tracker = new ObjectTracker(cv, obj.id, cfg);
              if (!tracker.init(src, obj.roi)) return;
              trackersRef.current[obj.id] = tracker;
            }

            const res = tracker.update(src);
            if (res.state === 'exited') {
              updates.push({ id: obj.id, status: 'exited' });
              return;
            }

            const real = toReal(currentCalibration, res.center, src.height);
            const xM = real.x;
            const yM = real.y;

            let vx = 0;
            let vy = 0;
            if (prevFrame) {
              const prevObj = prevFrame.objects[obj.id];
              if (prevObj && !prevObj.lost && res.state === 'ok') {
                const dt = timestamp - prevFrame.timestamp;
                if (dt > 1e-6) {
                  vx = (xM - prevObj.xM) / dt;
                  vy = (yM - prevObj.yM) / dt;
                } else {
                  vx = prevObj.vx;
                  vy = prevObj.vy;
                }
              }
            }

            frameObjects[obj.id] = {
              xPx: res.center.x, yPx: res.center.y,
              xM, yM, vx, vy,
              speedMs: Math.hypot(vx, vy),
              score: res.score,
              lost: res.state === 'lost',
            };

            updates.push({
              id: obj.id,
              status: res.state === 'lost' ? 'lost' : 'tracking',
              roi: res.roi,
              center: res.center,
            });
          } catch (objErr) {
            console.error(`[App] Tracker error on ${obj.id}:`, objErr);
          }
        });

        const distances: FrameData['distances'] = {};
        for (let i = 0; i < activeObjs.length; i++) {
          for (let j = i + 1; j < activeObjs.length; j++) {
            const idA = activeObjs[i].id;
            const idB = activeObjs[j].id;
            const a = frameObjects[idA];
            const b = frameObjects[idB];
            if (a && b && !a.lost && !b.lost) {
              distances[`${idA}-${idB}`] = Math.hypot(a.xM - b.xM, a.yM - b.yM);
            }
          }
        }

        if (updates.length > 0) {
          setObjects(prev => {
            let changed = false;
            const next = prev.map(o => {
              const u = updates.find(x => x.id === o.id);
              if (!u) return o;
              changed = true;
              return {
                ...o,
                status: u.status,
                ...(u.roi ? { roi: u.roi } : {}),
                ...(u.center ? { center: u.center } : {}),
              } as TrackedObject;
            });
            return changed ? next : prev;
          });
        }

        if (Object.keys(frameObjects).length > 0) {
          historyDataRef.current.push({ frameIndex, timestamp, objects: frameObjects, distances });
          flushHistory();
        }
      } catch (err) {
        console.error('[App] フレーム処理エラー:', err);
      }
    },
    [cvReady, getFrameSource, flushHistory]
  );

  // -------------------------------------------------
  // 表示
  // -------------------------------------------------

  const activeCount = objects.filter(o => o.active).length;
  const attentionCount = objects.filter(
    o => o.active && (o.status === 'lost' || o.status === 'exited')
  ).length;

  const tabTitle = TABS.find(t => t.id === tab);

  return (
    <div className="app">
      <TopBar
        isOpenCVReady={cvReady}
        cvError={cvError}
        activeCount={activeCount}
        totalDataCount={historyData.length}
        fps={fpsSettings.value}
      />

      <VideoStage
        objects={objects}
        selectedObjId={selectedObjId}
        onUpdateRoi={handleUpdateRoi}
        onManualCorrect={handleManualCorrect}
        onManualPlace={handleManualPlace}
        onManualUndo={handleManualUndo}
        calibration={calibration}
        onUpdateCalibration={setCalibration}
        onProcessFrame={handleProcessFrame}
        historyData={historyData}
        onResetData={handleResetData}
        onClearTrail={handleClearTrail}
        isPlaying={isPlaying}
        setIsPlaying={setIsPlaying}
        fpsSettings={fpsSettings}
        setFpsSettings={setFpsSettings}
        isLineCalibrating={isLineCalibrating}
        setIsLineCalibrating={setIsLineCalibrating}
        onVideoSize={setVideoSize}
        onVideoLoaded={setVideoLoaded}
        tool={tool}
        setTool={setTool}
        roiSize={roiSize}
        setRoiSize={setRoiSize}
        calibHandle={calibHandle}
        setCalibHandle={setCalibHandle}
        seekRequest={seekRequest}
      />

      {/* ---- 通知 ---- */}
      {notice && (
        <div
          role="alert"
          className="notice notice-danger fade-in"
          style={{ margin: '8px 10px 0', flexShrink: 0 }}
        >
          <span style={{ flex: 1 }}>{notice}</span>
          <button
            className="btn btn-icon btn-sm"
            style={{ color: 'inherit', minHeight: 28, width: 28 }}
            aria-label="閉じる"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* ---- 操作シート ---- */}
      {sheetH > 8 && (
        <div className={`sheet ${sheetDragging ? 'is-dragging' : ''}`} style={{ height: sheetH }}>
          <div
            className="sheet__grip"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
          />
          <div className="sheet__head">
            {tabTitle?.icon}
            {tabTitle?.label}
          </div>
          <div className="sheet__body">
            {tab === 'objects' && (
              <ObjectsSheet
                objects={objects}
                selectedObjId={selectedObjId}
                onSelectObjId={setSelectedObjId}
                onAddObject={handleAddObject}
                onRemoveObject={handleRemoveObject}
                onRecalibrateObject={handleRecalibrateObject}
                setTool={setTool}
                roiSize={roiSize}
                setRoiSize={setRoiSize}
                videoLoaded={videoLoaded}
              />
            )}
            {tab === 'calib' && (
              <CalibSheet
                objects={objects}
                selectedObjId={selectedObjId}
                calibration={calibration}
                onUpdateCalibration={setCalibration}
                isLineCalibrating={isLineCalibrating}
                setIsLineCalibrating={setIsLineCalibrating}
                tool={tool}
                setTool={setTool}
                calibHandle={calibHandle}
                setCalibHandle={setCalibHandle}
                videoWidth={videoSize.width}
                videoHeight={videoSize.height}
                videoLoaded={videoLoaded}
              />
            )}
            {tab === 'tune' && (
              <TuneSheet
                fpsSettings={fpsSettings}
                onUpdateFpsSettings={setFpsSettings}
                tracking={tracking}
                onUpdateTracking={setTracking}
                onResetData={handleResetData}
              />
            )}
            {tab === 'data' && (
              <DataSheet
                objects={objects}
                historyData={historyData}
                filterSettings={filterSettings}
                onUpdateFilterSettings={setFilterSettings}
                calibration={calibration}
                fpsSettings={fpsSettings}
                onSeek={handleSeek}
                graphX={graphX}
                graphY={graphY}
                onChangeGraphX={setGraphX}
                onChangeGraphY={setGraphY}
                hiddenGraphIds={hiddenGraphIds}
                onToggleGraphId={toggleGraphId}
                graphSmooth={graphSmooth}
                graphSmoothWindow={graphSmoothWindow}
                onChangeGraphSmooth={setGraphSmooth}
                onChangeGraphSmoothWindow={setGraphSmoothWindow}
              />
            )}
          </div>
        </div>
      )}

      {/* ---- タブバー ---- */}
      <nav className="tabbar">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tabbar__item ${tab === t.id && sheetH > 8 ? 'is-active' : ''}`}
            onClick={() => openTab(t.id)}
          >
            {t.icon}
            {t.label}
            {t.id === 'objects' && attentionCount > 0 && (
              <span className="tabbar__badge">{attentionCount}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
};

export default App;
