import { useEffect, useState } from 'react';
import {
  Button, Callout, DataTable, Disclosure, EmptyState, ErrorState, Input, KpiCard, KpiStrip,
  PageHeader, PageStack, Select, Skeleton, StatusBadge, type Column,
} from '../../components/ds';
import { plural } from '../../lib/format';
import {
  CONFIANCA_ROTULO, CONFIANCA_TOM, formatMoeda, formatPrecoUnitario, getCustosApi, getPrecosApi,
  restaurarPrecoApi, salvarPrecoApi,
  type CustosApiData, type LinhaCusto, type PrecoApi, type TotalCusto,
} from '../../api/custosApi';

import '../../pedidos-central.css';

const PERIODOS = [
  { dias: 7, label: 'Últimos 7 dias' },
  { dias: 30, label: 'Últimos 30 dias' },
  { dias: 90, label: 'Últimos 90 dias' },
];

// Um total pode ser exibido? Só quando não mistura moedas — somar USD com BRL dá um número que não
// significa nada, e exibi-lo seria pior do que não exibir.
function valorDoTotal(t: TotalCusto): string {
  if (t.moedasMisturadas) return '—';
  return formatMoeda(t.total, t.moeda);
}

function ajudaDoTotal(t: TotalCusto, sufixo: string): string {
  if (t.moedasMisturadas) return 'Moedas diferentes — veja a quebra abaixo';
  return sufixo;
}

// Custos de API (WhatsApp + geração de criativos). O ponto desta tela não é o total: é o total COM
// a margem de erro à vista. Preço de API muda sem aviso, a Meta não publica a tabela em BRL, e a
// variante de modelo que a OpenAI usa não é conhecida pelo painel — então um número aqui que se
// apresentasse como exato induziria o cliente a planejar gasto errado.
export function CustosApiPage() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState<CustosApiData | null>(null);
  const [erro, setErro] = useState('');
  const [precos, setPrecos] = useState<PrecoApi[] | null>(null);
  const [erroPreco, setErroPreco] = useState('');
  const [editando, setEditando] = useState<Record<string, { valor: string; moeda: string }>>({});
  const [salvando, setSalvando] = useState('');

  function carregar() {
    setErro('');
    setDados(null);
    getCustosApi(dias)
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [dias]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getPrecosApi()
      .then((r) => setPrecos(r.precos))
      .catch((err: Error) => setErroPreco(err.message));
  }, []);

  function salvarPreco(p: PrecoApi) {
    const rascunho = editando[p.chave];
    if (!rascunho) return;
    const valor = Number(rascunho.valor);
    if (!Number.isFinite(valor) || valor < 0) {
      setErroPreco('Informe um valor maior ou igual a zero.');
      return;
    }
    setSalvando(p.chave);
    setErroPreco('');
    salvarPrecoApi(p.chave, valor, rascunho.moeda)
      .then((r) => {
        setPrecos(r.precos);
        setEditando((e) => { const { [p.chave]: _, ...resto } = e; return resto; });
        carregar();
      })
      .catch((err: Error) => setErroPreco(err.message))
      .finally(() => setSalvando(''));
  }

  function restaurar(p: PrecoApi) {
    setSalvando(p.chave);
    restaurarPrecoApi(p.chave)
      .then((r) => { setPrecos(r.precos); carregar(); })
      .catch((err: Error) => setErroPreco(err.message))
      .finally(() => setSalvando(''));
  }

  const colunasCusto: Column<LinhaCusto>[] = [
    { key: 'rotulo', label: 'Origem', render: (l) => l.rotulo },
    {
      key: 'quantidade', label: 'Volume', align: 'right', muted: true,
      render: (l) => (l.quantidade != null ? l.quantidade.toLocaleString('pt-BR') : '—'),
    },
    {
      key: 'confianca', label: 'Confiança',
      render: (l) => <StatusBadge tone={CONFIANCA_TOM[l.confianca]} label={CONFIANCA_ROTULO[l.confianca]} />,
    },
    {
      key: 'total', label: 'Custo', align: 'right', firstSortDirection: 'desc',
      sortValue: (l) => l.total,
      render: (l) => formatMoeda(l.total, l.moeda),
    },
  ];

  const colunasPreco: Column<PrecoApi>[] = [
    {
      key: 'rotulo', label: 'Item',
      render: (p) => (
        <span>
          {p.rotulo}
          {p.nota && <span className="pc-nota"> — {p.nota}</span>}
        </span>
      ),
    },
    {
      key: 'confianca', label: 'Confiança',
      render: (p) => <StatusBadge tone={CONFIANCA_TOM[p.confianca]} label={CONFIANCA_ROTULO[p.confianca]} />,
    },
    {
      key: 'fonte', label: 'Fonte', muted: true, priority: 'low',
      render: (p) => p.fonte,
    },
    {
      key: 'valor', label: 'Preço', align: 'right',
      render: (p) => {
        const rascunho = editando[p.chave];
        if (!rascunho) {
          return (
            <span className="ga-linha__acao">
              <span>{formatPrecoUnitario(p)}</span>
              <Button
                variant="ghost" size="sm"
                onClick={() => setEditando((e) => ({ ...e, [p.chave]: { valor: String(p.valor), moeda: p.moeda } }))}
              >
                Editar
              </Button>
              {p.editado && (
                <Button variant="ghost" size="sm" disabled={salvando === p.chave} onClick={() => restaurar(p)}>
                  Restaurar
                </Button>
              )}
            </span>
          );
        }
        return (
          <span className="ga-linha__acao">
            <Input
              type="number" min="0" step="0.0001" aria-label={`Preço de ${p.rotulo}`}
              value={rascunho.valor}
              onChange={(e) => setEditando((s) => ({ ...s, [p.chave]: { ...rascunho, valor: e.target.value } }))}
            />
            <Select
              aria-label="Moeda" value={rascunho.moeda}
              onChange={(e) => setEditando((s) => ({ ...s, [p.chave]: { ...rascunho, moeda: e.target.value } }))}
            >
              <option value="USD">USD</option>
              <option value="BRL">BRL</option>
            </Select>
            <Button size="sm" disabled={salvando === p.chave} onClick={() => salvarPreco(p)}>
              {salvando === p.chave ? 'Salvando…' : 'Salvar'}
            </Button>
            <Button
              variant="ghost" size="sm"
              onClick={() => setEditando((e) => { const { [p.chave]: _, ...resto } = e; return resto; })}
            >
              Cancelar
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <PageStack>
      <PageHeader
        title="Custos de API"
        description="O que a operação gasta em mensagens de WhatsApp e em geração de criativos — separado da mídia."
        actions={
          <Select
            aria-label="Período" value={String(dias)}
            onChange={(e) => setDias(Number(e.target.value))}
          >
            {PERIODOS.map((p) => <option key={p.dias} value={p.dias}>{p.label}</option>)}
          </Select>
        }
      />

      {/* Primeiro aviso da tela, e não uma nota de rodapé: quem lê o total precisa saber, ANTES de
          lê-lo, que ele é aproximado. Um número exibido sem ressalva vira base de decisão. */}
      <Callout tone="warning" title="Estes valores são aproximados">
        Preço de API muda sem aviso e varia por país, por volume e por acordo comercial. A Meta{' '}
        <strong>não publica a tabela em reais</strong> — remete a tabelas por moeda, e as fontes
        públicas divergem entre si. A OpenAI publica em dólar, e é assim que os valores aparecem aqui.
        Onde não há preço oficial aplicável, a linha vem marcada como <strong>Estimativa</strong>.
        {' '}Confira na sua fatura e corrija os preços na tabela abaixo — pode digitar em reais se
        preferir. Nada é convertido por câmbio: o câmbio de hoje não é o que a sua fatura usou.
      </Callout>

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton variant="table" rows={4} />}

      {!erro && dados && (
        <>
          <KpiStrip label="Custo no período">
            <KpiCard
              title="Total de APIs"
              value={valorDoTotal(dados.geral)}
              helper={ajudaDoTotal(dados.geral, CONFIANCA_ROTULO[dados.geral.confianca])}
            />
            <KpiCard
              title="WhatsApp"
              value={valorDoTotal(dados.whatsapp)}
              helper={
                dados.provider === 'whatsapp_web'
                  ? 'Enviando pelo celular — a Meta não cobra'
                  : ajudaDoTotal(dados.whatsapp, 'Cobrado por mensagem entregue')
              }
            />
            <KpiCard
              title="Criativos"
              value={valorDoTotal(dados.criativos)}
              helper={ajudaDoTotal(dados.criativos, 'Cobrado por token pela OpenAI')}
            />
          </KpiStrip>

          {/* Mensagens que saem do celular não custam nada à Meta, mas existem — omiti-las faria
              parecer que o painel não está enviando. */}
          {dados.whatsapp.semCustoDeApi > 0 && (
            <Callout tone="info" title="Mensagens enviadas pelo celular">
              {plural(dados.whatsapp.semCustoDeApi, 'mensagem saiu', 'mensagens saíram')} pelo WhatsApp
              do próprio aparelho no período. A Meta não cobra por elas — entram no volume, não no custo.
            </Callout>
          )}

          {dados.geral.naoMedido > 0 && (
            <Callout tone="warning" title="Parte do período não pôde ser medida">
              {plural(dados.geral.naoMedido, 'envio ou geração ficou', 'envios ou gerações ficaram')} sem
              medição de consumo, então <strong>não estão no total acima</strong>. O gasto real do
              período é maior que o exibido. Isso acontece com o que foi enviado antes desta medição
              existir, ou quando o provedor não informou o consumo.
            </Callout>
          )}

          {dados.geral.linhas.length === 0 ? (
            <EmptyState
              title="Nenhum custo de API no período"
              description="Não houve envio cobrado pela Meta nem geração de criativo medida nesta janela."
            />
          ) : (
            <DataTable
              label="Custo por origem"
              rows={dados.geral.linhas}
              rowKey={(l) => l.rotulo}
              columns={colunasCusto}
              defaultSort={{ key: 'total', direction: 'desc' }}
            />
          )}

          {dados.geral.linhas.some((l) => l.entradaNaoDetalhada) && (
            <p className="pc-nota">
              Em parte das gerações o provedor não separou tokens de texto e de imagem. Nesses casos o
              painel cobra tudo pelo preço mais caro — prefere errar para cima, porque custo
              subestimado faz planejar gasto que não cabe.
            </p>
          )}
        </>
      )}

      <Disclosure summary="Tabela de preços usada no cálculo">
        <p className="pc-nota">
          Valores conferidos em {dados?.conferidoEm || '—'}. Edite qualquer linha com o preço da sua
          fatura: ela passa a valer como <strong>Confirmado por você</strong> e deixa de ser
          estimativa no total.
        </p>
        {erroPreco && <p className="ds-form-error" role="alert">{erroPreco}</p>}
        {!precos && !erroPreco && <Skeleton variant="table" rows={4} />}
        {precos && (
          <DataTable
            label="Preços das APIs"
            rows={precos}
            rowKey={(p) => p.chave}
            columns={colunasPreco}
          />
        )}
      </Disclosure>
    </PageStack>
  );
}
