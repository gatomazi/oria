import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `.mjs` de propósito: o `package.json` deste app é CommonJS (o backend em `server.js` usa
// `require`/`module.exports` e não vai ser convertido). A extensão `.mjs` deixa o Node carregar
// esta config como ESM sem `"type": "module"` no manifesto — que quebraria o backend inteiro.
//
// A raiz do Vite é a raiz do painel: `index.html` (shell do SPA) e `src/` moram aqui desde que
// `apps/panel/admin/` deixou de existir e o frontend subiu para a raiz do deployable. Por isso
// sumiu o `server.fs.allow` que existia aqui: o CSS do design system (`src/admin/design-system/`)
// não fica mais fora da raiz do Vite, é `src/` mesmo.
//
// `base: '/admin/'` é a URL, não a pasta. A pasta `admin/` acabou; a rota web `/admin` continua
// exatamente como está no ar — é por ela que o painel responde, e mudá-la não é escopo desta
// refatoração. Ver o comentário da rota do SPA em server.js.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
  },
});
