import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Callout, ErrorState, PageHeader, PageStack, Skeleton, StatusBadge, TabList } from '../../components/ds';
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

export function CriativosPage() {
  const [status, setStatus] = useState<CriativosStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState<Aba>('gerar');
  const [jobSelecionado, setJobSelecionado] = useState<string | null>(null);
  // Dados copiados de um criativo pronto; o Gerar preenche o formulário com eles.
  const [copia, setCopia] = useState<CopiaDados | null>(null);
  const navigate = useNavigate();

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
  }, []);

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

  const abas: { value: Aba; label: string }[] = [
    { value: 'gerar', label: 'Gerar' },
    { value: 'lotes', label: 'Lotes' },
    { value: 'historico', label: 'Histórico' },
    { value: 'produtos', label: 'Produtos' },
    { value: 'marca', label: 'Marca e nicho' },
    { value: 'contextos', label: 'Contextos' },
    { value: 'personas', label: 'Personas' },
  ];

  return (
    <PageStack>
      <PageHeader
        title="Gerador de Criativos"
        description="Ângulos Limpos, Remarketing e Funil por Criativo — com um produto ou multipeça."
        meta={status.core.versions ? <StatusBadge tone="neutral" label={`core ${String(status.core.versions.core_version)}`} /> : undefined}
      />
      {avisos}
      {habilitado && (
        <>
          <TabList label="Seções do gerador" value={aba} onChange={setAba} items={abas} />
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
