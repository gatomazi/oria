import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './shell/AppShell';
import { PageStack, Skeleton } from './components/ds';

// Cada tela vira um chunk carregado sob demanda (Fase 9): o bundle inicial deixa de levar Recharts,
// editores de template e ferramentas internas pra quem só abriu Pedidos.
function tela<K extends string>(carregar: () => Promise<Record<K, ComponentType>>, nome: K) {
  return lazy(() => carregar().then((m) => ({ default: m[nome] })));
}

const Playground = tela(() => import('./pages/Playground'), 'Playground');
const CategoriasPage = tela(() => import('./pages/categorias/CategoriasPage'), 'CategoriasPage');
const AssociarProdutosPage = tela(() => import('./pages/categorias/AssociarProdutosPage'), 'AssociarProdutosPage');
const ClientesPage = tela(() => import('./pages/clientes/ClientesPage'), 'ClientesPage');
const IntegracoesPage = tela(() => import('./pages/integracoes/IntegracoesPage'), 'IntegracoesPage');
const EstoquePage = tela(() => import('./pages/estoque/EstoquePage'), 'EstoquePage');
const CamposPage = tela(() => import('./pages/campos/CamposPage'), 'CamposPage');
const ConfiguracoesPage = tela(() => import('./pages/configuracoes/ConfiguracoesPage'), 'ConfiguracoesPage');
const AutomacoesPage = tela(() => import('./pages/automacoes/AutomacoesPage'), 'AutomacoesPage');
const EventosPage = tela(() => import('./pages/eventos/EventosPage'), 'EventosPage');
const DashboardPage = tela(() => import('./pages/dashboard/DashboardPage'), 'DashboardPage');
const RecuperacaoPage = tela(() => import('./pages/recuperacao/RecuperacaoPage'), 'RecuperacaoPage');
const PedidosCentralPage = tela(() => import('./pages/pedidos-central/PedidosCentralPage'), 'PedidosCentralPage');
const PedidoAdminPage = tela(() => import('./pages/pedido-admin/PedidoAdminPage'), 'PedidoAdminPage');
const PedidoNovoPage = tela(() => import('./pages/pedido-novo/PedidoNovoPage'), 'PedidoNovoPage');
const PedidoVincularPage = tela(() => import('./pages/pedido-vincular/PedidoVincularPage'), 'PedidoVincularPage');
const PixFerramentaPage = tela(() => import('./pages/pix-ferramenta/PixFerramentaPage'), 'PixFerramentaPage');
const ProdutosPage = tela(() => import('./pages/produtos/ProdutosPage'), 'ProdutosPage');
const ProdutosNovoPage = tela(() => import('./pages/produtos-novo/ProdutosNovoPage'), 'ProdutosNovoPage');
const AgrupamentosPage = tela(() => import('./pages/agrupamentos/AgrupamentosPage'), 'AgrupamentosPage');
const PromocoesPage = tela(() => import('./pages/promocoes/PromocoesPage'), 'PromocoesPage');
const TrocasPage = tela(() => import('./pages/trocas/TrocasPage'), 'TrocasPage');
const TrocasNovaPage = tela(() => import('./pages/trocas-nova/TrocasNovaPage'), 'TrocasNovaPage');
const ReembolsosPage = tela(() => import('./pages/reembolsos/ReembolsosPage'), 'ReembolsosPage');
const FinanceiroPage = tela(() => import('./pages/financeiro/FinanceiroPage'), 'FinanceiroPage');
const DespesasPage = tela(() => import('./pages/financeiro/DespesasPage'), 'DespesasPage');
const CustosApiPage = tela(() => import('./pages/financeiro/CustosApiPage'), 'CustosApiPage');
const SimularFretePage = tela(() => import('./pages/simular-frete/SimularFretePage'), 'SimularFretePage');
const TemplatesPage = tela(() => import('./pages/templates/TemplatesPage'), 'TemplatesPage');
const TemplatesNovoPage = tela(() => import('./pages/templates-novo/TemplatesNovoPage'), 'TemplatesNovoPage');
const TemplatesDetalhePage = tela(() => import('./pages/templates-detalhe/TemplatesDetalhePage'), 'TemplatesDetalhePage');
const WhatsappVisaoGeralPage = tela(() => import('./pages/whatsapp-visao-geral/WhatsappVisaoGeralPage'), 'WhatsappVisaoGeralPage');
const FilaWhatsappWebPage = tela(() => import('./pages/whatsapp-web-fila/FilaWhatsappWebPage'), 'FilaWhatsappWebPage');
const MensagensWebPage = tela(() => import('./pages/mensagens-web/MensagensWebPage'), 'MensagensWebPage');
const MensagemWebEditorPage = tela(() => import('./pages/mensagens-web/MensagemWebEditorPage'), 'MensagemWebEditorPage');
const SegmentosPage = tela(() => import('./pages/campanhas/SegmentosPage'), 'SegmentosPage');
const CampanhasPage = tela(() => import('./pages/campanhas/CampanhasPage'), 'CampanhasPage');
const NovaCampanhaPage = tela(() => import('./pages/campanhas/NovaCampanhaPage'), 'NovaCampanhaPage');
const CampanhaDetalhePage = tela(() => import('./pages/campanhas/CampanhaDetalhePage'), 'CampanhaDetalhePage');
const OrigensMigrationPage = tela(() => import('./pages/internal/OrigensMigrationPage'), 'OrigensMigrationPage');
const UtmTrackerPage = tela(() => import('./pages/utm/UtmTrackerPage'), 'UtmTrackerPage');
const AnalyticsGa4Page = tela(() => import('./pages/analytics/AnalyticsGa4Page'), 'AnalyticsGa4Page');
const MetaAdsPage = tela(() => import('./pages/meta/MetaAdsPage'), 'MetaAdsPage');
const GoogleAdsPage = tela(() => import('./pages/google-ads/GoogleAdsPage'), 'GoogleAdsPage');
const CriativosPage = tela(() => import('./pages/criativos/CriativosPage'), 'CriativosPage');

// Fase 5 (docs/plan.md) — cutover: todas as 29 páginas reais do admin, roteadas sob /admin/*,
// substituindo os antigos sendFile em server.js. Caminhos abaixo espelham 1:1 as rotas reais.
export function App() {
  return (
    <AuthProvider>
      <ProtectedRoute>
        <AppShell>
          <Suspense
            fallback={
              <PageStack>
                <Skeleton rows={1} height="56px" width="40%" />
                <Skeleton variant="table" rows={6} />
              </PageStack>
            }
          >
          <Routes>
            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="/admin/playground" element={<Playground />} />

            <Route path="/admin/dashboard" element={<DashboardPage />} />
            <Route path="/admin/pedidos-central" element={<PedidosCentralPage />} />
            <Route path="/admin/trocas" element={<TrocasPage />} />
            <Route path="/admin/trocas/nova" element={<TrocasNovaPage />} />
            <Route path="/admin/recuperacao" element={<RecuperacaoPage />} />
            <Route path="/admin/estoque" element={<EstoquePage />} />
            <Route path="/admin/clientes" element={<ClientesPage />} />
            {/* /admin/carrinhos foi substituído por /admin/recuperacao (Fase 6 do plano V2) —
                server.js já faz esse redirect há tempos; mantido aqui só pra não depender de um
                round-trip ao servidor quando alguém navega direto pra essa rota antiga na SPA. */}
            <Route path="/admin/carrinhos" element={<Navigate to="/admin/recuperacao" replace />} />

            <Route path="/admin/produtos" element={<ProdutosPage />} />
            <Route path="/admin/produtos/novo" element={<ProdutosNovoPage />} />
            <Route path="/admin/categorias" element={<CategoriasPage />} />
            <Route path="/admin/categorias/associar" element={<AssociarProdutosPage />} />
            <Route path="/admin/agrupamentos" element={<AgrupamentosPage />} />
            <Route path="/admin/promocoes" element={<PromocoesPage />} />
            {/* Ferramenta interna (docs/claude-categorias-lote-migracao-use-origens.md, Parte 4) —
                a rota em si não é secreta, a página checa a flag e o backend bloqueia de verdade
                (requireInternalTools/404) se INTERNAL_TOOLS_ENABLED estiver desligada. */}
            <Route path="/admin/internal/origens-migration" element={<OrigensMigrationPage />} />

            <Route path="/admin/whatsapp" element={<WhatsappVisaoGeralPage />} />
            <Route path="/admin/whatsapp/fila" element={<FilaWhatsappWebPage />} />
            <Route path="/admin/mensagens" element={<MensagensWebPage />} />
            <Route path="/admin/mensagens/nova" element={<MensagemWebEditorPage />} />
            <Route path="/admin/mensagens/:id" element={<MensagemWebEditorPage />} />
            <Route path="/admin/automacoes" element={<AutomacoesPage />} />
            <Route path="/admin/templates" element={<TemplatesPage />} />
            <Route path="/admin/templates/novo" element={<TemplatesNovoPage />} />
            <Route path="/admin/templates/detalhe" element={<TemplatesDetalhePage />} />
            <Route path="/admin/campanhas" element={<CampanhasPage />} />
            <Route path="/admin/campanhas/nova" element={<NovaCampanhaPage />} />
            <Route path="/admin/campanhas/segmentos" element={<SegmentosPage />} />
            <Route path="/admin/campanhas/:id" element={<CampanhaDetalhePage />} />

            <Route path="/admin/financeiro" element={<FinanceiroPage />} />
            <Route path="/admin/financeiro/despesas" element={<DespesasPage />} />
            <Route path="/admin/financeiro/custos-api" element={<CustosApiPage />} />
            <Route path="/admin/reembolsos" element={<ReembolsosPage />} />

            <Route path="/admin/simular-frete" element={<SimularFretePage />} />
            <Route path="/admin/pix" element={<PixFerramentaPage />} />
            <Route path="/admin/utm" element={<UtmTrackerPage />} />
            <Route path="/admin/analytics" element={<AnalyticsGa4Page />} />
            <Route path="/admin/meta-ads" element={<MetaAdsPage />} />
            <Route path="/admin/google-ads" element={<GoogleAdsPage />} />
            <Route path="/admin/criativos" element={<CriativosPage />} />
            <Route path="/admin/pedidos" element={<PedidoAdminPage />} />
            <Route path="/admin/pedidos/novo" element={<PedidoNovoPage />} />
            <Route path="/admin/pedidos/vincular" element={<PedidoVincularPage />} />

            <Route path="/admin/campos" element={<CamposPage />} />
            <Route path="/admin/eventos" element={<EventosPage />} />
            <Route path="/admin/integracoes" element={<IntegracoesPage />} />
            <Route path="/admin/configuracoes" element={<ConfiguracoesPage />} />
          </Routes>
          </Suspense>
        </AppShell>
      </ProtectedRoute>
    </AuthProvider>
  );
}
