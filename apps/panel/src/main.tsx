import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

// Ordem importa: tokens-base.css é a fonte única dos valores (e a base do documento);
// pedido-admin.css ainda carrega classes legadas .pa-* (já em tokens canônicos); components.css e
// admin-shell.css consomem os tokens canônicos. Ver /DESIGN.md.
import './admin/design-system/tokens-base.css';
import './pedido-admin.css';
import './admin/design-system/components.css';
import './admin/admin-shell.css';

// CSS das telas carregado junto com a base, na mesma ordem em que as rotas o importavam antes do
// code-splitting (Fase 9): as telas agora chegam sob demanda (React.lazy), mas várias classes são
// compartilhadas entre telas (.pc-kv, .tn-form, .ad-vinculo-*) e a cascata não pode depender de qual
// tela foi aberta primeiro. São ~80 KB de CSS; o ganho do split está no JS.
import './whatsapp-web.css';
import './pedidos-central.css';
import './trocas-nova.css';
import './produtos.css';
import './categorias.css';
import './clientes.css';
import './integracoes.css';
import './estoque.css';
import './campos.css';
import './configuracoes.css';
import './templates.css';
import './automacoes.css';
import './dashboard.css';
import './recuperacao.css';
import './pix-ferramenta.css';
import './produtos-novo.css';
import './promocoes.css';
import './trocas.css';
import './reembolsos.css';
import './simular-frete.css';
import './campanhas.css';

import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
