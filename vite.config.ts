import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // GitHub Pages デプロイ用の相対パス設定
  server: {
    port: 3000,
    open: true,
    // 実機のスマホから同じ Wi-Fi 経由で開けるように LAN へ公開する。
    // 起動時に表示される http://192.168.x.x:3000 を端末で開く。
    host: true,
  },
  build: {
    // OpenCV.js の WASM ファイルを正しく扱うための設定
    assetsInlineLimit: 0,
  }
});
