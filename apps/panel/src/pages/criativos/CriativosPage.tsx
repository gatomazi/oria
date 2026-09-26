import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button, Callout, ErrorState, PageHeader, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import {
  getCatalog,
  getCopiaDados,
  getCriativosStatus,
  type Catalog,
  type CopiaDados,
  type CriativosStatus,
} from '../../api/criativos';
import { GerarTab } from './GerarTab';
import { GerarTabV2 } from './GerarTabV2';
import { HistoricoTab, LotesTab } from './LotesTab';
import { PerfisTab, PersonasTab, ProdutosTab } from './CadastrosTabs';

import '../../criativos.css';

// Gerador de Criativos (Oria) — Etapa 2 (funcional). Três motores (Ângulos Limpos, Remarketing, Funil por Criativo)
// com Multipeça dentro de cada um. A proteção real (admin, flags, tenant, BYOK) é do backend; esta tela só reflete.
// Lapidação visual fica para a Etapa 3 (docs/creative-generator/03-etapa-frontend-skills-saas-v2.md).

type Aba = 'gerar' | 'lotes' | 'historico' | 'produtos' | 'marca' | 'contextos' | 'personas';

// Cada seção é uma rota (/admin/criativos/:aba) com item próprio no menu lateral — a página não tem mais abas internas.
const SECOES: Record<Aba, { titulo: string; descricao: string }> = {
  gerar: { titulo: 'Gerar criativos', descricao: 'Ângulos Limpos, Remarketing e Funil por Criativo — com um produto ou multipeça.' },
  lotes: { titulo: 'Lotes', descricao: 'Acompanhe os lotes em geração e abra os criativos prontos.' },
  historico: { titulo: 'Histórico', descricao: 'Criativos já gerados: reveja, avalie e copie os dados para gerar de novo.' },
  produtos: { titulo: 'Produtos para criativos', descricao: 'Produtos que o gerador pode usar nos criativos.' },
  marca: { titulo: 'Marca e nicho', descricao: 'Perfis de marca e de nicho que orientam o tom e o visual dos criativos.' },
  contextos: { titulo: 'Contextos', descricao: 'Contextos de uso e de cena para os criativos.' },
  personas: { titulo: 'Personas', descricao: 'Públicos e personas que o gerador considera.' },
};
const ehAba = (v: string | undefined): v is Aba => !!v && Object.prototype.hasOwnProperty.call(SECOES, v);

export function CriativosPage() {
  const { aba: abaDaRota } = useParams();
  const aba: Aba = ehAba(abaDaRota) ? abaDaRota : 'gerar';
  const [status, setStatus] = useState<CriativosStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [erro, setErro] = useState('');
  const [jobSelecionado, setJobSelecionado] = useState<string | null>(null);
  // Dados copiados de um criativo pronto; o Gerar preenche o formulário com eles.
  const [copia, setCopia] = useState<CopiaDados | null>(null);
  const navigate = useNavigate();
  // Trocar de seção troca a rota; a página continua montada, então catálogo, lote selecionado e dados copiados não se perdem.
  const setAba = useCallback((proxima: Aba) => navigate(`/admin/criativos/${proxima}`), [navigate]);

  const carregar = useCallback(() => {
    setErro('');
    getCriativosStatus()
      .then((s) => {
        setStatus(s);
        if (s.flags.creative_generator && s.core.reachable) {
          getCatalog().then(setCatalog).catch((e: Error) => setErro(e.message));
        }
      })
      .catch((e: Error) => setErro(e.message));
  }, []);

  useEffect(carregar, [carregar]);

  // O erro sobe para quem clicou (o botão mostra a mensagem); só abre o gerador quando o rascunho chegou.
  const copiarDados = useCallback(async (creativeId: string) => {
    const dados = await getCopiaDados(creativeId);
    setCopia(dados);
    setAba('gerar');
  }, [setAba]);

  if (!ehAba(abaDaRota)) return <Navigate to="/admin/criativos/gerar" replace />;
  if (erro && !status) return <PageStack><ErrorState description={erro} onRetry={carregar} /></PageStack>;
  if (!status) return <PageStack><Skeleton rows={1} height="56px" width="40%" /><Skeleton variant="table" rows={4} /></PageStack>;

  const habilitado = status.flags.creative_generator;
  const avisos = [];
  if (!habilitado) {
    avisos.push(
      <Callout key="flag" tone="info" title="Gerador de Criativos desligado nesta conta">
        O módulo inteiro é liberado por uma única feature do plano: <code>creative_generator</code>. Os motores
        (ângulos limpos, remarketing, funil visual, multiproduto) vêm junto com ele — não são features separadas.
        Veja o roteiro em docs/creative-generator/MANUAL_TEST_GUIDE.md.
      </Callout>,
    );
  }
  if (!status.postgres) avisos.push(<Callout key="pg" tone="warning" title="Postgres não configurado">O gerador guarda produtos, lotes e histórico no Postgres (DATABASE_URL).</Callout>);
  if (habilitado && !status.core.configured) avisos.push(<Callout key="core" tone="warning" title="Serviço do gerador não configurado">Defina CREATIVE_CORE_URL e CREATIVE_CORE_SERVICE_TOKEN no painel.</Callout>);
  if (habilitado && status.core.configured && !status.core.reachable) avisos.push(<Callout key="core2" tone="danger" title="Serviço do gerador fora do ar">Os lotes ficam na fila e são retomados quando o serviço voltar.</Callout>);
  if (habilitado && !status.openaiKey.configured) avisos.push(<Callout key="key" tone="warning" title="OpenAI API Key não cadastrada" action={<Button size="sm" variant="secondary" onClick={() => navigate('/admin/integracoes')}>Configurar</Button>}>A geração usa a sua própria chave (BYOK).</Callout>);

  return (
    <PageStack>
      <PageHeader
        title={SECOES[aba].titulo}
        description={SECOES[aba].descricao}
        meta={status.core.versions ? <StatusBadge tone="neutral" label={`core ${String(status.core.versions.core_version)}`} /> : undefined}
      />
      {avisos}
      {habilitado && (
        <>
          {aba === 'gerar' && (catalog
            ? (status.uiV2
              ? <GerarTabV2 status={status} catalog={catalog} copia={copia} onCopiaLida={() => setCopia(null)} onJobCriado={(id) => { setJobSelecionado(id); setAba('lotes'); }} />
              : <GerarTab status={status} catalog={catalog} copia={copia} onCopiaLida={() => setCopia(null)} onJobCriado={(id) => { setJobSelecionado(id); setAba('lotes'); }} />)
            : <Callout tone="info">Catálogo indisponível enquanto o serviço do gerador não responde.</Callout>)}
          {aba === 'lotes' && <LotesTab selecionado={jobSelecionado} onSelecionar={setJobSelecionado} onCopiar={copiarDados} />}
          {aba === 'historico' && <HistoricoTab onCopiar={copiarDados} />}
          {aba === 'produtos' && <ProdutosTab />}
          {aba === 'marca' && <PerfisTab tipo="marca" catalog={catalog} />}
          {aba === 'contextos' && <PerfisTab tipo="contexto" catalog={catalog} />}
          {aba === 'personas' && <PersonasTab catalog={catalog} />}
        </>
      )}
    </PageStack>
  );
}
