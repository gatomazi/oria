import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

// Ordem importa: tokens-base.css é a fonte única dos valores (e a base do documento);
// pedido-admin.css ainda carrega classes legadas .pa-* (já em tokens canônicos); components.css e
// admin-shell.css consomem os tokens canônicos. Ver /DESIGN.md.
import '../../src/admin/design-system/tokens-base.css';
import '../../src/pedido-admin.css';
import '../../src/admin/design-system/components.css';
import '../../src/admin/admin-shell.css';

// CSS das telas carregado junto com a base, na mesma ordem em que as rotas o importavam antes do
// code-splitting (Fase 9): as telas agora chegam sob demanda (React.lazy), mas várias classes são
// compartilhadas entre telas (.pc-kv, .tn-form, .ad-vinculo-*) e a cascata não pode depender de qual
// tela foi aberta primeiro. São ~80 KB de CSS; o ganho do split está no JS.
import '../../src/whatsapp-web.css';
import '../../src/pedidos-central.css';
import '../../src/trocas-nova.css';
import '../../src/produtos.css';
import '../../src/categorias.css';
import '../../src/clientes.css';
import '../../src/integracoes.css';
import '../../src/estoque.css';
import '../../src/campos.css';
import '../../src/configuracoes.css';
import '../../src/templates.css';
import '../../src/automacoes.css';
import '../../src/dashboard.css';
import '../../src/recuperacao.css';
import '../../src/pix-ferramenta.css';
import '../../src/produtos-novo.css';
import '../../src/promocoes.css';
import '../../src/trocas.css';
import '../../src/reembolsos.css';
import '../../src/simular-frete.css';
import '../../src/campanhas.css';

import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
