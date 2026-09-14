import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: { name: 'Counterline POS', short_name: 'Counterline', description: 'An offline-capable point of sale for independent retailers.', theme_color: '#193228', background_color: '#f7f2e7', display: 'standalone' },
    workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
  })],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
