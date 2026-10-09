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
  TrackedObject, ScaleCalibration, Rect, Point, FrameData, FpsSettings, HaltInfo,
  SeedResult,
} from '../types';
import { originOf, sizeOf } from '../utils/restart';
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
import { drawCrosshair, drawCalibPoint } from '../utils/overlay';
import { SEED_FRAMES } from '../types';
import { checkTrack } from '../utils/frameCheck';
import { pointsBefore, TrailPoint } from '../utils/trailEdit';
import { narrowerSearchScale, slowerRate, rateLabel } from '../utils/advice';
import {
  TimeRange, FULL_RANGE, hasRange, rangeStart, rangeEnd, rangeSpan,
  countInRange, MIN_RANGE_POINTS,
  earliestRoiTime, restartTimeFor, roiTimeSpread, sameFrameTolerance,
} from '../utils/timeRange';
import {
  Play, Pause, RotateCcw, Upload, Hand, Square, Move, Crosshair, Target,
  MousePointerClick, Undo2,
  ZoomIn, ZoomOut, Maximize, ChevronLeft, ChevronRight, Route, SkipBack,
  ChevronUp, ChevronDown,
  Scissors, CornerDownLeft, CornerDownRight, XCircle, Trash2,
} from 'lucide-react';

export type StageTool =
  | 'pan' | 'roi' | 'correct' | 'calib' | 'origin' | 'manual' | 'seed'
  | 'pick' | 'bridge';

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
  /**
   * 2 点目を指す。数コマ先で同じ対象を指してもらう。
   * 戻り値は画面に出す一言（空なら何も言わない）。
   * videoEl を渡すのは、そのコマでテンプレートが滑らないかを実測するため。
   */
  onSeedPoint: (
    objId: string, point: Point, fileTime: number, videoEl?: HTMLVideoElement
  ) => SeedResult;
  /** 追跡が暴れたときの一時停止要求。増えるたびに止める */
  pauseAt: number;
  /** 探索窓の上限（枠に対する倍率）。「次に試すこと」を出すのに使う */
  searchScale: number;
  onChangeSearchScale: (v: number) => void;
  /** 追跡が飛んで止めた、という事実。null なら何も起きていない */
  halt: HaltInfo | null;
  /** keepUntil のコマまでを残し、それより後を捨てる。戻り値は捨てたコマ数 */
  onTruncateAfter: (keepUntil: number) => number;
  /** 1 点だけ消す。グラフを見て後から外れ値に気づいたとき用 */
  onDropPoint: (objId: string, t: number) => boolean;
  /**
   * 橋渡しの 1 点。トラッカーが無ければその位置で作る。
   * 戻り値はそのコマの対象を全部指し終えたか（呼び出し側がコマを進める）。
   */
  onBridgePoint: (
    objId: string, point: Point, fileTime: number, videoEl?: HTMLVideoElement
  ) => boolean;
  /** 橋渡しを終えて自動に戻す。初速とテンプレートを作り直し、滑るかを測る */
  onBridgeFinish: (videoEl?: HTMLVideoElement) => SeedResult;
  /**
   * 止めた案内を閉じる。
   * accept=true は「誤検出だった」＝印を外して当分検出を見送る。
   * false は「自分で直す」＝印は残したまま案内だけ閉じる。
   */
  onDismissHalt: (accept: boolean) => void;
  /** 枠の中心を決めている間を知らせる。シートを畳んで映像を広げてもらう */
  onAimingChange: (aiming: boolean) => void;
  /** トリムタブを開いているか。開いている間だけ再生バーに区間の操作を出す */
  trimMode: boolean;
  calibration: ScaleCalibration;
  onUpdateCalibration: (calib: ScaleCalibration) => void;
  onProcessFrame: (videoEl: HTMLVideoElement, timestamp: number, frameIndex: number) => void;
  historyData: FrameData[];
  onResetData: () => void;
  /** やり直し。実際に消したら true（確認をキャンセルしたら false） */
  /** やり直し。引数は「戻る先の時刻」。軌跡が残っていれば、そのコマで
   *  物体がいた位置へ枠を戻すのに使う。実際に消したら true */
  onClearTrail: (restartAt?: number | null) => boolean;
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
  /** 解析区間（始点・終点、ファイル上の時刻 [s]） */
  timeRange: TimeRange;
  onChangeTimeRange: (r: TimeRange) => void;
}

/** 軌跡として描く最大点数 */
const MAX_TRAIL_POINTS = 2000;
/** ハンドルを掴める距離（画面ピクセル）。指の腹の大きさに合わせて広めに取る */
const HANDLE_TOUCH_PX = 26;
/** これ未満の移動は「タップ」とみなす（画面ピクセル） */
const TAP_SLOP_PX = 9;
/** 虫めがねの倍率 */
/** 「ここまでは正しい」を選ばせる候補の数 */
const PICK_POINTS = 24;
const LOUPE_MAG = 3;
const LOUPE_SIZE = 104;

/**
 * 再生速度。0.0625 (=1/16) は **Chrome が受け付ける下限**で、
 * これより遅い値を代入すると NotSupportedError が飛ぶ（実測で確認）。
 * もっと遅くしたい場面は「全コマ処理」で解決するのが筋なので、
 * ここは下限までにとどめる。
 */
const PLAYBACK_RATES: { v: number; label: string }[] = [
  { v: 0.0625, label: '1/16' },
  { v: 0.125,  label: '1/8'  },
  { v: 0.25,   label: '1/4'  },
  { v: 0.5,    label: '1/2'  },
  { v: 1,      label: '1×'   },
];

type Gesture =
  | null
  | { kind: 'pan' }
  | { kind: 'roi' }
  | { kind: 'seed' }
  | { kind: 'pick' }
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
  onSeedPoint, trimMode, pauseAt, onAimingChange,
  halt, onTruncateAfter, onDismissHalt, onDropPoint, onBridgePoint, onBridgeFinish,
  searchScale, onChangeSearchScale,
  historyData, onResetData, onClearTrail, isPlaying, setIsPlaying,
  fpsSettings, setFpsSettings, isLineCalibrating, setIsLineCalibrating,
  onVideoSize, onVideoDuration, onVideoLoaded, tool, setTool, roiSize, setRoiSize,
  calibHandle, setCalibHandle, seekRequest,
  timeRange, onChangeTimeRange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);


  /**
   * 区間を rVFC のコールバックから読むための ref。
   * あのコールバックは isPlaying が変わったときにしか作り直さないので、
   * state を直接掴むと古い区間を見続けてしまう。
   */
  const timeRangeRef = useRef(timeRange);
  timeRangeRef.current = timeRange;

  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoDims, setVideoDims] = useState({ width: 640, height: 360 });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showTrail, setShowTrail] = useState(true);

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
  /** 初速ヒントの結果の一言。普段は null（黙っている） */
  const [seedMsg, setSeedMsg] = useState<SeedResult | null>(null);
  /** 注意書きを開いているか。既定は畳む */
  const [alertsOpen, setAlertsOpen] = useState(false);
  /**
   * 枠を置くときの中心。決まっていれば「大きさを決める段階」。
   *
   * 1 回のドラッグで中心と大きさを同時に決めさせると、指ではどちらも
   * 精度が出ない。中心だけ拡大鏡で合わせ、大きさはあとから落ち着いて
   * 決める、の 2 段階に分けている。
   */
  const [roiCenter, setRoiCenter] = useState<Point | null>(null);
  /** 切り落としたあとの一言 */
  const [cutMsg, setCutMsg] = useState<string | null>(null);
  /** 橋渡しで指した点の数 */
  const [bridgeCount, setBridgeCount] = useState(0);
  /** 再生速度の選択肢を開いているか */
  const [rateOpen, setRateOpen] = useState(false);
  /**
   * 「ここまでは正しい」で選んでいる候補の番号。
   *
   * 選ぶだけでは切らない。選ぶとそのコマへ送るので、点がマーカーの上に
   * 乗っているかを目で確かめてから決定できる。確かめられないと、
   * どれが正解なのか人には分からない。
   */
  const [pickIdx, setPickIdx] = useState<number | null>(null);
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
    // 区間は「この動画の何秒から何秒まで」なので、別の動画では意味を持たない
    onChangeTimeRange(FULL_RANGE);
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
  useEffect(() => { if (tool !== 'roi') setRoiCenter(null); }, [tool]);

  // 枠ツールに入ってから確定するまで、シートを畳んでもらう
  useEffect(() => {
    // 枠・橋渡し・戻す位置の選択は、映像を広く見せないと決められない。
    // トリム中の再生も同じ。終点は映像を見て決めるものなので、
    // シートが半分を占めたままでは判断できない（止めれば戻る）。
    onAimingChange(
      tool === 'roi' || tool === 'bridge' || tool === 'pick'
      || (trimMode && isPlaying)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, trimMode, isPlaying]);

  /**
   * 2 点目の結果は少し経ったら消す。
   * ただし直し方（枠の大きさ）を出しているときは消さない。
   * 押す前に消えるボタンは出さない方がましなので。
   */
  useEffect(() => {
    if (!seedMsg || seedMsg.betterSize !== undefined) return;
    const id = window.setTimeout(() => setSeedMsg(null), 7000);
    return () => window.clearTimeout(id);
  }, [seedMsg]);

  /**
   * 枠ツールに入ったら、記録が始まるコマへ送る。
   *
   * 枠はそのコマの画からテンプレートを作るので、別のコマで置くと
   * 「始点のコマに物体がいない」「物体ごとに別のコマ」という事故になる。
   * 警告で後追いするより、置かせる前に揃えてしまうほうが確実。
   */
  useEffect(() => {
    if (tool !== 'roi' || !videoLoaded) return;
    // 記録がもうあるなら送らない。
    // 途中で枠を置き直すのは「今見ているコマで取り直したい」ときなので、
    // そこで始点へ飛ばすと、何のために置き直すのか分からなくなる。
    // （切り落としたあとは、戻した先のコマがそのまま置き場所になる）
    if (historyData.length > 0) return;
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - restartTime) < 1e-3) return;
    void goToStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, videoLoaded]);

  /**
   * 橋渡しに入ったら、残した最後のコマの次へ送る。
   * そこが「捨てた最初のコマ」。埋めるべき最初の 1 コマ。
   */
  useEffect(() => {
    if (tool !== 'bridge') { setBridgeCount(0); return; }
    const v = videoRef.current;
    const o = objects.find(x => x.id === selectedObjId);
    const org = o ? originOf(o) : null;
    if (!v || !o || !org) return;
    v.pause();
    setIsPlaying(false);
    const target = org.time + 1 / Math.max(1, fpsRef.current.value);
    seekToFrameTime(v, target).then(t => {
      frameTimeRef.current = t;
      setCurrentTime(t);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  /**
   * 初速ヒントに入ったら、枠を置いたコマから数コマ送る。
   * 2 点が近すぎると、1 コマあたりの移動量の精度が出ないため。
   */
  useEffect(() => {
    if (tool !== 'seed') return;
    const v = videoRef.current;
    const o = objects.find(x => x.id === selectedObjId);
    const org = o ? originOf(o) : null;
    if (!v || !o || !org) return;
    v.pause();
    setIsPlaying(false);
    const target = org.time + SEED_FRAMES / Math.max(1, fpsRef.current.value);
    seekToFrameTime(v, target).then(t => {
      frameTimeRef.current = t;
      setCurrentTime(t);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

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

  /**
   * 「ここまでは正しい」の候補。飛んだ時刻の手前の記録点を新しい順に並べる。
   *
   * 時刻の数字ではなく映像の上の点として選ばせる。どこでドリフトが
   * 始まったかは軌跡の形を見れば分かるが、秒数の一覧からは分からない。
   */
  const pickPoints = useMemo<TrailPoint[]>(
    () => (halt ? pointsBefore(historyData, halt.objId, halt.time, PICK_POINTS) : []),
    [halt, historyData]
  );

  /** 候補のうち、移動量が普段から外れ始めるのはどこからか */
  const pickMedianStep = useMemo(() => {
    const steps = pickPoints.map(q => q.step).filter(v => v > 0).sort((a, b) => a - b);
    return steps.length > 0 ? steps[Math.floor(steps.length / 2)] : 0;
  }, [pickPoints]);

  /**
   * 乱れ始めた最初の候補。ここから後は信用しない。
   *
   * 候補の数と等しければ、候補の中では乱れが見つからなかったということ。
   */
  const pickWarnFrom = useMemo(() => {
    if (pickMedianStep <= 0) return pickPoints.length;
    for (let i = 0; i < pickPoints.length; i++) {
      if (pickPoints[i].step > Math.max(pickMedianStep * 2, pickMedianStep + 4)) return i;
    }
    return pickPoints.length;
  }, [pickPoints, pickMedianStep]);

  /**
   * アプリ側の答え。乱れ始めた 1 つ手前。
   *
   * 既定を入れておくのが肝。「正しい最後の点を選べ」と言われても、
   * 何を基準に選ぶのかが分からなければ手が止まる。まず答えを置いて、
   * 違うと思ったときだけ動かしてもらう形にする。
   */
  const pickSuggest = useMemo(() => {
    if (pickPoints.length === 0) return null;
    return Math.max(0, Math.min(pickPoints.length - 1, pickWarnFrom - 1));
  }, [pickPoints, pickWarnFrom]);

  /** 切り落としの一言は少し長めに出す（次にすることが書いてある） */
  useEffect(() => {
    if (!cutMsg) return;
    const id = window.setTimeout(() => setCutMsg(null), 6000);
    return () => window.clearTimeout(id);
  }, [cutMsg]);

  /**
   * 指に近い候補の番号。見つからなければ -1。
   *
   * 指は太いので、枠のハンドルと同じ広さで拾う。候補は軌跡の上に
   * 密に並ぶので、なぞって選び直せるほうが現実的。
   */
  const nearestPickIndex = useCallback(
    (pt: Point, hitR: number): number => {
      let best = -1;
      let bestD = hitR * 1.6;
      pickPoints.forEach((q, i) => {
        const d = pixelDistance(pt, q.point);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    },
    [pickPoints]
  );

  /**
   * 切り落とす。選んだ点より後の記録を捨て、枠をその位置へ戻す。
   * そのまま枠を置き直せるよう、ツールは枠指定へ送る。
   */
  const cutAt = useCallback((q: TrailPoint) => {
    const dropped = onTruncateAfter(q.time);
    setCutMsg(
      dropped > 0
        ? `${q.time.toFixed(3)} s より後の ${dropped} コマを捨てました`
        : `${q.time.toFixed(3)} s まで残しました（捨てるコマはありませんでした）`
    );
    setRoiCenter(null);
    setPickIdx(null);
    setBridgeCount(0);
    // 枠を置き直させるのではなく、跳ねたコマを人に指してもらう。
    // 枠の位置は記録から分かっているので、置き直しても新しい情報は無い。
    // 本当に足りないのは「跳ねたコマで対象はどこに居たのか」。
    setTool('bridge');
  }, [onTruncateAfter, setTool]);

  const beginSingle = useCallback((pt: Point, screen: { x: number; y: number }) => {
    const hitR = HANDLE_TOUCH_PX * canvasPerScreen();

    // ---- 「ここまでは正しい」を選ぶ ----
    // ほかのどのツールよりも先に見る。選び終わるまで他の操作はさせない。
    //
    // タップでは切らない。選ぶだけにして、そのコマへ送って見せる。
    // 指は太いので、押したまま軌跡をなぞって選び直せるようにもしてある。
    if (tool === 'pick') {
      setGesture({ kind: 'pick' });
      setDragCurrent(pt);
      const i = nearestPickIndex(pt, hitR);
      if (i >= 0) setPickIdx(i);
      return;
    }

    // ---- 橋渡し ----
    // 跳ねて捨てたコマを、人が指して埋めていく。1 コマずつ進む。
    if (tool === 'bridge' && !isPlaying) {
      // 指す相手は手動記録と同じ順番で決める。1 つだけ埋めてコマを進めると、
      // もう一方の物体にだけ穴が開いた記録になる。
      const objId = manualPick ?? nextManualTarget(
        historyData, manualOrder, frameTimeRef.current, frameTolerance
      ).objId ?? selectedObjId;
      const complete = onBridgePoint(
        objId, pt, frameTimeRef.current, videoRef.current || undefined
      );
      setManualPick(null);
      if (complete) {
        setBridgeCount(c => c + 1);
        void stepFrame(1);
      }
      return;
    }

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
    // ---- 初速ヒント ----
    // 始点は枠の中心で決まっているので、指を置いた瞬間に矢印が生えて、
    // 動かすと先端が追従する。離した位置が「数コマ先の対象の位置」。
    // 何を教えているのかが見えるぶん、ただのタップより迷わない。
    if (tool === 'seed') {
      setGesture({ kind: 'seed' });
      setDragStart(pt);
      setDragCurrent(pt);
      return;
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
    manualOrder.join(','), manualPick, nearestPickIndex,
    onBridgePoint, bridgeCount, selectedObjId,
  ]);

  /** 大きさを決め終えて枠を確定する */
  const confirmRoi = useCallback(() => {
    if (!roiCenter) return;
    const half = roiSize / 2;
    onUpdateRoi(selectedObjId, {
      x: Math.round(roiCenter.x - half),
      y: Math.round(roiCenter.y - half),
      width: Math.round(roiSize),
      height: Math.round(roiSize),
    }, videoRef.current || undefined);
    setRoiCenter(null);
    setTool('pan');
  }, [roiCenter, roiSize, selectedObjId, onUpdateRoi, setTool]);

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

    if (gesture.kind === 'pick') {
      const i = nearestPickIndex(pt, HANDLE_TOUCH_PX * canvasPerScreen());
      if (i >= 0) setPickIdx(i);
      return;
    }

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
      } else if (g.kind === 'seed') {
        const tip = dragCurrent ?? pt;
        const r = onSeedPoint(
          selectedObjId, tip, frameTimeRef.current, videoRef.current || undefined
        );
        setSeedMsg(r.msg ? r : null);
        setTool('pan');
        // 2 点目のあとは記録が始まるコマへ戻す。
        // 送ったままだと、そこから再生して始点を飛ばしてしまう。
        void goToStart();
      } else if (g.kind === 'roi') {
        // 中心だけを決める。大きさは次の段階で決めるので、ここでは置かない。
        const c = dragCurrent ?? dragStart;
        if (c) setRoiCenter({ x: c.x, y: c.y });
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
    gesture, dragStart, dragCurrent, roiSize, selectedObjId, linePending,
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

  /**
   * 虫めがねの中心。
   *
   * 指でなぞっている間はその位置、「ここまでは正しい」を選んでいる間は
   * 選択中の候補。候補を選ぶのは「点がマーカーの上に乗っているか」の
   * 判断なので、拡大が無いと決められない。
   */
  const loupeFocus: Point | null = (() => {
    if (dragCurrent && gesture && gesture.kind !== 'pan') {
      return gesture.kind === 'pick' && pickIdx !== null && pickPoints[pickIdx]
        ? pickPoints[pickIdx].point
        : dragCurrent;
    }
    if (tool === 'pick' && pickIdx !== null && pickPoints[pickIdx]) {
      return pickPoints[pickIdx].point;
    }
    return null;
  })();

  const loupePos = (() => {
    if (!loupeFocus) return null;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return null;
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const screenX = cr.left + (loupeFocus.x / canvas.width) * cr.width - sr.left;
    // 指と重ならないよう、触っている側と反対の上隅に出す
    const left = screenX > sr.width / 2 ? 10 : sr.width - LOUPE_SIZE - 10;
    return { left, top: 10 };
  })();

  const drawLoupe = useCallback(() => {
    const lc = loupeRef.current;
    const canvas = canvasRef.current;
    if (!lc || !canvas || !loupeFocus) return;
    const ctx = lc.getContext('2d');
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    const dispScale = r.width > 0 ? r.width / canvas.width : 1; // 画面px / 動画px
    const srcSize = LOUPE_SIZE / Math.max(0.001, dispScale * LOUPE_MAG);
    const sx = loupeFocus.x - srcSize / 2;
    const sy = loupeFocus.y - srcSize / 2;
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
  }, [loupeFocus]);

  // =========================================================
  // 描画
  // =========================================================

  // =========================================================
  // コマの点検
  // =========================================================
  //
  // 位置の 2 階差分が一定かどうかを見る。等加速度ならこれは一定になるので、
  // 飛んでいるコマは「動画側のコマの時刻ずれ」か「追跡の失敗」のどちらか。
  // 速度に直してから探すと、微分がノイズを増幅し、中心差分のせいで
  // 1 コマの異常が前後 2 点へ散るため、原因のコマが特定できない。

  /** 点検に使う枠の幅。ブレの限界の判定に効く */
  const checkRoiWidth = useMemo(() => {
    const o = objects.find(x => x.id === selectedObjId);
    return (o ? sizeOf(o)?.width : 0) ?? 0;
  }, [objects, selectedObjId]);

  const trackQuality = useMemo(
    () => checkTrack(historyData, selectedObjId, checkRoiWidth),
    [historyData, selectedObjId, checkRoiWidth]
  );
  /** 疑わしいコマの時刻。描画で印を付けるのに使う */
  const issueTimes = useMemo(() => new Set(trackQuality.issueTimes), [trackQuality]);

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

    // いま校正を触っているか。層の出し分けに使う。
    // 枠・名前・校正点・校正の数値が同じ場所に重なると、どれを操作して
    // いるのか分からなくなる。操作中の層だけを濃くするのが確実に効く。
    const calibActive = tool === 'calib' || tool === 'origin';

    // ----- 軌跡 -----
    if (showTrail && historyData.length > 1) {
      objects.forEach(obj => {
        if (!obj.active) return;
        const segments: Point[][] = [];
        let cur: Point[] = [];
        for (let i = 0; i < historyData.length; i++) {
          const item = historyData[i].objects[obj.id];
          // 飛んだと判定した点でも線を切る。点そのものは ✕ で別に描く。
          // つないでしまうと、壊れた区間まで滑らかな運動に見える。
          if (item && !item.lost && !item.suspect) cur.push({ x: item.xPx, y: item.yPx });
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


        // タイミングの乱れたコマに印を付ける。
        // 点そのものは消さない。消すと「無かったこと」になり、なぜ速度が
        // 暴れているのかを説明できなくなる。見せたうえで判断してもらう。
        if (obj.id === selectedObjId && issueTimes.size > 0) {
          for (let i = 0; i < historyData.length; i++) {
            const it = historyData[i].objects[obj.id];
            if (!it || it.lost) continue;
            if (!issueTimes.has(historyData[i].timestamp)) continue;
            ctx.save();
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 8 * k, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 3.2 * k;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(it.xPx, it.yPx, 8 * k, 0, Math.PI * 2);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.6 * k;
            ctx.setLineDash([3.5 * k, 2.5 * k]);
            ctx.stroke();
            ctx.restore();
          }
        }

        // 飛んだと判定した点は ✕ で描く。
        // 丸ではなく ✕ にしてあるのは、「これは軌跡の一部ではない」
        // ことを形で示したいから。乱れの印（点線の輪）とは別物。
        for (let i = 0; i < historyData.length; i++) {
          const it = historyData[i].objects[obj.id];
          if (!it || !it.suspect) continue;
          const r = 7 * k;
          ctx.save();
          ctx.lineCap = 'round';
          const cross = (color: string, w: number) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.moveTo(it.xPx - r, it.yPx - r); ctx.lineTo(it.xPx + r, it.yPx + r);
            ctx.moveTo(it.xPx + r, it.yPx - r); ctx.lineTo(it.xPx - r, it.yPx + r);
            ctx.stroke();
          };
          cross('rgba(0,0,0,0.55)', 4.4 * k);
          cross('#ef4444', 2.2 * k);
          ctx.restore();
        }

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

        // 現在位置マーカー。
        // 十字にしてあるのは、追跡点が本当に対象の上に乗っているかを
        // 目で確かめられるようにするため。丸で塗ると対象が隠れて分からない。
        const last = points[points.length - 1];
        drawCrosshair(ctx, last.x, last.y, obj.color, k, 9, 3, 1.6);

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

    // ----- 「ここまでは正しい」の候補 -----
    //
    // 移動量が普段から外れ始めたところより後を濃い赤、手前を橙で描く。
    // どこから色が変わるかが、そのまま「ドリフトが始まったあたり」になる。
    if (tool === 'pick' && pickPoints.length > 0) {
      ctx.save();
      pickPoints.forEach((q, i) => {
        const warn = i >= pickWarnFrom;
        ctx.beginPath();
        ctx.arc(q.point.x, q.point.y, 6 * k, 0, Math.PI * 2);
        ctx.fillStyle = warn ? 'rgba(239,68,68,0.9)' : 'rgba(245,158,11,0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
      });
      // 選択中は二重の輪で囲む。どれを選んでいるかが分からないまま
      // 「決定」を押させてはいけない。
      if (pickIdx !== null && pickPoints[pickIdx]) {
        const c = pickPoints[pickIdx].point;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 13 * k, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 4 * k;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(c.x, c.y, 13 * k, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2 * k;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ----- ROI 枠 -----
    objects.forEach(obj => {
      if (!obj.active || !obj.roi || obj.status === 'exited') return;
      const { x, y, width, height } = obj.roi;
      const isLost = obj.status === 'lost';
      const isSel = obj.id === selectedObjId;
      const color = isLost ? '#ef4444' : obj.color;

      ctx.save();
      // 校正中は追跡の層を薄くする
      if (calibActive) ctx.globalAlpha = 0.28;
      ctx.strokeStyle = color;
      ctx.lineWidth = (isSel ? 2.5 : 1.5) * k;
      ctx.setLineDash(isLost ? [6 * k, 4 * k] : []);
      ctx.strokeRect(x, y, width, height);

      // 実際に探している範囲。選択中の対象だけ、薄い点線で出す。
      //
      // 探索範囲は「数字をいくつにすべきか」が分からない類の設定だった。
      // 探している範囲が枠と一緒に見えていれば、広すぎる／狭すぎるを
      // 目で判断できる。等速で追えている間はごく小さいのが正しい姿。
      if (isSel && !calibActive && obj.searchPx && obj.status === 'tracking') {
        const m = obj.searchPx;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1 * k;
        ctx.setLineDash([3 * k, 3 * k]);
        ctx.strokeRect(x - m, y - m, width + m * 2, height + m * 2);
        ctx.setLineDash([]);
        ctx.strokeStyle = color;
        ctx.lineWidth = (isSel ? 2.5 : 1.5) * k;
        ctx.setLineDash(isLost ? [6 * k, 4 * k] : []);
      }
      ctx.setLineDash([]);

      // 名前を出すのは選択中と LOST のときだけ。
      // 帯は枠と同じ幅を占めるので、全部に出すと枠の上が名前で埋まる。
      if (isSel || isLost) {
        const label = isLost ? `${obj.id} LOST` : obj.id;
        ctx.font = `bold ${11 * k}px Inter, sans-serif`;
        const tw = ctx.measureText(label).width;
        const lh = 19 * k;
        const ly = Math.max(0, y - lh - 3 * k);
        ctx.fillStyle = color;
        ctx.fillRect(x, ly, tw + 12 * k, lh);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 6 * k, ly + 13.5 * k);
      } else {
        // 非選択は角の小さな印だけ。色で見分けられれば足りる
        const sq = 7 * k;
        ctx.fillStyle = color;
        ctx.fillRect(x, Math.max(0, y - sq - 2 * k), sq, sq);
      }

      const c = obj.center || { x: x + width / 2, y: y + height / 2 };
      ctx.beginPath();
      ctx.moveTo(c.x - 7 * k, c.y); ctx.lineTo(c.x + 7 * k, c.y);
      ctx.moveTo(c.x, c.y - 7 * k); ctx.lineTo(c.x, c.y + 7 * k);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2 * k;
      ctx.stroke();
      ctx.restore();
    });

    // ----- 初速ヒント -----
    // 指した点と枠を置いた位置を結んでおく。これが「1 コマあたりどれだけ
    // 動くか」の根拠なので、見えていないと置き直しの判断ができない。
    objects.forEach(obj => {
      if (!obj.active || !obj.seed || obj.id !== selectedObjId) return;
      ctx.save();
      ctx.globalAlpha = 0.75;
      const orgS = originOf(obj);
      if (orgS) {
        const from = {
          x: orgS.roi.x + orgS.roi.width / 2,
          y: orgS.roi.y + orgS.roi.height / 2,
        };
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(obj.seed.point.x, obj.seed.point.y);
        ctx.strokeStyle = obj.color;
        ctx.lineWidth = 1.2 * k;
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      drawCrosshair(ctx, obj.seed.point.x, obj.seed.point.y, obj.color, k, 9, 2.4, 1.3);
      ctx.restore();
    });

    // ----- 初速ヒントを引いている最中の矢印 -----
    // 始点は枠の中心で決まっているので、矢印として見せられる。
    // 「1 コマあたりどれだけ動くか」を教えている、という意味が画で伝わる。
    if (tool === 'seed' && gesture?.kind === 'seed' && dragCurrent) {
      const o = objects.find(x => x.id === selectedObjId);
      const org0 = o ? originOf(o) : null;
      const from = org0
        ? {
            x: org0.roi.x + org0.roi.width / 2,
            y: org0.roi.y + org0.roi.height / 2,
          }
        : null;
      if (from) {
        const color = o?.color || '#f59e0b';
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 5 * k;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y); ctx.lineTo(dragCurrent.x, dragCurrent.y);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5 * k;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y); ctx.lineTo(dragCurrent.x, dragCurrent.y);
        ctx.stroke();
        // 矢じり
        const ang = Math.atan2(dragCurrent.y - from.y, dragCurrent.x - from.x);
        const a = 13 * k;
        ctx.beginPath();
        ctx.moveTo(dragCurrent.x, dragCurrent.y);
        ctx.lineTo(dragCurrent.x - a * Math.cos(ang - 0.42), dragCurrent.y - a * Math.sin(ang - 0.42));
        ctx.moveTo(dragCurrent.x, dragCurrent.y);
        ctx.lineTo(dragCurrent.x - a * Math.cos(ang + 0.42), dragCurrent.y - a * Math.sin(ang + 0.42));
        ctx.stroke();
        ctx.restore();
        // 先端は塗らない。合わせている画素が見えなくなる
        drawCrosshair(ctx, dragCurrent.x, dragCurrent.y, color, k, 10, 2.4, 1.4);
      }
    }

    // ----- 枠を置くときのプレビュー -----
    // 中心を決める段階（指の下）と、大きさを決める段階（確定した中心）で
    // 同じ形を出す。中心は塗らない — 狙っている画素が見えなくなるため。
    // 指を動かしている間は指の下を出す（中心を置き直している最中）。
    // そうでなければ確定した中心。
    const previewCenter = tool === 'roi'
      ? ((gesture?.kind === 'roi' && dragCurrent) ? dragCurrent : roiCenter)
      : null;
    if (previewCenter) {
      const half = roiSize / 2;
      const rx = previewCenter.x - half;
      const ry = previewCenter.y - half;
      const target = objects.find(o => o.id === selectedObjId);
      const tooSmall = roiSize < MIN_ROI_SIZE;
      const marginal = !tooSmall && roiSize < RECOMMENDED_ROI_SIZE;
      const guide = tooSmall ? '#ef4444' : marginal ? '#f59e0b' : (target?.color || '#fff');

      ctx.save();
      ctx.strokeStyle = guide;
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([5 * k, 4 * k]);
      ctx.strokeRect(rx, ry, roiSize, roiSize);
      ctx.setLineDash([]);
      ctx.fillStyle = tooSmall ? 'rgba(239,68,68,0.16)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(rx, ry, roiSize, roiSize);
      ctx.restore();
      drawCrosshair(ctx, previewCenter.x, previewCenter.y, guide, k, 10, 2.4, 1.4);

      const txt = `${Math.round(roiSize)}px`
        + (tooSmall ? ' 小さすぎ' : marginal ? ' やや小' : '');
      ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(rx - 2 * k, ry + roiSize + 3 * k, tw + 10 * k, 18 * k);
      ctx.fillStyle = guide;
      ctx.fillText(txt, rx + 3 * k, ry + roiSize + 16 * k);
    }

    // ----- 2点間校正 -----
    const drawLine = (p1: Point, p2: Point, live: boolean) => {
      // 校正が済んだあとは控えめにする。値は一度決まれば変わらないので、
      // 映像の上に居座る必要がない（数値は校正シートに常時出ている）。
      const focus = live || calibActive;
      const dist = pixelDistance(p1, p2);
      ctx.save();
      // 端の近くでは線を切る。そこは狙っている画素そのものなので、
      // 線で塗ってしまうと、印を細く半透明にした意味がなくなる。
      const ux = (p2.x - p1.x) / Math.max(1, dist);
      const uy = (p2.y - p1.y) / Math.max(1, dist);
      const cut = Math.min(8 * k, dist * 0.3);
      const a = { x: p1.x + ux * cut, y: p1.y + uy * cut };
      const b = { x: p2.x - ux * cut, y: p2.y - uy * cut };
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = (focus ? 4 : 2.6) * k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = live ? 'rgba(251,191,36,0.85)'
        : focus ? 'rgba(245,158,11,0.8)' : 'rgba(245,158,11,0.5)';
      ctx.lineWidth = (focus ? 2 : 1.2) * k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // 中を塗らない。塗ると狙っている目盛りが自分の描画で隠れ、
      // 終点を目分量で置くことになる（それが縮尺の誤差として残る）
      [p1, p2].forEach((p, i) => {
        const focused = tool === 'calib' && calibHandle === i;
        drawCalibPoint(ctx, p.x, p.y, i === 0 ? '#f59e0b' : '#10b981', k, focused);
      });
      // 数値は、製図の寸法線と同じように線から垂直へ逃がす。
      // 基準が短いとき、線の真上に置くと狙っている対象を数値で隠してしまう。
      if (focus) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const len = Math.max(1, dist);
        let nx = -(p2.y - p1.y) / len;
        let ny = (p2.x - p1.x) / len;
        if (ny > 0) { nx = -nx; ny = -ny; }   // なるべく上へ逃がす
        const lx = mx + nx * 32 * k;
        const ly = my + ny * 32 * k;
        ctx.beginPath();
        ctx.moveTo(mx, my); ctx.lineTo(lx, ly);
        ctx.strokeStyle = 'rgba(251,191,36,0.65)';
        ctx.lineWidth = 1 * k;
        ctx.stroke();

        const label = `${dist.toFixed(1)}px = ${calibration.realSizeValue}${calibration.unit}`;
        ctx.font = `bold ${12 * k}px JetBrains Mono, monospace`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(lx - tw / 2 - 7 * k, ly - 10.5 * k, tw + 14 * k, 21 * k);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(label, lx - tw / 2, ly + 4 * k);
      }
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
        drawCalibPoint(ctx, linePending.x, linePending.y, '#f59e0b', k, true);
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
        // 番号はリングの外側。角そのものを数字で潰さない
        drawCalibPoint(ctx, p.x, p.y, done ? '#10d97c' : '#f59e0b', k, focused, String(i + 1));
        if (quad.length < 4) {
          ctx.fillStyle = '#fbbf24';
          ctx.font = `${11 * k}px Inter, sans-serif`;
          ctx.fillText(cornerNames[i], p.x + 14 * k, p.y + 16 * k);
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
        // 打った点は十字で示す。ここは指の狙いの精度がそのまま数値になる場所で、
        // 塗りつぶした丸だと狙った画素が自分の描画で隠れてしまう。
        drawCrosshair(ctx, it.xPx, it.yPx, o.color, k, 13, 3.8, 1.8);
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
        // 掴める範囲を示す破線の輪
        ctx.beginPath();
        ctx.arc(c.x, c.y, 14 * k, 0, Math.PI * 2);
        ctx.strokeStyle = dragging ? '#fff' : o.color;
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
        // 輪の中に十字。指を離す前にどの画素へ置こうとしているかが見える
        drawCrosshair(ctx, c.x, c.y, dragging ? '#ffffff' : o.color, k, 10, 3.2, 1.6);
      });
    }
  }, [
    historyData, objects, selectedObjId, showTrail, gesture, dragStart, dragCurrent,
    calibration, tool, isPlaying, roiSize, linePending, calibHandle,
    canvasPerScreen, view.z, nearestFrameIndex, grabPoint, frameTolerance, issueTimes,
    roiCenter, pickPoints, pickWarnFrom, pickIdx,
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
      // 終点を越えたら自動で止める。
      // 「終わりを見張って停止ボタンを押す」操作をなくすためのもので、
      // 押し遅れて余分なフレームが混ざる事故もこれで消える。
      const r = timeRangeRef.current;
      if (r.end !== null && mediaTime > r.end) {
        v.pause();
        setIsPlaying(false);
        frameTimeRef.current = mediaTime;
        setCurrentTime(mediaTime);
        return;
      }

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

  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v || !videoLoaded) return;
    if (isPlaying) {
      v.pause();
      setIsPlaying(false);
      return;
    }
    // 再生中に枠を描こうとして誤爆しないよう、移動ツールへ戻す
    if (tool === 'roi' || tool === 'calib') setTool('pan');

    // 記録できない位置（区間の手前、枠を置いたコマより前、終点より後ろ）から
    // 再生を始めようとしたら、まず記録が始まる位置へ送る。
    // そのまま再生すると「再生しているのに点が増えない」という
    // 分かりにくい状態になる。
    const st = restartTime;
    const en = rangeEnd(timeRange, duration);
    if (v.currentTime < st - 1e-3 || v.currentTime > en - 1e-3) {
      try {
        const t = await seekToFrameTime(v, st);
        frameTimeRef.current = t;
        setCurrentTime(t);
      } catch (_) { /* シークに失敗してもそのまま再生を試みる */ }
    }

    try { v.playbackRate = playbackRate; } catch (_) { /* 非対応の速度 */ }
    v.play().then(() => setIsPlaying(true)).catch(err => {
      console.error('[VideoStage] 再生できませんでした:', err);
    });
  };

  // 対応していない速度を代入すると例外が飛ぶブラウザがあるので、
  // 必ず読み戻して UI と実際の速度をそろえる。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.playbackRate = playbackRate;
    } catch (_) { /* 下限に丸められる。下で読み戻す */ }
    if (Math.abs(v.playbackRate - playbackRate) > 1e-6) setPlaybackRate(v.playbackRate);
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

  /** 追跡が暴れたときの一時停止要求（App から届く） */
  useEffect(() => {
    if (!pauseAt) return;
    const v = videoRef.current;
    if (v) v.pause();
    setIsPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pauseAt]);

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

  /**
   * やり直し — 軌跡を消し、枠を最初に置いた位置へ戻し、記録が始まる時刻へ送る。
   *
   * 戻る先は「区間の始点」、無ければ「枠を置いたコマ」、それも無ければ先頭。
   * 枠を置いたコマより前へ戻しても、そのコマに物体がいないので
   * テンプレートが作れず、追跡が始まらないため。
   *
   * 枠を戻すのは onClearTrail（App 側）が行う。戻る先の時刻を渡すのは、
   * 直前の軌跡が残っていれば「そのコマで物体がいた位置」へ枠を戻せるため。
   * 区間の始点を後から動かしたときに、枠だけが最初に引いた場所へ取り残されて
   * 「やり直すたびに枠を置き直す」ことになるのを防ぐ。
   */
  const handleRestart = async () => {
    const v = videoRef.current;
    if (v) v.pause();
    setIsPlaying(false);

    // 先に消す。手動点の確認でキャンセルされたら、動画は動かさない
    // （データが残ったまま始点へ飛ぶと、何が起きたのか分からなくなる）。
    if (!onClearTrail(restartTime)) return;

    if (v) {
      const st = restartTime;
      try {
        const t = await seekToFrameTime(v, st);
        frameTimeRef.current = t;
        setCurrentTime(t);
      } catch (_) {
        v.currentTime = st;
        setCurrentTime(st);
      }
    }
    frameCounterRef.current = 0;
    frameIntervalsRef.current = [];
    lastMediaTimeRef.current = null;
  };

  // =========================================================
  // 解析区間
  // =========================================================

  /**
   * 枠を引いたコマの時刻。
   *
   * テンプレートは「枠を引いた瞬間のコマの画」から作られるので、
   * それより前へ戻して再生しても、そのコマに物体がいなければ追跡は始まらない。
   * だからやり直しで戻る先は 0 秒ではなく、区間の始点か、それが無ければ
   * 枠を引いたコマになる。
   */
  const roiTimes = useMemo(
    () => objects
      .filter(o => o.active && o.initialTime !== null)
      .map(o => o.initialTime as number),
    [objects]
  );
  const roiStartTime = earliestRoiTime(roiTimes);
  /** 1.5 コマ分。ずれの判定はこれを基準にする */
  const frameTol = sameFrameTolerance(fpsSettings.value);
  /** 複数の物体の枠を別々のコマで置いていないか（置いていると片方が破綻する） */
  const roiSpread = roiTimeSpread(roiTimes);
  const roiFramesDiffer = roiSpread > frameTol;
  /** 区間の始点と、枠を置いたコマがずれていないか */
  const startMismatch =
    timeRange.start !== null && roiStartTime !== null
      ? Math.abs(timeRange.start - roiStartTime) > frameTol
      : false;

  /** やり直しと、記録できない位置から再生を始めたときに戻る先 */
  const restartTime = restartTimeFor(timeRange, roiTimes);

  /**
   * 指定した時刻のコマへ送る。
   * 止めた点を手で直すとき、候補を選んで中身を確かめるときに使う。
   */
  const seekToTime = useCallback(async (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setIsPlaying(false);
    try {
      const got = await seekToFrameTime(v, t);
      frameTimeRef.current = got;
      setCurrentTime(got);
    } catch (_) { /* シークに失敗しても状態は壊さない */ }
    renderRef.current();
  }, [setIsPlaying]);

  // 「ここまでは正しい」に入ったら、まずアプリ側の答えを置く
  useEffect(() => {
    if (tool !== 'pick') { setPickIdx(null); return; }
    setPickIdx(prev => (prev === null ? pickSuggest : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pickSuggest]);

  /**
   * 選んだ候補のコマへ送る。
   *
   * これが要る理由。候補を選ぶ判断は「点がマーカーの上に乗っているか」で、
   * それは**そのコマの映像を見ないと決められない**。止まったコマのまま
   * 点だけを並べても、どれが正解なのかは分からなかった。
   *
   * 指でなぞっている間は送らない。1 候補ごとにシークすると追いつかない。
   * 指を離してから送る。
   */
  useEffect(() => {
    if (tool !== 'pick' || pickIdx === null) return;
    if (gesture?.kind === 'pick') return;
    const q = pickPoints[pickIdx];
    if (!q) return;
    void seekToTime(q.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pickIdx, gesture?.kind]);

  const goToStart = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setIsPlaying(false);
    try {
      const t = await seekToFrameTime(v, restartTime);
      frameTimeRef.current = t;
      setCurrentTime(t);
    } catch (_) {
      v.currentTime = restartTime;
      setCurrentTime(restartTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartTime, setIsPlaying]);



  /** 「いま画面に出ているフレーム」の時刻。要求時刻ではなく実際の mediaTime */
  const shownTime = () => frameTimeRef.current || currentTime;

  const setRangeStartHere = () => onChangeTimeRange({ ...timeRange, start: shownTime() });
  const setRangeEndHere = () => onChangeTimeRange({ ...timeRange, end: shownTime() });
  const clearRange = () => onChangeTimeRange(FULL_RANGE);

  /** 区間内に入っている記録点の数（少なすぎると自動遮断周波数が不安定になる） */
  const pointsInRange = useMemo(
    () => countInRange(historyData, timeRange),
    [historyData, timeRange]
  );
  const rangeActive = hasRange(timeRange);
  const rangeSpanSec = rangeSpan(timeRange, duration);
  /** スロー動画では実時間も併記する。ファイル上の秒数だけ見て判断させない */
  const rangeSpanReal = rangeSpanSec * timeScale(fpsSettings);
  const tooFewPoints = rangeActive && pointsInRange > 0 && pointsInRange < MIN_RANGE_POINTS;
  /** シークバー上での位置（0–1）。トラックの左右にはつまみの半分だけ余白がある */
  const rangeFrac = (t: number) => (duration > 0 ? Math.min(1, Math.max(0, t / duration)) : 0);
  const bandLeft = rangeFrac(rangeStart(timeRange));
  const bandRight = duration > 0 ? rangeFrac(rangeEnd(timeRange, duration)) : 1;


  // =========================================================
  // 表示用の派生値
  // =========================================================

  const exited = objects.filter(o => o.active && o.status === 'exited');
  const lost = objects.filter(o => o.active && o.status === 'lost');
  /** いま見ているコマが解析区間の中か（区間が無ければ常に中） */
  const inTrimRange = !hasRange(timeRange)
    || (currentTime >= rangeStart(timeRange) - 1e-6
      && currentTime <= rangeEnd(timeRange, duration) + 1e-6);
  const selected = objects.find(o => o.id === selectedObjId);

  /**
   * 次に試すこと。
   *
   * 目印（丸シールなど）を使っているなら、追跡が飛ぶ原因はたいてい
   * 「窓が広くて似た模様に乗り移った」か「コマを取りこぼして 1 コマの
   * 移動量が倍になった」のどちらか。どちらも設定で直せるので、
   * 文章で勧めるのではなく、そのまま押せるボタンにして出す。
   * すでに下限なら出さない（できないことを勧めない）。
   */
  const nextScale = narrowerSearchScale(searchScale);
  const nextRate = slowerRate(playbackRate, PLAYBACK_RATES.map(r => r.v));

  const retryTips = (
    <div style={{ display: 'flex', gap: 6 }}>
      {nextScale !== null && (
        <button
          className="btn btn-secondary btn-sm"
          style={{ flex: 1, fontSize: '0.72rem' }}
          onClick={() => onChangeSearchScale(nextScale)}
        >
          探索範囲 {searchScale.toFixed(1)}→{nextScale.toFixed(1)}
        </button>
      )}
      {nextRate !== null && (
        <button
          className="btn btn-secondary btn-sm"
          style={{ flex: 1, fontSize: '0.72rem' }}
          onClick={() => setPlaybackRate(nextRate)}
        >
          再生速度 {rateLabel(playbackRate)}→{rateLabel(nextRate)}
        </button>
      )}
    </div>
  );

  /** 橋渡しで次に指す相手 */
  const bridgeTarget = tool === 'bridge'
    ? (manualPick ?? nextManualTarget(
        historyData, manualOrder, frameTimeRef.current, frameTolerance
      ).objId)
    : null;

  const hint: { text: string; bg: string; color: string } | null = (() => {
    if (!videoLoaded) return null;
    // 切り落とした直後は、次にすることだけを出す
    if (cutMsg) {
      return { text: `✂ ${cutMsg}`, bg: 'rgba(16,185,129,0.95)', color: '#04221a' };
    }
    if (tool === 'pick' || tool === 'bridge') return null;   // 帯の中に書いている
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
        text: roiCenter
          ? '大きさを合わせて「決定」'
          : `${selectedObjId} の中心を押す`,
        bg: `${selected?.color || '#6366f1'}f0`, color: '#fff',
      };
    }
    if (tool === 'seed') {
      return {
        text: `${selectedObjId} の枠から、移動した先まで指でなぞる`,
        bg: 'rgba(245,158,11,0.95)', color: '#000',
      };
    }
    if (seedMsg && seedMsg.betterSize === undefined) {
      return { text: `⚠ ${seedMsg.msg}`, bg: 'rgba(239,68,68,0.95)', color: '#fff' };
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


  /**
   * 再生バーに出す注意書き。
   *
   * 1 件ずつ行を足していくと、出るたびに映像とグラフが押し出される。
   * 再生しながらデータを見ているときに、これがいちばん効く邪魔になる。
   * 件数のバッジ 1 行に畳み、開いたときだけ中身を出す。
   */
  type Alert = {
    id: string;
    short: string;
    body: React.ReactNode;
    action?: { label: string; run: () => void };
  };
  const alerts: Alert[] = [];
  if (videoLoaded) {
    if (startMismatch && roiStartTime !== null && timeRange.start !== null) {
      alerts.push({
        id: 'start',
        short: '枠のコマと始点がずれています',
        body: <>枠を置いたのは {roiStartTime.toFixed(3)} s のコマですが、始点は{' '}
          {timeRange.start.toFixed(3)} s です。始点のコマに物体がいないと追跡が始まりません。</>,
        action: {
          label: '枠のコマを始点に',
          run: () => onChangeTimeRange({ ...timeRange, start: roiStartTime }),
        },
      });
    }
    if (roiFramesDiffer) {
      alerts.push({
        id: 'spread',
        short: '物体ごとに別のコマで枠を置いています',
        body: <>物体ごとに別のコマで枠を置いています（差 {roiSpread.toFixed(3)} s）。
          戻れるコマは 1 つしかないので、片方は必ず外れます。同じコマまで戻して置き直してください。</>,
      });
    }
    if (trackQuality.issues.length > 0) {
      alerts.push({
        id: 'jump',
        short: `位置の飛んだコマ ${trackQuality.issues.length} 個`,
        body: <>位置の飛んでいるコマが {trackQuality.issues.length} 個あります
          （{trackQuality.issues.slice(0, 4).map(v => v.timestamp.toFixed(3)).join(' / ')}
          {trackQuality.issues.length > 4 ? ' …' : ''} s・映像では橙の破線で囲んでいます）。
          動画側のコマの時刻ずれか、追跡の失敗です。速度と加速度はこの前後で必ず暴れます。</>,
      });
    }
    if (trackQuality.blurLimitTime !== null) {
      const end = trackQuality.blurLimitTime;
      alerts.push({
        id: 'blur',
        short: `${end.toFixed(2)} s からブレが大きすぎます`,
        body: <>{end.toFixed(3)} s から、1 コマの移動量が枠の大きさに近づきます。
          対象が自分の大きさ以上に流れて写るので、ここから先の点は中心からずれます。</>,
        action: {
          label: 'ここを終点に',
          run: () => onChangeTimeRange({ ...timeRange, end }),
        },
      });
    }
    // 区間の外でのロストは「もう写っていない」だけなので放っておく。
    // 区間の中でのロストは記録の穴になるので、次に試すことまで出す。
    if (lost.length > 0 && inTrimRange) {
      alerts.push({
        id: 'lost',
        short: `区間の途中で見失いました（${lost.map(o => o.id).join(', ')}）`,
        body: <>区間の途中で {lost.map(o => o.id).join(', ')} を見失いました。
          目印（丸シールなど）を使っているなら、<b>探索範囲を下げる</b>と
          似た模様に乗り移りにくくなります。あわせて<b>再生速度を落とす</b>と、
          コマの取りこぼしが減ります（取りこぼすと記録の上では 1 コマの
          移動量が倍になり、探索窓を超えます）。
          それでも駄目なら枠を取り直すか、そのコマだけ手で打ってください。</>,
        ...(nextScale !== null
          ? {
              action: {
                label: `探索範囲 ${searchScale.toFixed(1)} → ${nextScale.toFixed(1)}`,
                run: () => onChangeSearchScale(nextScale),
              },
            }
          : {}),
      });
    }
    if (tooFewPoints) {
      alerts.push({
        id: 'few',
        short: `区間内が ${pointsInRange} 点しかありません`,
        body: <>区間内が {pointsInRange} 点しかありません。{MIN_RANGE_POINTS} 点を切ると
          Butterworth の遮断周波数の自動選択が不安定になります。区間を広げてください。</>,
      });
    }
  }

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
          <div
            className="stage__toolbar"
            // 浮いている操作帯は「映像の外」として扱う。ここで止めないと、
            // ボタンを押した座標がそのまま映像のタップとして流れ、
            // 枠ツール中なら枠が置かれてしまう。
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
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
          <div
            className="stage__zoombar"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
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

        {/* ---- 枠の大きさ ---- */}
        {tool === 'roi' && roiCenter && (
          <div
            className="stage__sizebar fade-in"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <div className="row-between" style={{ fontSize: '0.78rem' }}>
              <span>枠の大きさ</span>
              <b className="mono" style={{
                color: roiSize < RECOMMENDED_ROI_SIZE ? 'var(--color-warning)' : 'var(--text-primary)',
              }}>{roiSize} px</b>
            </div>
            <input
              type="range" min={MIN_ROI_SIZE} max={260} step={2}
              value={roiSize}
              onChange={e => setRoiSize(parseInt(e.target.value, 10))}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={() => setRoiCenter(null)}
              >
                位置を取り直す
              </button>
              <button
                className="btn btn-primary btn-sm"
                style={{ flex: 1 }}
                onClick={confirmRoi}
              >
                決定
              </button>
            </div>
            {/*
                枠の大きさの助言はここから外した。
                この帯が出ているのは「映像を見ながら大きさを合わせている」
                最中で、そのとき知りたいのは拡大と移動の仕方だけ。
                枠の中身の話は、合わないときに実測して出す（2 点目の
                「この枠では滑ります」）ほうが確実で、読む手間もかからない。
            */}
            <div className="hint" style={{ margin: 0 }}>
              二本指で画面を動かせます
            </div>
          </div>
        )}

        {/* ---- 修正モードの操作 ---- */}
        {/*
            直せない点もある。対象が別のものに完全に乗り移った、
            物体が隠れて写っていない、といった場合は正しい位置が存在しない。
            そういう点はドラッグでは直せないので、消す口が要る。
            当てはめも 2 階差分も、1 点の跳ねで台無しになる。
        */}
        {videoLoaded && tool === 'correct' && !isPlaying && !halt && (
          <div
            className="stage__sizebar fade-in"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <button
              className="btn btn-secondary btn-sm"
              style={{ width: '100%' }}
              onClick={() => {
                const v = videoRef.current;
                const ok = onDropPoint(selectedObjId, v ? v.currentTime : 0);
                setCorrectMsg(
                  ok ? 'このコマの点を消しました' : 'このコマに消せる点がありません'
                );
              }}
            >
              <Trash2 size={15} />
              {selectedObjId} のこの点を消す
            </button>
          </div>
        )}

        {/* ---- 橋渡し ---- */}
        {/*
            跳ねて捨てたコマを、人が指して埋める。これが「枠を置き直す」の
            代わりに要る作業。枠の位置は記録から分かっているので置き直しても
            新しい情報は無く、足りないのは「跳ねたコマで対象はどこに居たか」。
            指してもらえば、(1) 捨てたコマが本来の位置で埋まり、
            (2) 最後の 2 点から再開の初速が出て、
            (3) 難しい場面の先でテンプレートを作り直せる。
        */}
        {tool === 'bridge' && (
          <div
            className="stage__pickbar"
            style={{ gridTemplateColumns: '1fr auto auto' }}
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <div className="stage__pickbar-why">
              捨てたコマを埋めます。
              <b>{bridgeTarget ?? selectedObjId} の中心</b>をタップ。
              そのコマの対象が揃うと 1 コマ進みます。2〜3 コマで「自動に戻す」。
            </div>
            <div className="stage__pickbar-info">
              <b className="mono">{bridgeCount} 点</b>
              <span>{currentTime.toFixed(3)} s</span>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={bridgeCount < 2}
              onClick={() => {
                const r = onBridgeFinish(videoRef.current || undefined);
                setSeedMsg(r.msg ? r : null);
                setBridgeCount(0);
                setTool('pan');
              }}
            >
              <Play size={14} />
              自動に戻す
            </button>
            <button
              className="btn btn-icon btn-sm btn-secondary"
              aria-label="やめる"
              onClick={() => { setBridgeCount(0); setTool('pan'); }}
            >
              <XCircle size={16} />
            </button>
          </div>
        )}

        {/* ---- 2 点目で「滑る」と分かったときの案内 ---- */}
        {/*
            原因を告げるだけでは、利用者は枠の大きさを自分で当てにいく
            ことになる。測った結果が手元にあるのだから、その大きさで
            置き直すところまで渡す。
        */}
        {seedMsg && seedMsg.betterSize !== undefined && tool !== 'seed' && (
          <div
            className="stage__haltbar fade-in"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <div className="stage__haltbar-title">⚠ この枠では滑ります</div>
            <div className="hint" style={{ margin: 0 }}>{seedMsg.msg}</div>
            <button
              className="btn btn-primary btn-sm"
              style={{ width: '100%' }}
              onClick={() => {
                const n = seedMsg.betterSize as number;
                const o = objects.find(x => x.id === selectedObjId);
                const base = o ? sizeOf(o) : null;
                setSeedMsg(null);
                setRoiSize(n);
                if (base) {
                  setRoiCenter({
                    x: base.x + base.width / 2,
                    y: base.y + base.height / 2,
                  });
                }
                setTool('roi');
                void goToStart();
              }}
            >
              <Maximize size={15} />
              枠を {seedMsg.betterSize}px にして置き直す
            </button>
            <button
              className="btn btn-secondary btn-sm"
              style={{ width: '100%' }}
              onClick={() => setSeedMsg(null)}
            >
              このまま進める
            </button>
          </div>
        )}

        {/* ---- 追跡が飛んで止まったときの案内 ---- */}
        {halt && tool !== 'pick' && (
          <div
            className="stage__haltbar fade-in"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <div className="stage__haltbar-title">
              {halt.objId}: {halt.time.toFixed(3)} s で追跡が飛びました
            </div>
            <div className="hint" style={{ margin: 0 }}>
              1 コマ {Math.round(halt.step)}px（普段は {Math.round(halt.base)}px）
              {halt.atEdge && '・探索窓の縁'}。✕ の手前からずれ始めています。
            </div>
            <button
              className="btn btn-primary btn-sm"
              style={{ width: '100%' }}
              onClick={() => setTool('pick')}
            >
              <Scissors size={15} />
              ここから取り直す
            </button>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={() => {
                  onDismissHalt(false);
                  setTool('correct');
                  void seekToTime(halt.time);
                }}
              >
                手で直す
              </button>
              <button
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={() => onDismissHalt(true)}
              >
                誤検出・続ける
              </button>
            </div>
            {(nextScale !== null || nextRate !== null) && (
              <>
                <div className="hint" style={{ margin: 0 }}>
                  目印を使っているなら、次を試すと再発しにくくなります。
                  窓が広いと似た模様に乗り移り、コマを取りこぼすと 1 コマの
                  移動量が倍になります。
                </div>
                {retryTips}
              </>
            )}
          </div>
        )}

        {/* ---- どこまで戻すかを選ぶ ---- */}
        {/*
            一列の細い帯にしてある。前は縦に積んだパネルで、映像の下半分を
            覆っていた。選ぶ対象は映像の上の点なので、覆ってはいけない。
        */}
        {tool === 'pick' && (
          <div
            className="stage__pickbar"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
          >
            <div className="stage__pickbar-why">
              点がマーカーに乗っている<b>最後のコマ</b>へ。◀▶ か軌跡をなぞって選ぶと、
              そのコマが映ります
            </div>
            <button
              className="btn btn-icon btn-sm btn-secondary"
              aria-label="1つ前の点"
              disabled={pickIdx === null || pickIdx <= 0}
              onClick={() => setPickIdx(i => (i === null ? null : Math.max(0, i - 1)))}
            >
              <ChevronLeft size={16} />
            </button>
            <div className="stage__pickbar-info">
              <b className="mono">
                {pickIdx !== null && pickPoints[pickIdx]
                  ? `${pickPoints[pickIdx].time.toFixed(3)} s`
                  : '—'}
              </b>
              <span>
                {pickIdx !== null && pickPoints.length - 1 - pickIdx > 0
                  ? `後ろ ${pickPoints.length - 1 - pickIdx} 点を捨てる`
                  : 'この点まで残す'}
              </span>
            </div>
            <button
              className="btn btn-icon btn-sm btn-secondary"
              aria-label="1つ後の点"
              disabled={pickIdx === null || pickIdx >= pickPoints.length - 1}
              onClick={() =>
                setPickIdx(i => (i === null ? null : Math.min(pickPoints.length - 1, i + 1)))
              }
            >
              <ChevronRight size={16} />
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={pickIdx === null || !pickPoints[pickIdx]}
              onClick={() => {
                if (pickIdx !== null && pickPoints[pickIdx]) cutAt(pickPoints[pickIdx]);
              }}
            >
              <Scissors size={15} />
              ここで切る
            </button>
            <button
              className="btn btn-icon btn-sm btn-secondary"
              aria-label="やめる"
              onClick={() => { onDismissHalt(false); setTool('pan'); }}
            >
              <XCircle size={16} />
            </button>
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
            disabled={!videoLoaded}
            aria-label={`やり直し — 軌跡を消し、枠を戻して ${restartTime.toFixed(3)} s へ送る`}
            title={`やり直し → ${restartTime.toFixed(3)} s`}>
            <RotateCcw size={16} />
          </button>
          {/* 記録が始まるコマへ移動するだけ。軌跡は消さない。
              やり直しと混同されていたので、別のボタンとして分けた。 */}
          <button className="btn btn-secondary btn-icon btn-sm" onClick={() => void goToStart()}
            disabled={!videoLoaded}
            aria-label={`始点へ — 記録が始まる ${restartTime.toFixed(3)} s へ送る（軌跡は消さない）`}
            title={`始点へ → ${restartTime.toFixed(3)} s`}>
            <SkipBack size={16} />
          </button>

          {/*
              再生速度は「ひとつ選んだら、その動画のあいだは変えない」設定なので、
              5 つ並べたままにしておく価値が薄い。常時並べると行に収まらず
              折り返して、映像の高さをずっと奪っていた。
              普段は今の速度だけを出し、押したときだけ選択肢を開く。
          */}
          <button
            className={`chip ${rateOpen ? 'is-active' : ''}`}
            style={{ marginLeft: 'auto', minHeight: 34, padding: '4px 10px', fontSize: '0.74rem' }}
            onClick={() => setRateOpen(v => !v)}
            aria-label={`再生速度 ${rateLabel(playbackRate)}（押すと変えられます）`}
          >
            {rateLabel(playbackRate)}
            {rateOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        </div>

        {rateOpen && (
          <div className="playbar__row fade-in" style={{ gap: 6 }}>
            <span style={{
              fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
            }}>
              再生速度
            </span>
            {PLAYBACK_RATES.map(r => (
              <button
                key={r.v}
                className={`chip ${Math.abs(playbackRate - r.v) < 1e-6 ? 'is-active' : ''}`}
                style={{ flex: 1, minHeight: 34, padding: '4px 6px', fontSize: '0.72rem' }}
                onClick={() => { setPlaybackRate(r.v); setRateOpen(false); }}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

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
          <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
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
              style={{ flex: 1, width: '100%' }}
            />
            {/* 区間の帯。つまみの半分（8px）だけ内側にトラックがあるので合わせる */}
            {rangeActive && duration > 0 && (
              <div style={{
                position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none',
              }}>
                <div style={{
                  position: 'absolute',
                  left: `calc(8px + (100% - 16px) * ${bandLeft})`,
                  width: `calc((100% - 16px) * ${Math.max(0, bandRight - bandLeft)})`,
                  top: '50%', height: 8, transform: 'translateY(-50%)',
                  background: 'rgba(99,102,241,0.35)',
                  borderLeft: timeRange.start !== null ? '2px solid var(--accent-primary)' : 'none',
                  borderRight: timeRange.end !== null ? '2px solid var(--accent-primary)' : 'none',
                  borderRadius: 2,
                }} />
              </div>
            )}
          </div>
          <span className="playbar__time">
            {currentTime.toFixed(2)} / {duration.toFixed(1)}s
          </span>
        </div>

        {/* ---- 解析区間（トリムタブを開いている間だけ） ----
             どのタブでも出していると、使わない時間のほうが長いのに
             場所だけ占め続ける。説明はトリムタブ側に置いた。 */}
        {videoLoaded && trimMode && (
          <div className="playbar__row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Scissors
              size={14}
              color={rangeActive ? 'var(--accent-primary)' : 'var(--text-muted)'}
              style={{ flexShrink: 0 }}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={setRangeStartHere}
              aria-label="いま表示しているフレームを区間の始点にする"
            >
              <CornerDownRight size={13} />始点
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={setRangeEndHere}
              aria-label="いま表示しているフレームを区間の終点にする"
            >
              <CornerDownLeft size={13} />終点
            </button>
            {rangeActive && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={clearRange}
                aria-label="区間を解除する"
              >
                <XCircle size={13} />解除
              </button>
            )}
            <span className="mono" style={{
              fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
            }}>
              {rangeActive ? (
                <>
                  {timeRange.start !== null ? timeRange.start.toFixed(2) : '先頭'}
                  〜
                  {timeRange.end !== null ? timeRange.end.toFixed(2) : '末尾'} s
                </>
              ) : '動画全体'}
            </span>
          </div>
        )}

        {/* ---- 注意書き ----
             出るたびに行が伸びると、映像とグラフが押し出される。
             件数のバッジ 1 行に畳み、開いたときだけ中身を出す。 */}
        {alerts.length > 0 && (
          <div className="playbar__row" style={{ gap: 8 }}>
            <button
              className="btn btn-warning btn-sm"
              style={{ flexShrink: 0 }}
              onClick={() => setAlertsOpen(v => !v)}
              aria-expanded={alertsOpen}
              aria-label={`注意 ${alerts.length} 件`}
            >
              ⚠ {alerts.length}件
              {alertsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {!alertsOpen && (
              <span style={{
                fontSize: '0.72rem', color: '#fcd34d',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {alerts[0].short}{alerts.length > 1 ? ` ほか${alerts.length - 1}件` : ''}
              </span>
            )}
          </div>
        )}
        {alertsOpen && alerts.map(a => (
          <div key={a.id} className="playbar__row fade-in" style={{
            gap: 8, alignItems: 'flex-start',
            fontSize: '0.72rem', color: '#fcd34d', lineHeight: 1.5,
          }}>
            <span style={{ flex: 1 }}>⚠ {a.body}</span>
            {a.action && (
              <button
                className="btn btn-warning btn-sm"
                style={{ flexShrink: 0 }}
                onClick={a.action.run}
              >
                {a.action.label}
              </button>
            )}
          </div>
        ))}

        {!rvfcSupported && (
          <div style={{ fontSize: '0.68rem', color: 'var(--color-warning)' }}>
            ※ このブラウザはフレーム同期APIに非対応です。iOS は Safari、Android は Chrome を推奨します。
          </div>
        )}
      </div>
    </>
  );
};
