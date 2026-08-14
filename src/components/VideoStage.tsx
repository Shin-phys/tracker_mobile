// src/components/VideoStage.tsx — MotionTrace Mobile
// ============================================================
// スマートフォン向けの映像ステージ。
//
// PC 版（Ver.2）との違い
//   ① 入力を Pointer Events に統一し、指1本／2本で役割を分けた
//        ・2本指  : いつでもピンチズーム＋パン
//        ・1本指  : 選択中のツール（移動／枠／修正／校正）の操作
//      指1本の意味がツールで変わるので、画面左に常時ツールバーを置く。
//   ② 指先は必ず自分の指で隠れるため、ドラッグ中は「虫めがね」を出す。
//      これがないと数 px の精度で点を置くのは不可能に近い。
//   ③ 枠の指定はドラッグだけでなく「タップで既定サイズを置く」にも対応。
//      小さい画面ではドラッグで正確な矩形を描くのが難しいため。
//   ④ 校正点はタップで置き、あとからドラッグ＋十字キーで微調整する。
//
// 座標系は Ver.2 と同じく「動画ピクセル」で統一している。
// 画面表示はキャンバスへの CSS transform だけで拡大縮小しているので、
// getBoundingClientRect() から素直に逆算できる。
// ============================================================

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  TrackedObject, ScaleCalibration, Rect, Point, FrameData, FpsSettings,
} from '../types';
import { recalcScale, pixelDistance } from '../utils/calibration';
import { applyHomography, invertHomography, Matrix3 } from '../utils/homography';
import { MIN_ROI_SIZE, RECOMMENDED_ROI_SIZE } from '../utils/tracker';
import { stepFrames, measureFileFps, seekToFrameTime } from '../utils/videoFrame';
import { medianDt } from '../utils/butterworth';
import {
  nextManualTarget, countManualPoints, manualStepInterval,
  recommendManualStep, MANUAL_INTERVAL_WARN,
} from '../utils/manualTrack';
import { timeScale } from '../utils/timeScale';
import {
  Play, Pause, RotateCcw, Upload, Hand, Square, Move, Crosshair, Target,
  MousePointerClick, Undo2,
  ZoomIn, ZoomOut, Maximize, ChevronLeft, ChevronRight, Route,
} from 'lucide-react';

export type StageTool = 'pan' | 'roi' | 'correct' | 'calib' | 'origin' | 'manual';

interface VideoStageProps {
  objects: TrackedObject[];
  selectedObjId: string;
  onUpdateRoi: (id: string, roi: Rect, videoEl?: HTMLVideoElement) => void;
  /** 追跡点を手で直す。記録データを書き換えられたかを返す */
  onManualCorrect: (id: string, center: Point, timestamp: number, videoEl?: HTMLVideoElement) => boolean;
  /** 手動トラッキングで 1 点打つ。そのコマを打ち切ったら true */
  onManualPlace: (id: string, center: Point, fileTime: number) => boolean;
  /** 手動トラッキングの直前の 1 点を取り消す */
  onManualUndo: () => boolean;
  calibration: ScaleCalibration;
  onUpdateCalibration: (calib: ScaleCalibration) => void;
  onProcessFrame: (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => void;
  historyData: FrameData[];
  onResetData: () => void;
  onClearTrail: () => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  fpsSettings: FpsSettings;
  setFpsSettings: (fps: FpsSettings) => void;
  isLineCalibrating: boolean;
  setIsLineCalibrating: (v: boolean) => void;
  onVideoSize: (s: { width: number; height: number }) => void;
  /** 動画の長さ [s]。時間軸の確認表示に使う */
  onVideoDuration?: (d: number) => void;
  onVideoLoaded: (v: boolean) => void;
  tool: StageTool;
  setTool: (t: StageTool) => void;
  roiSize: number;
  setRoiSize: (n: number) => void;
  /** 校正点の微調整用: 外から選択中のハンドル番号を制御する */
  calibHandle: number;
  setCalibHandle: (i: number) => void;
  /** グラフから「この時刻へ飛べ」と言われたときの指示。
   *  同じ時刻を続けてタップしても発火するよう、通し番号 n を添える。 */
  seekRequest: { t: number; n: number } | null;
}

/** 軌跡として描く最大点数 */
const MAX_TRAIL_POINTS = 2000;
/** ハンドルを掴める距離（画面ピクセル）。指の腹の大きさに合わせて広めに取る */
const HANDLE_TOUCH_PX = 26;
/** これ未満の移動は「タップ」とみなす（画面ピクセル） */
const TAP_SLOP_PX = 9;
/** 虫めがねの倍率 */
const LOUPE_MAG = 3;
const LOUPE_SIZE = 104;

const PLAYBACK_RATES = [0.25, 0.5, 1];

type Gesture =
  | null
  | { kind: 'pan' }
  | { kind: 'roi' }
  | { kind: 'manual'; objId: string }
  | { kind: 'calib-new' }
  | { kind: 'calib-handle'; index: number };

interface View {
  z: number;
  tx: number;
  ty: number;
}

export const VideoStage: React.FC<VideoStageProps> = ({
  objects, selectedObjId, onUpdateRoi, onManualCorrect, onManualPlace, onManualUndo,
  calibration, onUpdateCalibration, onProcessFrame,
  historyData, onResetData, onClearTrail, isPlaying, setIsPlaying,
  fpsSettings, setFpsSettings, isLineCalibrating, setIsLineCalibrating,
  onVideoSize, onVideoDuration, onVideoLoaded, tool, setTool, roiSize, setRoiSize,
  calibHandle, setCalibHandle, seekRequest,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);

  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoDims, setVideoDims] = useState({ width: 640, height: 360 });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showTrail, setShowTrail] = useState(true);
  const [squareMode] = useState(true);

  /** ステージ（表示領域）の実サイズ */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  /** 等倍で画面に収まるときの表示サイズ */
  const [base, setBase] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ z: 1, tx: 0, ty: 0 });

  // ---- ジェスチャ状態 ----
  const [gesture, setGesture] = useState<Gesture>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  /** 2点間校正でタップ1回目を置いた位置 */
  const [linePending, setLinePending] = useState<Point | null>(null);
  /** 修正ツールの操作結果を伝える一言（成功／記録なし） */
  const [correctMsg, setCorrectMsg] = useState<string | null>(null);
  /**
   * いま表示されているフレームの実時刻（mediaTime）。
   * 「要求した時刻」ではなくブラウザが実際に見せたフレームの時刻なので、
   * 手動で点を打つときはこの値を記録する。
   */
  const frameTimeRef = useRef(0);
  /** コマ送りの多重実行を防ぐ（連打でシークが交錯すると位置が飛ぶ） */
  const steppingRef = useRef(false);
  /** 手動トラッキング: 1 回打ったあとに進めるコマ数 */
  const [manualStep, setManualStep] = useState(1);
  /** ユーザーが自分でコマ数を決めたか（決めていれば自動で上書きしない） */
  const manualStepTouched = useRef(false);
  /** 手動トラッキング: 操作結果を伝える一言 */
  const [manualMsg, setManualMsg] = useState<string | null>(null);
  /**
   * 次に打つ物体をユーザーが指名した場合の id。
   * null なら自動の順番（そのコマでまだ打っていない先頭）に従う。
   * 打ち間違えたときや、見えている物体から先に打ちたいときのための逃げ道。
   */
  const [manualPick, setManualPick] = useState<string | null>(null);

  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const downScreenRef = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const baseRef = useRef(base);
  baseRef.current = base;
  const stageSizeRef = useRef(stageSize);
  stageSizeRef.current = stageSize;

  // ---- 再生ループ用 ----
  const frameCounterRef = useRef(0);
  const frameIntervalsRef = useRef<number[]>([]);
  const lastMediaTimeRef = useRef<number | null>(null);
  const lastUiTimeRef = useRef(0);
  const renderRef = useRef<() => void>(() => {});
  const processRef = useRef(onProcessFrame);
  processRef.current = onProcessFrame;
  const fpsRef = useRef(fpsSettings);
  fpsRef.current = fpsSettings;
  const setFpsRef = useRef(setFpsSettings);
  setFpsRef.current = setFpsSettings;

  const rvfcSupported =
    typeof window !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  // =========================================================
  // 表示サイズの計算
  // =========================================================

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setStageSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('orientationchange', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  const lastVideoKeyRef = useRef('');

  /** 動画とステージのサイズから「画面に収まる大きさ」を作り直す。
   *  動画が変わったときだけ等倍に戻し、シートの開閉などで表示領域が
   *  変わっただけのときはユーザーのズーム倍率を保つ。 */
  useEffect(() => {
    const { w: sw, h: sh } = stageSize;
    const { width: vw, height: vh } = videoDims;
    if (sw <= 0 || sh <= 0 || vw <= 0 || vh <= 0) return;
    const fit = Math.min(sw / vw, sh / vh);
    const bw = vw * fit;
    const bh = vh * fit;
    setBase({ w: bw, h: bh });

    const key = `${vw}x${vh}`;
    if (lastVideoKeyRef.current !== key) {
      lastVideoKeyRef.current = key;
      setView({ z: 1, tx: (sw - bw) / 2, ty: (sh - bh) / 2 });
      return;
    }
    setView(v => {
      const cw = bw * v.z;
      const ch = bh * v.z;
      return {
        z: v.z,
        tx: cw <= sw ? (sw - cw) / 2 : Math.min(0, Math.max(sw - cw, v.tx)),
        ty: ch <= sh ? (sh - ch) / 2 : Math.min(0, Math.max(sh - ch, v.ty)),
      };
    });
  }, [stageSize, videoDims]);

  /** パンのはみ出しを抑える */
  const clampView = useCallback((v: View): View => {
    const { w: sw, h: sh } = stageSizeRef.current;
    const { w: bw, h: bh } = baseRef.current;
    const cw = bw * v.z;
    const ch = bh * v.z;
    let { tx, ty } = v;
    tx = cw <= sw ? (sw - cw) / 2 : Math.min(0, Math.max(sw - cw, tx));
    ty = ch <= sh ? (sh - ch) / 2 : Math.min(0, Math.max(sh - ch, ty));
    return { z: v.z, tx, ty };
  }, []);

  /** 画面中央を保ったままズーム倍率を変える（ボタン用） */
  const zoomBy = useCallback((factor: number) => {
    setView(prev => {
      const { w: sw, h: sh } = stageSizeRef.current;
      const z = Math.min(12, Math.max(1, prev.z * factor));
      const cx = sw / 2;
      const cy = sh / 2;
      const lx = (cx - prev.tx) / prev.z;
      const ly = (cy - prev.ty) / prev.z;
      return clampView({ z, tx: cx - lx * z, ty: cy - ly * z });
    });
  }, [clampView]);

  const resetView = useCallback(() => {
    const { w: sw, h: sh } = stageSizeRef.current;
    const { w: bw, h: bh } = baseRef.current;
    setView({ z: 1, tx: (sw - bw) / 2, ty: (sh - bh) / 2 });
  }, []);

  // =========================================================
  // 座標変換
  // =========================================================

  /** 画面座標 → 動画ピクセル座標 */
  const toCanvasPt = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    return {
      x: (clientX - r.left) * (canvas.width / r.width),
      y: (clientY - r.top) * (canvas.height / r.height),
    };
  }, []);

  /** 画面 1px が動画何ピクセルに相当するか（ヒット判定の距離換算に使う） */
  const canvasPerScreen = useCallback((): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 1;
    const r = canvas.getBoundingClientRect();
    return r.width > 0 ? canvas.width / r.width : 1;
  }, []);

  // =========================================================
  // 動画の読み込み
  // =========================================================

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !videoRef.current) return;
    const url = URL.createObjectURL(file);
    setVideoLoaded(false);
    onVideoLoaded(false);
    videoRef.current.src = url;
    videoRef.current.load();
    setIsPlaying(false);
    setCurrentTime(0);
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
    onResetData();
    onUpdateCalibration({
      ...calibration,
      linePoints: [], pxPerUnit: 0, planePoints: [], homography: null,
    });
    setIsLineCalibrating(false);
    setLinePending(null);
    setTool('roi');
    e.target.value = '';
  };

  const drawWhenReady = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (rvfcSupported) {
      (v as any).requestVideoFrameCallback(() => renderRef.current());
    }
    requestAnimationFrame(() => {
      renderRef.current();
      requestAnimationFrame(() => renderRef.current());
    });
  }, [rvfcSupported]);

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setVideoDims({ width: v.videoWidth, height: v.videoHeight });
    onVideoSize({ width: v.videoWidth, height: v.videoHeight });
    setDuration(v.duration || 0);
    onVideoDuration?.(v.duration || 0);
    setVideoLoaded(true);
    onVideoLoaded(true);
    try { v.currentTime = 0; } catch (_) { /* noop */ }
  };

  // =========================================================
  // 校正の適用
  // =========================================================

  const applyLine = useCallback((p1: Point, p2: Point) => {
    onUpdateCalibration(recalcScale({
      ...calibration,
      mode: 'line',
      linePoints: [
        { x: Math.round(p1.x), y: Math.round(p1.y) },
        { x: Math.round(p2.x), y: Math.round(p2.y) },
      ],
    }));
  }, [calibration, onUpdateCalibration]);

  const applyPlane = useCallback((pts: Point[]) => {
    onUpdateCalibration(recalcScale({
      ...calibration,
      mode: 'plane',
      planePoints: pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    }));
  }, [calibration, onUpdateCalibration]);

  // =========================================================
  // 修正ツールで「掴む点」の決め方
  // =========================================================
  //
  // o.center はトラッカーが最後に居た位置なので、シークで別の時刻へ移ると
  // 画面に描かれている点とズレる。ズレたまま当たり判定に使うと掴み損ね、
  // 意図せずパンになってしまう。
  // そこで現在時刻に最も近い記録フレームの点を優先して掴ませる。

  /** 現在の動画時刻に最も近い記録フレームの index。記録が無ければ -1 */
  const nearestFrameIndex = useCallback((t: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < historyData.length; i++) {
      const d = Math.abs(historyData[i].timestamp - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }, [historyData]);

  /** そのオブジェクトを掴める画面上の点 */
  const grabPoint = useCallback(
    (o: TrackedObject, frameIdx: number): Point | null => {
      const it = frameIdx >= 0 ? historyData[frameIdx].objects[o.id] : undefined;
      if (it && !it.lost) return { x: it.xPx, y: it.yPx };
      return o.center ?? null;
    },
    [historyData]
  );

  /** 操作結果の表示は少し経ったら消す */
  useEffect(() => {
    if (!correctMsg) return;
    const id = window.setTimeout(() => setCorrectMsg(null), 2600);
    return () => window.clearTimeout(id);
  }, [correctMsg]);

  useEffect(() => { if (tool !== 'correct') setCorrectMsg(null); }, [tool]);

  /**
   * n コマ分だけ進む／戻る。
   *
   * 進んだあとに「実際に表示されたフレームの時刻」を読み直して覚えておく。
   * fps の推定がずれていても、この値を起点に次のコマを狙うので
   * 誤差が積み上がらない。手動トラッキングはこの時刻を記録に使う。
   */
  const stepFrame = useCallback(async (n: number) => {
    const v = videoRef.current;
    if (!v || !videoLoaded || steppingRef.current) return;
    steppingRef.current = true;
    v.pause();
    setIsPlaying(false);
    try {
      const t = await stepFrames(v, fpsRef.current.value, n);
      frameTimeRef.current = t;
      setCurrentTime(t);
    } finally {
      steppingRef.current = false;
    }
  }, [videoLoaded, setIsPlaying]);

  // =========================================================
  // 手動トラッキング
  // =========================================================

  /** 同じコマとみなす時刻の許容差。App 側と同じ基準にそろえる */
  const frameTolerance = useMemo(() => {
    const dt = historyData.length > 1
      ? medianDt(historyData.map(f => f.timestamp))
      : 0;
    return (dt > 0 ? dt : 1 / Math.max(1, fpsSettings.value)) * 0.5;
  }, [historyData, fpsSettings.value]);

  /** 「n コマおき」が実時間で何秒になるか。加速度の精度はここで決まる */
  const manualInterval = manualStepInterval(
    manualStep, fpsSettings.value, timeScale(fpsSettings)
  );

  // fps や撮影fps が決まったら、間隔が適切になるコマ数を提案する。
  // 240fps スローで 1 コマおきに打つと実時間 4ms しか空かず、
  // 加速度のばらつきが 40% にもなる（合成データでの実測）。
  useEffect(() => {
    if (manualStepTouched.current) return;
    setManualStep(recommendManualStep(fpsSettings.value, timeScale(fpsSettings)));
  }, [fpsSettings]);

  /** 打つ対象の並び */
  const manualOrder = objects.filter(o => o.active).map(o => o.id);

  /** いま打つべき物体と、それがそのコマの最後かどうか */
  const manualTarget = nextManualTarget(
    historyData, manualOrder, frameTimeRef.current, frameTolerance
  );

  /** 操作結果の表示は少し経ったら消す */
  useEffect(() => {
    if (!manualMsg) return;
    const id = window.setTimeout(() => setManualMsg(null), 2000);
    return () => window.clearTimeout(id);
  }, [manualMsg]);

  useEffect(() => { if (tool !== 'manual') setManualMsg(null); }, [tool]);

  // =========================================================
  // ポインタ操作
  // =========================================================

  const beginSingle = useCallback((pt: Point, screen: { x: number; y: number }) => {
    const hitR = HANDLE_TOUCH_PX * canvasPerScreen();

    // ---- 手動トラッキング ----
    // タップした位置がそのままその物体・そのコマの記録になる。
    // 記録する時刻は「要求した時刻」ではなく、実際に表示されているフレームの時刻。
    if (tool === 'manual' && !isPlaying) {
      const objId = manualPick ?? nextManualTarget(
        historyData, manualOrder, frameTimeRef.current, frameTolerance
      ).objId;
      if (!objId) {
        setManualMsg('追跡対象がありません');
        return;
      }
      const complete = onManualPlace(objId, pt, frameTimeRef.current);
      // 指名は 1 回きり。打ったら自動の順番に戻す
      setManualPick(null);
      if (complete) {
        setManualMsg(`${objId} を記録 → ${manualStep} コマ進みます`);
        void stepFrame(manualStep);
      } else {
        setManualMsg(`${objId} を記録`);
      }
      return;
    }

    // ---- 原点指定 ----
    // 他のどのツールよりも先に見る。1 タップで確定して移動ツールへ戻る。
    if (tool === 'manual') {
      return {
        text: manualMsg ?? (
          isPlaying
            ? '一時停止してから対象をタップしてください'
            : manualTarget.objId
              ? `${manualTarget.objId} の位置をタップ${
                  manualTarget.isLast ? `（次で ${manualStep} コマ進みます）` : ''
                }`
              : '追跡対象がありません'
        ),
        bg: 'rgba(10,132,255,0.95)', color: '#fff',
      };
    }
    if (tool === 'origin') {
      onUpdateCalibration({
        ...calibration,
        origin: { x: Math.round(pt.x), y: Math.round(pt.y) },
      });
      setTool('pan');
      return;
    }

    // ---- 校正ツール ----
    if (tool === 'calib') {
      const existing = calibration.mode === 'plane'
        ? calibration.planePoints
        : calibration.linePoints;

      // 既にある点は、指定モード中かどうかに関わらず掴んで動かせる
      for (let i = 0; i < existing.length; i++) {
        if (pixelDistance(pt, existing[i]) <= hitR) {
          setCalibHandle(i);
          setGesture({ kind: 'calib-handle', index: i });
          setDragCurrent(pt);
          return;
        }
      }

      // 新しい点を置けるのは「指定を開始」しているときだけ。
      // そうしないと、微調整のつもりのタップで校正が消えてしまう。
      if (isLineCalibrating) {
        if (calibration.mode === 'plane') {
          setGesture({ kind: 'calib-handle', index: -1 });
          setDragCurrent(pt);
        } else {
          setGesture({ kind: 'calib-new' });
          setDragStart(pt);
          setDragCurrent(pt);
        }
        return;
      }

      setGesture({ kind: 'pan' });
      downScreenRef.current = screen;
      return;
    }

    // ---- 手動修正ツール ----
    if (tool === 'correct') {
      const v = videoRef.current;
      const fi = nearestFrameIndex(v ? v.currentTime : 0);
      let hitId: string | null = null;
      let best = hitR * 1.5;
      objects.forEach(o => {
        if (!o.active || o.status === 'exited') return;
        const gp = grabPoint(o, fi);
        if (!gp) return;
        const d = pixelDistance(pt, gp);
        if (d < best) { best = d; hitId = o.id; }
      });
      if (hitId) {
        setGesture({ kind: 'manual', objId: hitId });
        setDragCurrent(pt);
        return;
      }
      // 掴めなかったらパンにフォールバックするが、
      // 「直したつもりで何も直っていない」ことが分かるように知らせる
      setCorrectMsg('直したい点の近くからドラッグしてください');
      setGesture({ kind: 'pan' });
      downScreenRef.current = screen;
      return;
    }

    // ---- 枠ツール ----
    if (tool === 'roi') {
      setGesture({ kind: 'roi' });
      setDragStart(pt);
      setDragCurrent(pt);
      return;
    }

    // ---- 移動ツール ----
    setGesture({ kind: 'pan' });
    downScreenRef.current = screen;
    // nearestFrameIndex / grabPoint は historyData を閉じ込んでいるので
    // 依存に入れないと古い記録で当たり判定してしまう
  }, [
    tool, calibration, objects, canvasPerScreen, setCalibHandle, isLineCalibrating,
    nearestFrameIndex, grabPoint, onUpdateCalibration, setTool,
    historyData, frameTolerance, onManualPlace, manualStep, stepFrame, isPlaying,
    manualOrder.join(','), manualPick,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!videoLoaded) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      downScreenRef.current = { x: e.clientX, y: e.clientY };
      beginSingle(toCanvasPt(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
    } else if (pointersRef.current.size === 2) {
      // 2本目が触れたらツール操作は破棄してピンチへ切り替える
      setGesture(null);
      setDragStart(null);
      setDragCurrent(null);
      const [a, b] = Array.from(pointersRef.current.values());
      pinchRef.current = {
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current;
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId)!;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // ---------- 2本指: ピンチズーム＋パン ----------
    if (pts.size >= 2) {
      const [a, b] = Array.from(pts.values());
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const p = pinchRef.current;
      if (p && p.dist > 0) {
        setView(v => {
          const stage = stageRef.current?.getBoundingClientRect();
          if (!stage) return v;
          const z = Math.min(12, Math.max(1, v.z * (dist / p.dist)));
          // ピンチ前に中点の下にあった画像上の位置を、ピンチ後も同じ場所に留める
          const lx = (p.mid.x - stage.left - v.tx) / v.z;
          const ly = (p.mid.y - stage.top - v.ty) / v.z;
          return clampView({
            z,
            tx: mid.x - stage.left - lx * z,
            ty: mid.y - stage.top - ly * z,
          });
        });
      }
      pinchRef.current = { dist, mid };
      return;
    }

    // ---------- 1本指 ----------
    if (!gesture) return;

    if (gesture.kind === 'pan') {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView(v => clampView({ z: v.z, tx: v.tx + dx, ty: v.ty + dy }));
      return;
    }

    const pt = toCanvasPt(e.clientX, e.clientY);
    setDragCurrent(pt);

    if (gesture.kind === 'calib-handle' && gesture.index >= 0) {
      if (calibration.mode === 'line' && calibration.linePoints.length === 2) {
        const next = calibration.linePoints.map((p, i) => (i === gesture.index ? pt : p));
        applyLine(next[0], next[1]);
      } else if (calibration.mode === 'plane') {
        applyPlane(calibration.planePoints.map((p, i) => (i === gesture.index ? pt : p)));
      }
    }
  };

  const endGesture = useCallback((clientX: number, clientY: number) => {
    const g = gesture;
    const down = downScreenRef.current;
    const moved = down ? Math.hypot(clientX - down.x, clientY - down.y) : 0;
    const isTap = moved < TAP_SLOP_PX;
    const pt = toCanvasPt(clientX, clientY);

    if (g) {
      if (g.kind === 'manual') {
        const v = videoRef.current;
        const applied = onManualCorrect(
          g.objId, dragCurrent || pt, v ? v.currentTime : 0, v || undefined
        );
        // 書き換えられなかったことを黙って済ませない。
        // 枠だけ動いた状態は「直ったつもりで直っていない」ので一番まずい。
        setCorrectMsg(
          applied
            ? '点を修正しました'
            : 'この時刻には記録がありません（枠のみ更新）'
        );
      } else if (g.kind === 'roi') {
        if (isTap && dragStart) {
          // タップ: 既定サイズの正方形をその点を中心に置く
          const half = roiSize / 2;
          onUpdateRoi(selectedObjId, {
            x: Math.round(dragStart.x - half),
            y: Math.round(dragStart.y - half),
            width: Math.round(roiSize),
            height: Math.round(roiSize),
          }, videoRef.current || undefined);
        } else if (dragStart && dragCurrent) {
          let x = Math.min(dragStart.x, dragCurrent.x);
          let y = Math.min(dragStart.y, dragCurrent.y);
          let w = Math.abs(dragCurrent.x - dragStart.x);
          let h = Math.abs(dragCurrent.y - dragStart.y);
          if (squareMode) {
            const side = Math.max(w, h);
            w = side; h = side;
            if (dragCurrent.x < dragStart.x) x = dragStart.x - side;
            if (dragCurrent.y < dragStart.y) y = dragStart.y - side;
          }
          if (w > 4 && h > 4) {
            onUpdateRoi(selectedObjId, {
              x: Math.round(x), y: Math.round(y),
              width: Math.round(w), height: Math.round(h),
            }, videoRef.current || undefined);
          }
        }
      } else if (g.kind === 'calib-new') {
        if (!isTap && dragStart && dragCurrent && pixelDistance(dragStart, dragCurrent) >= 6) {
          applyLine(dragStart, dragCurrent);
          setLinePending(null);
          setIsLineCalibrating(false);
          setTool('pan');
        } else if (isTap && dragStart) {
          // タップ2回で2点を置く
          if (!linePending) {
            setLinePending(dragStart);
          } else {
            applyLine(linePending, dragStart);
            setLinePending(null);
            setIsLineCalibrating(false);
            setTool('pan');
          }
        }
      } else if (g.kind === 'calib-handle' && g.index < 0 && calibration.mode === 'plane') {
        // 平面校正: 角を順番に置く
        const quad = calibration.planePoints;
        const next = quad.length >= 4 ? [pt] : [...quad, pt];
        if (next.length === 4) {
          applyPlane(next);
          setIsLineCalibrating(false);
          setCalibHandle(0);
          setTool('pan');
        } else {
          onUpdateCalibration({ ...calibration, planePoints: next, homography: null });
        }
      }
    }

    setGesture(null);
    setDragStart(null);
    setDragCurrent(null);
    downScreenRef.current = null;
  }, [
    gesture, dragStart, dragCurrent, squareMode, roiSize, selectedObjId, linePending,
    calibration, onUpdateRoi, onManualCorrect, applyLine, applyPlane,
    onUpdateCalibration, setIsLineCalibrating, setTool, setCalibHandle, toCanvasPt,
  ]);

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const pts = pointersRef.current;
    pts.delete(e.pointerId);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }

    if (pts.size === 0) {
      pinchRef.current = null;
      endGesture(e.clientX, e.clientY);
    } else if (pts.size === 1) {
      // 2本指→1本指。残った指でのパンに引き継ぐ
      pinchRef.current = null;
      setGesture({ kind: 'pan' });
      const remaining = Array.from(pts.values())[0];
      downScreenRef.current = remaining;
    }
  };

  // =========================================================
  // 虫めがね
  // =========================================================

  const loupePos = (() => {
    if (!gesture || gesture.kind === 'pan' || !dragCurrent) return null;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return null;
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const screenX = cr.left + (dragCurrent.x / canvas.width) * cr.width - sr.left;
    // 指と重ならないよう、触っている側と反対の上隅に出す
    const left = screenX > sr.width / 2 ? 10 : sr.width - LOUPE_SIZE - 10;
    return { left, top: 10 };
  })();

  const drawLoupe = useCallback(() => {
    const lc = loupeRef.current;
    const canvas = canvasRef.current;
    if (!lc || !canvas || !dragCurrent) return;
    const ctx = lc.getContext('2d');
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    const dispScale = r.width > 0 ? r.width / canvas.width : 1; // 画面px / 動画px
    const srcSize = LOUPE_SIZE / Math.max(0.001, dispScale * LOUPE_MAG);
    const sx = dragCurrent.x - srcSize / 2;
    const sy = dragCurrent.y - srcSize / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(canvas, sx, sy, srcSize, srcSize, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    } catch (_) { /* 範囲外は無視 */ }
    // 中心の十字
    const c = LOUPE_SIZE / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c - 11, c); ctx.lineTo(c - 3, c);
    ctx.moveTo(c + 3, c); ctx.lineTo(c + 11, c);
    ctx.moveTo(c, c - 11); ctx.lineTo(c, c - 3);
    ctx.moveTo(c, c + 3); ctx.lineTo(c, c + 11);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(99,102,241,0.9)';
    ctx.beginPath();
    ctx.arc(c, c, 2.5, 0, Math.PI * 2);
    ctx.stroke();
  }, [dragCurrent]);

  // =========================================================
  // 描画
  // =========================================================

  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    if (video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 画面上での見た目の太さをそろえる。
    // ズームしているときは細く描かないと、拡大時に線が対象を覆い隠す。
    const k = Math.max(0.6, (vw / 960) / Math.max(1, view.z * 0.7));

    // ----- 軌跡 -----
    if (showTrail && historyData.length > 1) {
      objects.forEach(obj => {
        if (!obj.active) return;
        const segments: Point[][] = [];
        let cur: Point[] = [];
        for (let i = 0; i < historyData.length; i++) {
          const item = historyData[i].objects[obj.id];
          if (item && !item.lost) cur.push({ x: item.xPx, y: item.yPx });
          else if (cur.length > 0) { segments.push(cur); cur = []; }
        }
        if (cur.length > 0) segments.push(cur);

        const points = segments.flat().slice(-MAX_TRAIL_POINTS);
        if (points.length < 1) return;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const stroke = (color: string, width: number) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          segments.forEach(seg => {
            if (seg.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(seg[0].x, seg[0].y);
            for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
            ctx.stroke();
          });
        };
        stroke('rgba(0,0,0,0.45)', 4.5 * k);
        stroke(obj.color, 2.5 * k);

        for (let i = 0; i < historyData.length; i++) {
          const it = historyData[i].objects[obj.id];
          if (it && it.manual && !it.lost) {
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 4 * k, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = obj.color;
            ctx.lineWidth = 1.5 * k;
            ctx.stroke();
          }
        }

        const last = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = obj.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();

        if (obj.status === 'exited') {
          ctx.beginPath();
          ctx.arc(last.x, last.y, 9 * k, 0, Math.PI * 2);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2 * k;
          ctx.setLineDash([4 * k, 3 * k]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    }

    // ----- ROI 枠 -----
    objects.forEach(obj => {
      if (!obj.active || !obj.roi || obj.status === 'exited') return;
      const { x, y, width, height } = obj.roi;
      const isLost = obj.status === 'lost';
      const isSel = obj.id === selectedObjId;
      const color = isLost ? '#ef4444' : obj.color;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = (isSel ? 2.5 : 1.5) * k;
      ctx.setLineDash(isLost ? [6 * k, 4 * k] : []);
      ctx.strokeRect(x, y, width, height);
      ctx.restore();

      const label = isLost ? `${obj.id} LOST` : obj.id;
      ctx.font = `bold ${11 * k}px Inter, sans-serif`;
      const tw = ctx.measureText(label).width;
      const lh = 19 * k;
      const ly = Math.max(0, y - lh - 3 * k);
      ctx.fillStyle = color;
      ctx.fillRect(x, ly, tw + 12 * k, lh);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 6 * k, ly + 13.5 * k);

      const c = obj.center || { x: x + width / 2, y: y + height / 2 };
      ctx.beginPath();
      ctx.moveTo(c.x - 7 * k, c.y); ctx.lineTo(c.x + 7 * k, c.y);
      ctx.moveTo(c.x, c.y - 7 * k); ctx.lineTo(c.x, c.y + 7 * k);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
    });

    // ----- 枠ドラッグ中のプレビュー -----
    if (gesture?.kind === 'roi' && dragStart && dragCurrent) {
      const moved = pixelDistance(dragStart, dragCurrent);
      let rx: number, ry: number, rw: number, rh: number;
      if (moved < TAP_SLOP_PX * canvasPerScreen()) {
        // タップ相当。これから置かれる既定サイズの枠を見せる
        rw = roiSize; rh = roiSize;
        rx = dragStart.x - roiSize / 2;
        ry = dragStart.y - roiSize / 2;
      } else {
        rx = Math.min(dragStart.x, dragCurrent.x);
        ry = Math.min(dragStart.y, dragCurrent.y);
        rw = Math.abs(dragCurrent.x - dragStart.x);
        rh = Math.abs(dragCurrent.y - dragStart.y);
        if (squareMode) {
          const side = Math.max(rw, rh);
          rw = side; rh = side;
          if (dragCurrent.x < dragStart.x) rx = dragStart.x - side;
          if (dragCurrent.y < dragStart.y) ry = dragStart.y - side;
        }
      }
      const target = objects.find(o => o.id === selectedObjId);
      const tooSmall = Math.min(rw, rh) < MIN_ROI_SIZE;
      const marginal = !tooSmall && Math.min(rw, rh) < RECOMMENDED_ROI_SIZE;
      const guide = tooSmall ? '#ef4444' : marginal ? '#f59e0b' : (target?.color || '#fff');

      ctx.strokeStyle = guide;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([5 * k, 4 * k]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = tooSmall ? 'rgba(239,68,68,0.16)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(rx, ry, rw, rh);

      const txt = `${Math.round(rw)}×${Math.round(rh)}px`
        + (tooSmall ? ` 小さすぎ` : marginal ? ' やや小' : '');
      ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(rx - 2 * k, ry + rh + 3 * k, tw + 10 * k, 18 * k);
      ctx.fillStyle = guide;
      ctx.fillText(txt, rx + 3 * k, ry + rh + 16 * k);
    }

    // ----- 2点間校正 -----
    const drawLine = (p1: Point, p2: Point, live: boolean) => {
      const dist = pixelDistance(p1, p2);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 5 * k;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.strokeStyle = live ? '#fbbf24' : '#f59e0b';
      ctx.lineWidth = 2.5 * k;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      [p1, p2].forEach((p, i) => {
        const focused = tool === 'calib' && calibHandle === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (focused ? 9 : 7) * k, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#f59e0b' : '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = (focused ? 3 : 2) * k;
        ctx.stroke();
      });
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const label = `${dist.toFixed(1)}px = ${calibration.realSizeValue}${calibration.unit}`;
      ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(mx - tw / 2 - 7 * k, my - 27 * k, tw + 14 * k, 21 * k);
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(label, mx - tw / 2, my - 12 * k);
      ctx.restore();
    };

    if (calibration.mode === 'line') {
      if (gesture?.kind === 'calib-new' && dragStart && dragCurrent
        && pixelDistance(dragStart, dragCurrent) > 6) {
        drawLine(dragStart, dragCurrent, true);
      } else if (calibration.linePoints.length === 2) {
        drawLine(calibration.linePoints[0], calibration.linePoints[1], false);
      }
      // タップで置いた1点目
      if (linePending) {
        ctx.beginPath();
        ctx.arc(linePending.x, linePending.y, 7 * k, 0, Math.PI * 2);
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 * k;
        ctx.stroke();
      }
    }

    // ----- 平面校正 -----
    if (calibration.mode === 'plane') {
      const quad = calibration.planePoints;
      if (quad.length === 4 && calibration.homography) {
        const Hinv = invertHomography(calibration.homography as Matrix3);
        if (Hinv) {
          const W = calibration.planeWidth;
          const Hh = calibration.planeHeight;
          ctx.save();
          ctx.strokeStyle = 'rgba(16, 217, 124, 0.55)';
          ctx.lineWidth = 1.2 * k;
          for (let i = 0; i <= 4; i++) {
            const u = (W * i) / 4;
            const v = (Hh * i) / 4;
            ctx.beginPath();
            for (let j = 0; j <= 12; j++) {
              const p = applyHomography(Hinv, { x: u, y: (Hh * j) / 12 });
              if (!isFinite(p.x)) break;
              j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
            ctx.beginPath();
            for (let j = 0; j <= 12; j++) {
              const p = applyHomography(Hinv, { x: (W * j) / 12, y: v });
              if (!isFinite(p.x)) break;
              j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
          ctx.restore();
        }
      } else if (quad.length >= 2) {
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([6 * k, 4 * k]);
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.stroke();
        ctx.restore();
      }

      const cornerNames = ['左上', '右上', '右下', '左下'];
      quad.forEach((p, i) => {
        const done = quad.length === 4 && calibration.homography;
        const focused = tool === 'calib' && calibHandle === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (focused ? 10 : 8) * k, 0, Math.PI * 2);
        ctx.fillStyle = done ? '#10d97c' : '#f59e0b';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = (focused ? 3 : 2) * k;
        ctx.stroke();
        ctx.fillStyle = '#06101f';
        ctx.font = `bold ${11 * k}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5 * k);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (quad.length < 4) {
          ctx.fillStyle = '#fbbf24';
          ctx.font = `${11 * k}px Inter, sans-serif`;
          ctx.fillText(cornerNames[i], p.x + 12 * k, p.y - 10 * k);
        }
      });

      if (quad.length === 4 && calibration.homography) {
        const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const label = (p: Point, text: string) => {
          ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = 'rgba(0,0,0,0.78)';
          ctx.fillRect(p.x - tw / 2 - 7 * k, p.y - 11 * k, tw + 14 * k, 21 * k);
          ctx.fillStyle = '#10d97c';
          ctx.fillText(text, p.x - tw / 2, p.y + 4 * k);
        };
        label(mid(quad[0], quad[1]), `${calibration.planeWidth}${calibration.unit}`);
        label(mid(quad[1], quad[2]), `${calibration.planeHeight}${calibration.unit}`);
      }
    }

    // ----- 手動記録: そのコマに打ってある点を示す -----
    // どの物体を打つ番か分からなくなるのが一番の混乱なので、
    // 現在のコマに既に打ってある点を色付きで示す。
    if (tool === 'manual' && !isPlaying) {
      const cur = historyData.find(
        f => Math.abs(f.timestamp - frameTimeRef.current) <= frameTolerance
      );
      objects.filter(o => o.active).forEach(o => {
        const it = cur?.objects[o.id];
        if (!it || it.lost) return;
        ctx.beginPath();
        ctx.arc(it.xPx, it.yPx, 8 * k, 0, Math.PI * 2);
        ctx.fillStyle = o.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 2 * k;
        ctx.stroke();
        ctx.font = `bold ${12 * k}px Inter, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 3 * k;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeText(o.id, it.xPx + 12 * k, it.yPx);
        ctx.fillText(o.id, it.xPx + 12 * k, it.yPx);
      });
    }

    // ----- 原点 -----
    // 指定されているときだけ描く。未指定なら従来どおり画像の隅が原点で、
    // そこに印を出しても情報量がないため。
    if (calibration.origin) {
      const o = calibration.origin;
      const r = 13 * k;
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 4.5 * k;
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        ctx.moveTo(o.x - r, o.y); ctx.lineTo(o.x + r, o.y);
        ctx.moveTo(o.x, o.y - r); ctx.lineTo(o.x, o.y + r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(o.x, o.y, r * 0.55, 0, Math.PI * 2);
        ctx.stroke();
        // 1 周目は影、2 周目に本体を重ねて背景に埋もれないようにする
        ctx.strokeStyle = '#fcd34d';
        ctx.lineWidth = 2 * k;
      }
      // 軸の向きを矢印で示す（yUp かどうかが一目で分かる）
      const up = calibration.yUp ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(o.x + r, o.y);
      ctx.lineTo(o.x + r - 4.5 * k, o.y - 3.5 * k);
      ctx.moveTo(o.x + r, o.y);
      ctx.lineTo(o.x + r - 4.5 * k, o.y + 3.5 * k);
      ctx.moveTo(o.x, o.y + up * r);
      ctx.lineTo(o.x - 3.5 * k, o.y + up * (r - 4.5 * k));
      ctx.moveTo(o.x, o.y + up * r);
      ctx.lineTo(o.x + 3.5 * k, o.y + up * (r - 4.5 * k));
      ctx.stroke();

      ctx.font = `bold ${12 * k}px Inter, sans-serif`;
      ctx.fillStyle = '#fcd34d';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('原点', o.x + r + 3 * k, o.y + 3 * k);
      ctx.restore();
    }

    // ----- 修正ツールのハンドル -----
    // 当たり判定と同じ点に出す。ここがズレていると「掴めるように見えるのに
    // 掴めない」状態になり、原因が分からない。
    if (tool === 'correct' && !isPlaying) {
      const vEl = videoRef.current;
      const fi = nearestFrameIndex(vEl ? vEl.currentTime : 0);
      objects.forEach(o => {
        if (!o.active || o.status === 'exited') return;
        const gp = grabPoint(o, fi);
        if (!gp) return;
        const dragging = gesture?.kind === 'manual' && gesture.objId === o.id;
        const c = dragging && dragCurrent ? dragCurrent : gp;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 14 * k, 0, Math.PI * 2);
        ctx.strokeStyle = dragging ? '#fff' : o.color;
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
  }, [
    historyData, objects, selectedObjId, showTrail, gesture, dragStart, dragCurrent,
    squareMode, calibration, tool, isPlaying, roiSize, linePending, calibHandle,
    canvasPerScreen, view.z, nearestFrameIndex, grabPoint, frameTolerance,
  ]);

  renderRef.current = renderFrame;

  // 停止中は状態が変わるたびに1回描く
  useEffect(() => {
    if (!isPlaying) renderFrame();
  }, [renderFrame, isPlaying]);

  // 描画のあとに虫めがねを更新する
  useEffect(() => {
    if (loupePos) {
      const id = requestAnimationFrame(drawLoupe);
      return () => cancelAnimationFrame(id);
    }
    return;
  }, [drawLoupe, loupePos, renderFrame]);

  // =========================================================
  // 再生ループ（requestVideoFrameCallback）
  // =========================================================

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isPlaying) return;

    let cancelled = false;
    let handle: number | null = null;
    let rafId: number | null = null;

    const step = (mediaTime: number) => {
      const prev = lastMediaTimeRef.current;
      if (prev !== null) {
        const dt = mediaTime - prev;
        if (dt > 0.0005 && dt < 1) {
          const arr = frameIntervalsRef.current;
          arr.push(dt);
          if (arr.length > 60) arr.shift();
          if (arr.length >= 10) {
            const sorted = [...arr].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const fps = Math.round((1 / median) * 1000) / 1000;
            // ここでは fps を更新しない。実測で真値の半分が出たため
            // （詳細は utils/videoFrame.ts）、読み込み時のシーク計測だけに任せる。
          }
        }
      }
      lastMediaTimeRef.current = mediaTime;
      // 再生中も「いま見えているフレームの時刻」を更新しておく。
      // 一時停止した直後に手で点を打つとき、この値が使われる
      frameTimeRef.current = mediaTime;

      processRef.current(v, mediaTime, frameCounterRef.current++);
      renderRef.current();

      const now = performance.now();
      if (now - lastUiTimeRef.current > 150) {
        lastUiTimeRef.current = now;
        setCurrentTime(mediaTime);
      }
    };

    if (rvfcSupported) {
      const cb = (_now: number, meta: any) => {
        if (cancelled) return;
        step(typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime);
        handle = (v as any).requestVideoFrameCallback(cb);
      };
      handle = (v as any).requestVideoFrameCallback(cb);
    } else {
      let lastT = -1;
      const loop = () => {
        if (cancelled) return;
        const t = v.currentTime;
        if (t !== lastT && !v.paused && !v.ended) { lastT = t; step(t); }
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }

    return () => {
      cancelled = true;
      if (handle !== null && rvfcSupported) {
        try { (v as any).cancelVideoFrameCallback(handle); } catch (_) { /* noop */ }
      }
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, rvfcSupported]);

  // =========================================================
  // 再生制御
  // =========================================================

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    if (isPlaying) {
      v.pause();
      setIsPlaying(false);
    } else {
      // 再生中に枠を描こうとして誤爆しないよう、移動ツールへ戻す
      if (tool === 'roi' || tool === 'calib') setTool('pan');
      v.playbackRate = playbackRate;
      v.play().then(() => setIsPlaying(true)).catch(err => {
        console.error('[VideoStage] 再生できませんでした:', err);
      });
    }
  };

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // 読み込み直後に一度だけ、ファイルの fps を実測する。
  //
  // 通常の自動計測は再生中の rVFC 間隔から行うので、
  // 一度も再生せずにコマ送りだけする使い方（手動トラッキング）では
  // 既定値 30 のまま走ってしまう。刻みが実フレーム間隔と合わないと、
  // 1 回押して 2 コマ進んだり同じコマに留まったりする。
  useEffect(() => {
    if (!videoLoaded) return;
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    (async () => {
      const fps = await measureFileFps(v);
      if (cancelled) return;
      if (fps && Math.abs(fps - fpsRef.current.value) > 0.05) {
        setFpsRef.current({ ...fpsRef.current, value: fps });
      }
      frameTimeRef.current = v.currentTime;
      setCurrentTime(v.currentTime);
      renderRef.current();
    })();
    return () => { cancelled = true; };
  }, [videoLoaded]);

  /** グラフからのシーク要求。再生中なら止めてから飛ぶ
   *  （そのまま再生を続けると、飛んだ先から重複して記録してしまう） */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seekRequest || !videoLoaded) return;
    v.pause();
    setIsPlaying(false);
    // 実際に表示されたフレームの時刻を覚えておく（要求時刻とは限らない）
    seekToFrameTime(v, seekRequest.t).then(t => {
      frameTimeRef.current = t;
      setCurrentTime(t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  const handleRestart = () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
      setCurrentTime(0);
    }
    setIsPlaying(false);
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
    onClearTrail();
  };


  // =========================================================
  // 表示用の派生値
  // =========================================================

  const exited = objects.filter(o => o.active && o.status === 'exited');
  const lost = objects.filter(o => o.active && o.status === 'lost');
  const selected = objects.find(o => o.id === selectedObjId);

  const hint: { text: string; bg: string; color: string } | null = (() => {
    if (!videoLoaded) return null;
    if (tool === 'calib') {
      if (calibration.mode === 'plane') {
        const n = calibration.planePoints.length % 4;
        return {
          text: `${['左上', '右上', '右下', '左下'][n]}の角をタップ（${calibration.planePoints.length}/4）`,
          bg: 'rgba(245,158,11,0.95)', color: '#000',
        };
      }
      return {
        text: linePending ? '2点目をタップ' : '長さの分かる端から端までなぞる／2回タップ',
        bg: 'rgba(245,158,11,0.95)', color: '#000',
      };
    }
    if (tool === 'roi') {
      return {
        text: `${selectedObjId} の枠 — 対象をタップ（または囲んでドラッグ）`,
        bg: `${selected?.color || '#6366f1'}f0`, color: '#fff',
      };
    }
    if (tool === 'origin') {
      return {
        text: '原点にしたい位置をタップ',
        bg: 'rgba(245,158,11,0.95)', color: '#000',
      };
    }
    if (tool === 'correct') {
      return {
        text: correctMsg
          ?? (isPlaying ? '一時停止してから点をドラッグしてください' : 'ずれた点をドラッグして直す'),
        bg: 'rgba(99,102,241,0.95)', color: '#fff',
      };
    }
    if (lost.length > 0) {
      return {
        text: `⚠ LOST: ${lost.map(o => o.id).join(', ')} — 枠を置き直してください`,
        bg: 'rgba(239,68,68,0.95)', color: '#fff',
      };
    }
    if (exited.length > 0) {
      return {
        text: `画面外へ退出 → 追尾終了: ${exited.map(o => o.id).join(', ')}`,
        bg: 'rgba(245,158,11,0.9)', color: '#000',
      };
    }
    return null;
  })();

  const toolBtn = (t: StageTool, icon: React.ReactNode, label: string) => (
    <button
      key={t}
      className={`btn btn-icon btn-sm btn-float ${tool === t ? 'is-active' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => {
        setTool(t);
        if (t !== 'calib') { setIsLineCalibrating(false); setLinePending(null); }
      }}
      disabled={!videoLoaded}
    >
      {icon}
    </button>
  );

  return (
    <>
      {/* ================= ステージ ================= */}
      <div
        className="stage"
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <video
          ref={videoRef}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={() => { setVideoLoaded(true); onVideoLoaded(true); drawWhenReady(); }}
          onSeeked={() => {
            const v = videoRef.current;
            if (v) {
              setCurrentTime(v.currentTime);
              // シークバーを直接動かされた場合もここを通る。
              // 覚えている「表示中フレームの時刻」を古いままにしない
              frameTimeRef.current = v.currentTime;
            }
            drawWhenReady();
          }}
          onEnded={() => setIsPlaying(false)}
          onPause={() => setIsPlaying(false)}
          playsInline
          muted
          preload="auto"
          style={{ position: 'absolute', opacity: 0.001, width: 1, height: 1, pointerEvents: 'none', zIndex: -100 }}
        />

        <canvas
          ref={canvasRef}
          className="stage__canvas"
          style={{
            width: base.w > 0 ? `${base.w}px` : '100%',
            height: base.h > 0 ? `${base.h}px` : '100%',
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`,
          }}
        />

        {/* ---- ツールバー ---- */}
        {videoLoaded && (
          <div className="stage__toolbar">
            {toolBtn('pan', <Hand size={17} />, '移動')}
            {toolBtn('roi', <Square size={17} />, '枠を指定')}
            {toolBtn('correct', <Move size={17} />, '手動修正')}
            {toolBtn('manual', <MousePointerClick size={17} />, '手動記録')}
            {toolBtn('origin', <Target size={17} />, '原点')}
            {(isLineCalibrating || tool === 'calib') && toolBtn('calib', <Crosshair size={17} />, '校正')}
          </div>
        )}

        {/* ---- ズーム ---- */}
        {videoLoaded && (
          <div className="stage__zoombar">
            <button className="btn btn-icon btn-sm btn-float" aria-label="拡大" onClick={() => zoomBy(1.5)}>
              <ZoomIn size={17} />
            </button>
            <button className="btn btn-icon btn-sm btn-float" aria-label="縮小" onClick={() => zoomBy(1 / 1.5)}>
              <ZoomOut size={17} />
            </button>
            <button className="btn btn-icon btn-sm btn-float" aria-label="全体表示" onClick={resetView}>
              <Maximize size={16} />
            </button>
            <button
              className={`btn btn-icon btn-sm btn-float ${showTrail ? 'is-active' : ''}`}
              aria-label="軌跡の表示"
              onClick={() => setShowTrail(v => !v)}
            >
              <Route size={17} />
            </button>
            <div
              className="badge mono"
              style={{ justifyContent: 'center', fontSize: '0.62rem', padding: '2px 5px' }}
            >
              {(view.z * 100).toFixed(0)}%
            </div>
          </div>
        )}

        {/* ---- 虫めがね ---- */}
        {loupePos && (
          <div className="loupe" style={{ left: loupePos.left, top: loupePos.top }}>
            <canvas ref={loupeRef} width={LOUPE_SIZE} height={LOUPE_SIZE} />
          </div>
        )}

        {/* ---- ヒント ---- */}
        {hint && (
          <div className="stage__hint" style={{ background: hint.bg, color: hint.color }}>
            {hint.text}
          </div>
        )}

        {/* ---- 動画未選択 ---- */}
        {!videoLoaded && (
          <label
            htmlFor="video-pick"
            style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 16,
              background: 'rgba(8,13,26,0.94)', color: 'var(--text-secondary)', padding: 24,
            }}
          >
            <div style={{
              padding: 22, borderRadius: '50%',
              background: 'rgba(99,102,241,0.12)', border: '2px dashed rgba(99,102,241,0.5)',
            }}>
              <Upload size={38} color="var(--accent-primary)" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '1.02rem', marginBottom: 5 }}>
                解析する動画を選ぶ
              </p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                カメラロールの MP4 / MOV など
              </p>
            </div>
            <input
              id="video-pick" type="file" accept="video/*"
              onChange={handleFileChange} style={{ display: 'none' }}
            />
          </label>
        )}
      </div>

      {/* ================= 再生バー ================= */}
      <div className="playbar">
        <div className="playbar__row">
          <button className="btn btn-primary btn-icon" onClick={togglePlay} disabled={!videoLoaded}
            aria-label={isPlaying ? '一時停止' : '再生して追跡'}>
            {isPlaying ? <Pause size={19} /> : <Play size={19} />}
          </button>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => stepFrame(-1)}
            disabled={!videoLoaded} aria-label="1コマ戻る">
            <ChevronLeft size={17} />
          </button>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => stepFrame(1)}
            disabled={!videoLoaded} aria-label="1コマ進む">
            <ChevronRight size={17} />
          </button>
          <button className="btn btn-secondary btn-icon btn-sm" onClick={handleRestart}
            disabled={!videoLoaded} aria-label="先頭に戻して軌跡を消去">
            <RotateCcw size={16} />
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {PLAYBACK_RATES.map(r => (
              <button
                key={r}
                className={`chip ${playbackRate === r ? 'is-active' : ''}`}
                style={{ minHeight: 34, padding: '4px 9px', fontSize: '0.72rem' }}
                onClick={() => setPlaybackRate(r)}
              >
                {r}×
              </button>
            ))}
          </div>
        </div>

        {/* 打つ物体を選ぶ列。順番どおりでない打ち方をしたいときの逃げ道 */}
        {tool === 'manual' && manualOrder.length > 1 && (
          <div className="playbar__row" style={{ gap: 6 }}>
            <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              次に打つ
            </span>
            {objects.filter(o => o.active).map(o => {
              const isNext = (manualPick ?? manualTarget.objId) === o.id;
              const cur = historyData.find(
                f => Math.abs(f.timestamp - frameTimeRef.current) <= frameTolerance
              );
              const done = !!cur?.objects[o.id]?.manual;
              return (
                <button
                  key={o.id}
                  className="chip"
                  onClick={() => setManualPick(o.id)}
                  style={{
                    minHeight: 34, padding: '4px 11px', fontSize: '0.74rem', fontWeight: 700,
                    background: isNext ? o.color : undefined,
                    color: isNext ? '#fff' : undefined,
                    borderColor: isNext ? o.color : undefined,
                    opacity: done && !isNext ? 0.55 : 1,
                  }}
                >
                  <span style={{
                    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                    background: isNext ? '#fff' : o.color, marginRight: 5,
                  }} />
                  {o.id}{done ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
        )}

        {/* 手動記録のときだけ出す操作列。指で押せる大きさを確保する */}
        {tool === 'manual' && (
          <div className="playbar__row" style={{ gap: 8 }}>
            <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              コマ送り
            </span>
            <input
              type="range" min={1} max={30} step={1} value={manualStep}
              onChange={e => {
                manualStepTouched.current = true;
                setManualStep(parseInt(e.target.value));
              }}
              style={{ flex: 1 }}
            />
            {/* 実時間の間隔を出す。加速度の精度はここでほぼ決まるので、
                コマ数だけ見せても判断できない */}
            <span
              className="mono"
              style={{
                fontSize: '0.74rem', fontWeight: 700, whiteSpace: 'nowrap',
                color: manualInterval < MANUAL_INTERVAL_WARN ? '#fcd34d' : undefined,
              }}
            >
              {manualStep} / {(manualInterval * 1000).toFixed(0)}ms
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setManualMsg(onManualUndo() ? '直前の 1 点を取り消しました' : '取り消せる点がありません');
              }}
              aria-label="直前に打った点を取り消す"
            >
              <Undo2 size={15} />
              取消
            </button>
            <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {countManualPoints(historyData)} 点
            </span>
          </div>
        )}

        <div className="playbar__row">
          <input
            type="range" min={0} max={duration || 100} step={0.001}
            value={currentTime}
            onChange={e => {
              const t = parseFloat(e.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = t;
                setCurrentTime(t);
              }
            }}
            disabled={!videoLoaded}
            style={{ flex: 1 }}
          />
          <span className="playbar__time">
            {currentTime.toFixed(2)} / {duration.toFixed(1)}s
          </span>
        </div>

        {/* 枠ツールのときだけ、タップで置く枠の大きさを調整できるようにする */}
        {tool === 'roi' && videoLoaded && (
          <div className="playbar__row fade-in">
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
              枠サイズ
            </span>
            <input
              type="range" min={MIN_ROI_SIZE} max={160} step={2}
              value={roiSize}
              onChange={e => setRoiSize(parseInt(e.target.value, 10))}
              style={{ flex: 1 }}
            />
            <span className="mono" style={{
              fontSize: '0.72rem', flexShrink: 0, minWidth: 44, textAlign: 'right',
              color: roiSize < RECOMMENDED_ROI_SIZE ? 'var(--color-warning)' : 'var(--text-primary)',
            }}>
              {roiSize}px
            </span>
          </div>
        )}

        {!rvfcSupported && (
          <div style={{ fontSize: '0.68rem', color: 'var(--color-warning)' }}>
            ※ このブラウザはフレーム同期APIに非対応です。iOS は Safari、Android は Chrome を推奨します。
          </div>
        )}
      </div>
    </>
  );
};
