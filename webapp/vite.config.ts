import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['pdf.dev.vennlabs.dev', 'pdf.vennlabs.dev'],
    hmr: {
      host: 'pdf.dev.vennlabs.dev',
      protocol: 'wss',
      clientPort: 443,
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  worker: {
    format: 'es',
  },
})
