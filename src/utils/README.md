# このフォルダと `src/types` は PC 版からの同期コピーです

`src/utils/*.ts` と `src/types/*.ts` は、PC 版リポジトリ
[`tracker_PC`](https://github.com/Shin-phys/tracker_PC) の同名ファイルを
そのままコピーしたものです。**このリポジトリ側で編集しないでください。**
次に同期したときに上書きされて消えます。

## なぜ分けているか

PC 版とスマホ版は UI（`components/`）が別物なので共有できませんが、
計算とデータ構造の層は 1 行も違いません。

| | 行数 | 状態 |
|---|---|---|
| `utils/` + `types/` | 約 1,670 行 | 完全に同一 |
| `components/` | 約 3,800 行 | UI が違うため別実装 |

平滑化の追加や時間軸の換算のように、同じ変更を 2 回書く場面が繰り返し
出てきました。2 回書くと必ずどちらかが古くなるため、PC 版を正として
機械的に配る方式にしています。

## 直したいとき

PC 版のリポジトリで該当ファイルを編集し、PC 版のルートで同期します。

```bash
cd <tracker_PC のフォルダ>
npm run sync:core          # スマホ版へコピー
npm run sync:core:check    # 差分があれば異常終了（コミット前の確認用）
```

同期先は「隣のフォルダのうち `src/components/VideoStage.tsx` を持つもの」を
自動で探します。別の場所に置いている場合は環境変数で指定してください。

```bash
TRACKER_MOBILE_DIR=/path/to/tracker_mobile npm run sync:core
```

同期したあとは、**両方のリポジトリでビルドを通してから**それぞれ
コミットしてください（`npm run build`）。
