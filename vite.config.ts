import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: 'Attendance Portal Bosaso',
        short_name: 'Attendance Bosaso',
        description: 'QR employee attendance system',
        theme_color: '#102a43',
        background_color: '#f4f7fb',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/pwa.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          xlsx: ['xlsx'],
          qrcode: ['html5-qrcode', 'qrcode.react'],
        },
      },
    },
  },
});
