import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fase 5 (docs/plan.md) — cutover: base real "/admin/", servido pelo Express no lugar dos
// 29 `sendFile` antigos. Era "/admin-v3/" nas Fases 0-4 (validação lado a lado).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    fs: {
      // permite importar tokens.css/components.css de ../src/admin/design-system
      // sem duplicar CSS dentro do admin-app (decisão do plano: reaproveitar, não redesenhar)
      allow: ['..'],
    },
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
  },
});
