import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, KpiCard,
  KpiStrip, PageHeader, ProgressBar, Skeleton, StatusBadge, TabList, Tabs, Modal,
} from '../../components/ds';
import { useLojaAtiva } from '../../auth/AuthContext';
import { listCategorias, createCategoria, type Categoria } from '../../api/categorias';
import { getInternalToolsStatus } from '../../api/internalTools';
import {
  getCategoryJob, cancelCategoryJob, retryFailedCategoryJob, debugTestarItem, falhasPorTipo,
  type BulkCategoryJob, type FalhaJobItem, type DebugTestarItemResultado, type FalhaPorTipo,
} from '../../api/categoryAssignments';
import {
  listMigrationRules, createMigrationRule, updateMigrationRule, deleteMigrationRule,
  simularMigracao, getMigrationSimulation, reavaliarConflitosSimulacao, listMigrationSimulations, listMigrationSimulationItems, overrideMigrationItem, executarMigracao, exportMigrationCsvUrl,
  getMigrationRuleCounts,
  presetPreviewRules, presetEspeciaisPreviewRules, presetCreateRules,
  listCityUfMap, createCityUfEntry, updateCityUfEntry, deleteCityUfEntry, bulkPreviewCityUfMap, bulkCreateCityUfMap, discoverCities,
  importarDicionarioMunicipios,
  listarCategoriasAntigas, excluirCategoriasAntigas,
  type MigrationRule, type CondicaoRegra, type OperadorRegra, type FonteCondicaoRegra, type MigrationSimulation, type MigrationSimulationItem, type ContagemPorRegra,
  type PresetRuleItem, type PresetEspecialItem, type CityUfEntry, type CityUfBulkPreviewItem, type DiscoveredCity, type CategoriaAntiga,
} from '../../api/origensMigration';

import '../../pedidos-central.css';
import '../../categorias.css';

// "Migração Use Origens" (docs/claude-categorias-lote-migracao-use-origens.md, Partes 4-7).
// Ferramenta interna — o backend é quem de fato bloqueia (requireInternalTools/404), esta
// página só existe pra quem já sabe que a flag está ligada (ver AppShell/nav condicional).
const OPERADORES: { value: OperadorRegra; label: string }[] = [
  { value: 'contains', label: 'contém' },
  { value: 'not_contains', label: 'não contém' },
  { value: 'starts_with', label: 'começa com' },
  { value: 'ends_with', label: 'termina com' },
  { value: 'equals', label: 'é igual a' },
];

// Grupo A (cidade) usa "Nome do produto"; Grupo B (coleções especiais, doc:
// claude-migracao-final-categorias-snapshot-especiais.md) usa "Categoria atual" — o produto pode
// estar em várias categorias ao mesmo tempo, basta 1 bater (exceto "não contém", que exige nenhuma
// bater — ver condicaoBate no backend).
const FONTES_CONDICAO: { value: FonteCondicaoRegra; label: string }[] = [
  { value: 'product_name', label: 'Nome do produto' },
  { value: 'current_category', label: 'Categoria atual' },
];
const FONTE_CONDICAO_LABEL: Record<FonteCondicaoRegra, string> = { product_name: 'Nome', current_category: 'Categoria atual' };

const ITEM_STATUS_TABS: { value: string; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'pronto', label: 'Prontos' },
  { value: 'sem_regra', label: 'Sem regra' },
  { value: 'conflito', label: 'Conflitos' },
];

const JOB_STATUS_MAP: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  queued: { label: 'Na fila', tone: 'info' },
  running: { label: 'Processando', tone: 'warning' },
  completed: { label: 'Concluído', tone: 'success' },
  completed_with_errors: { label: 'Concluído com falhas', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
};
const JOB_EM_ANDAMENTO = new Set(['queued', 'running']);

function vazioCondicao(): CondicaoRegra {
  return { field: 'product_name', operator: 'contains', value: '' };
}

const PRESET_STATUS_LABEL: Record<PresetRuleItem['status'], { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  pronta: { label: 'Pronta', tone: 'success' },
  ja_existe: { label: 'Já existe', tone: 'neutral' },
  atualizar_categoria: { label: 'Será atualizada', tone: 'warning' },
  categoria_ausente: { label: 'Categoria ausente', tone: 'warning' },
  sem_categoria_origem: { label: 'Não se aplica nesta loja', tone: 'neutral' },
};

// Item de qualquer um dos 2 presets — o que muda é só o rótulo da combinação (colecao/uf do
// Grupo A, origem/destino do Grupo B), o resto (resolução/idempotência/status) é idêntico.
type PresetItemQualquer = (PresetRuleItem | PresetEspecialItem) & { colecao?: string; uf?: string; origem?: string; destino?: string };

// Pré-carga de regras (Grupo A "regras padrão" de cidade, doc claude-preload-regras-use-origens-
// cidade-uf.md; Grupo B "regras especiais" de coleção antiga, doc
// claude-migracao-final-categorias-snapshot-especiais.md) — preview primeiro (nunca cria nada
// sozinho), permite resolver manualmente categoria ambígua/ausente via select antes de habilitar
// "Criar N regras". Mesmo componente pros 2 grupos — só o título/busca/rótulo de combinação muda.
function PresetModal({ loja, categorias, open, onClose, onCriado, titulo, variante, buscarPreview, resumoTextoBase }: {
  loja: string; categorias: Categoria[] | null; open: boolean; onClose: () => void; onCriado: () => void;
  titulo: string; variante: 'cidade' | 'especial';
  buscarPreview: (loja: string) => Promise<{ itens: PresetItemQualquer[] }>;
  resumoTextoBase: string;
}) {
  const [itens, setItens] = useState<PresetItemQualquer[] | null>(null);
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);
  const [resultado, setResultado] = useState<{ criadas: number; jaExistiam: number; atualizadas: number; falharam: { nome: string; erro: string }[] } | null>(null);

  // Categoria faltante criada ali mesmo (pedido do usuário, 2026-09-09): recarrega o preview
  // INTEIRO depois de criar — mais simples e seguro do que tentar remendar só a linha/slot que
  // motivou a criação, já que a mesma categoria costuma ser reaproveitada por várias regras (ex:
  // "SUL" entra nas 24, "Seu Lugar" em 21). Custo aceito: qualquer correção manual ainda não
  // enviada (corrigirCategoria) se perde nesse refresh.
  const [criarCategoriaAlvo, setCriarCategoriaAlvo] = useState<string | null>(null);
  const [nomeCategoriaNova, setNomeCategoriaNova] = useState('');
  const [criandoCategoria, setCriandoCategoria] = useState(false);
  const [erroCategoriaNova, setErroCategoriaNova] = useState('');

  const carregarPreview = useCallback(() => {
    setErro('');
    return buscarPreview(loja).then((d) => setItens(d.itens)).catch((err: Error) => setErro(err.message));
  }, [loja, buscarPreview]);

  useEffect(() => {
    if (!open) { setItens(null); setErro(''); setResultado(null); return; }
    carregarPreview();
  }, [open, loja, carregarPreview]);

  function abrirCriarCategoria(nomeAlvo: string) {
    setCriarCategoriaAlvo(nomeAlvo);
    setNomeCategoriaNova(nomeAlvo.slice(0, 20));
    setErroCategoriaNova('');
  }

  async function confirmarCriarCategoria() {
    const nome = nomeCategoriaNova.trim();
    if (!nome) { setErroCategoriaNova('informe o nome'); return; }
    if (nome.length > 20) { setErroCategoriaNova('máximo de 20 caracteres (limite da Ink)'); return; }
    setCriandoCategoria(true);
    setErroCategoriaNova('');
    try {
      await createCategoria({ name: nome, isAvailable: false });
      setCriarCategoriaAlvo(null);
      await carregarPreview();
    } catch (err) {
      setErroCategoriaNova((err as Error).message);
    } finally {
      setCriandoCategoria(false);
    }
  }

  function corrigirCategoria(index: number, nomeAlvo: string, categoriaId: number) {
    setItens((atual) => {
      if (!atual) return atual;
      const copia = atual.map((it, i) => (i === index ? { ...it } : it));
      const item = copia[index];
      const posicao = item.categoriasNomes.indexOf(nomeAlvo);
      if (posicao === -1) return atual;
      // Base sempre a resolução por posição (preserva as que já resolveram sozinhas), nunca
      // categoriaIdsSaida (some inteiro quando só 1 categoria falta).
      const idsAtuais = [...item.categoriaIdsPorPosicao];
      idsAtuais[posicao] = categoriaId;
      item.categoriaIdsPorPosicao = idsAtuais;
      const todasResolvidas = idsAtuais.every((v) => v != null);
      item.categoriaIdsSaida = todasResolvidas ? (idsAtuais as number[]) : null;
      item.status = todasResolvidas ? 'pronta' : 'categoria_ausente';
      return copia;
    });
  }

  async function confirmar() {
    if (!itens) return;
    // "atualizar_categoria" também precisa ir pro backend — é a mesma regra de antes, só faltando
    // a categoria nova (ex: Seu Lugar/Fala Daqui); o preset-create decide UPDATE vs INSERT sozinho.
    const paraCriar = itens.filter((i) => i.status === 'pronta' || i.status === 'atualizar_categoria');
    if (!paraCriar.length) return;
    setCriando(true); setErro('');
    try {
      const r = await presetCreateRules(paraCriar);
      setResultado(r);
      onCriado();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setCriando(false);
    }
  }

  const prontas = itens?.filter((i) => i.status === 'pronta').length ?? 0;
  const jaExiste = itens?.filter((i) => i.status === 'ja_existe').length ?? 0;
  const atualizarCategoria = itens?.filter((i) => i.status === 'atualizar_categoria').length ?? 0;
  const categoriaAusente = itens?.filter((i) => i.status === 'categoria_ausente').length ?? 0;
  const semCategoriaOrigem = itens?.filter((i) => i.status === 'sem_categoria_origem').length ?? 0;
  const aEnviar = prontas + atualizarCategoria;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titulo}
      confirmLabel={resultado ? 'Fechar' : (criando ? 'Criando…' : `Criar/atualizar ${aEnviar} regra(s)`)}
      confirmDisabled={criando || (!resultado && aEnviar === 0)}
      onConfirm={resultado ? onClose : confirmar}
      maxWidth={960}
    >
      {erro && <ErrorState description={erro} />}
      {!erro && !itens && !resultado && <Skeleton rows={6} />}

      {resultado && (
        <p>
          <strong>{resultado.criadas}</strong> regra(s) criada(s), <strong>{resultado.atualizadas}</strong> atualizada(s) (só a categoria que faltava), <strong>{resultado.jaExistiam}</strong> já existiam.
          {resultado.falharam.length > 0 && <> {resultado.falharam.length} falharam: {resultado.falharam.map((f) => `${f.nome} (${f.erro})`).join('; ')}</>}
        </p>
      )}

      {!resultado && itens && (
        <>
          <p>
            {resumoTextoBase} — <strong>{prontas}</strong> prontas, <strong>{atualizarCategoria}</strong> serão atualizadas, <strong>{jaExiste}</strong> já existem, <strong>{categoriaAusente}</strong> com categoria ausente
            {variante === 'especial' && <>, <strong>{semCategoriaOrigem}</strong> não se aplicam nesta loja</>}.
          </p>
          <DataTable
            rows={itens}
            rowKey={(i) => i.nome}
            columns={[
              { key: 'regra', label: 'Regra', render: (i) => i.nome },
              ...(variante === 'cidade'
                ? [
                    { key: 'colecao', label: 'Coleção', render: (i: PresetItemQualquer) => i.colecao },
                    { key: 'uf', label: 'UF', render: (i: PresetItemQualquer) => i.uf },
                  ]
                : [
                    { key: 'origem', label: 'Categoria de origem', render: (i: PresetItemQualquer) => i.origem },
                    { key: 'destino', label: 'Categoria de destino', render: (i: PresetItemQualquer) => i.destino },
                  ]),
              {
                key: 'categorias', label: 'Categorias de saída',
                render: (i) => {
                  if (i.status === 'sem_categoria_origem') {
                    return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>categoria de origem não existe nesta loja</span>;
                  }
                  return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {i.categoriasNomes.map((nomeAlvo, posicao) => {
                      // Resolução INDIVIDUAL por posição — nunca usar categoriaIdsSaida aqui (é
                      // tudo-ou-nada: fica null se só 1 das 5 não resolver, o que fazia as outras
                      // 4 já resolvidas aparecerem como "ausente" também).
                      const idResolvido = i.categoriaIdsPorPosicao[posicao];
                      if (idResolvido != null) {
                        return <span key={nomeAlvo} style={{ fontSize: 12 }}>{categorias?.find((c) => c.id === idResolvido)?.name || nomeAlvo}</span>;
                      }
                      const ambiguo = i.candidatosAmbiguos.find((c) => c.nome === nomeAlvo);
                      return (
                        <select key={nomeAlvo} className="ds-select" style={{ fontSize: 12 }} defaultValue=""
                          onChange={(e) => {
                            if (e.target.value === '__criar__') { abrirCriarCategoria(nomeAlvo); return; }
                            if (e.target.value) corrigirCategoria(itens ? itens.indexOf(i) : -1, nomeAlvo, Number(e.target.value));
                          }}>
                          <option value="" disabled>ausente: {nomeAlvo}</option>
                          <option value="__criar__">+ Criar categoria "{nomeAlvo}"</option>
                          {(ambiguo?.candidatos.length ? ambiguo.candidatos.map((c) => ({ id: c.id, name: c.nome })) : categorias || []).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      );
                    })}
                  </div>
                  );
                },
              },
              {
                key: 'status', label: 'Status',
                render: (i) => <StatusBadge tone={PRESET_STATUS_LABEL[i.status].tone} label={PRESET_STATUS_LABEL[i.status].label} />,
              },
            ]}
          />
        </>
      )}

      {criarCategoriaAlvo != null && (
        <Modal
          open
          onClose={() => { if (!criandoCategoria) setCriarCategoriaAlvo(null); }}
          title="Criar categoria ausente"
          confirmLabel={criandoCategoria ? 'Criando…' : 'Criar categoria'}
          confirmDisabled={criandoCategoria}
          onConfirm={confirmarCriarCategoria}
        >
          <Field label="Nome" hint={`Nome esperado pelo preset: "${criarCategoriaAlvo}". Máx. 20 caracteres (limite da Ink) — ajuste se precisar.`}>
            <input className="ds-input" value={nomeCategoriaNova} onChange={(e) => setNomeCategoriaNova(e.target.value)} maxLength={20} />
          </Field>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{nomeCategoriaNova.length}/20 · criada como "Não disponível na loja" (categoria interna de migração).</p>
          {erroCategoriaNova && <p className="ds-form-error">{erroCategoriaNova}</p>}
        </Modal>
      )}
    </Modal>
  );
}

function RegrasTab({ loja, categorias }: { loja: string; categorias: Categoria[] | null }) {
  const [regras, setRegras] = useState<MigrationRule[] | null>(null);
  const [erro, setErro] = useState('');
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<MigrationRule | null>(null);

  const [nome, setNome] = useState('');
  const [prioridade, setPrioridade] = useState(0);
  const [dimensao, setDimensao] = useState('');
  const [habilitada, setHabilitada] = useState(true);
  const [condicoes, setCondicoes] = useState<CondicaoRegra[]>([vazioCondicao()]);
  const [categoriaIdsSaida, setCategoriaIdsSaida] = useState<number[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [excluindo, setExcluindo] = useState<MigrationRule | null>(null);
  const [presetAberto, setPresetAberto] = useState(false);
  const [presetEspecialAberto, setPresetEspecialAberto] = useState(false);

  const carregar = useCallback(() => {
    setErro('');
    listMigrationRules().then((d) => setRegras(d.regras)).catch((err: Error) => setErro(err.message));
  }, [loja]);
  useEffect(carregar, [carregar]);

  function abrirNova() {
    setEditando(null);
    setNome(''); setPrioridade(0); setDimensao(''); setHabilitada(true);
    setCondicoes([vazioCondicao()]); setCategoriaIdsSaida([]); setErroForm('');
    setModalAberto(true);
  }
  function abrirEdicao(r: MigrationRule) {
    setEditando(r);
    setNome(r.nome); setPrioridade(r.prioridade); setDimensao(r.dimensao || ''); setHabilitada(r.habilitada);
    setCondicoes(r.condicoes.length ? r.condicoes : [vazioCondicao()]); setCategoriaIdsSaida(r.categoria_ids_saida); setErroForm('');
    setModalAberto(true);
  }

  async function salvar() {
    setErroForm('');
    if (!nome.trim()) return setErroForm('nome é obrigatório');
    if (!categoriaIdsSaida.length) return setErroForm('escolha ao menos 1 categoria de saída');
    const condicoesValidas = condicoes.filter((c) => c.value.trim());
    if (!condicoesValidas.length) return setErroForm('adicione ao menos 1 condição com valor preenchido');
    setSalvando(true);
    try {
      const input = { nome: nome.trim(), prioridade, dimensao: dimensao || null, habilitada, condicoes: condicoesValidas, categoriaIdsSaida };
      if (editando) await updateMigrationRule(editando.id, input);
      else await createMigrationRule(input);
      setModalAberto(false);
      carregar();
    } catch (err) {
      setErroForm((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await deleteMigrationRule(excluindo.id);
    carregar();
  }

  function nomeCategoria(id: number): string {
    return categorias?.find((c) => c.id === id)?.name || `#${id}`;
  }

  return (
    <div>
      <div className="ds-button-row" style={{ marginBottom: 16 }}>
        <Button onClick={abrirNova}>Nova regra</Button>
        <Button variant="secondary" onClick={() => setPresetAberto(true)}>Pré-carregar regras padrão</Button>
        <Button variant="secondary" onClick={() => setPresetEspecialAberto(true)}>Pré-carregar regras especiais</Button>
      </div>
      {erro && <ErrorState description={erro} />}
      {!erro && !regras && <Skeleton rows={4} />}
      {!erro && regras && regras.length === 0 && (
        <EmptyState title="Nenhuma regra ainda" description="Crie regras pra classificar produtos automaticamente pelo nome." />
      )}
      {!erro && regras && regras.length > 0 && (
        <DataTable
          rows={regras}
          rowKey={(r) => r.id}
          onRowClick={abrirEdicao}
          columns={[
            { key: 'nome', label: 'Nome', render: (r) => r.nome },
            { key: 'dimensao', label: 'Dimensão', render: (r) => r.dimensao || '—' },
            { key: 'prioridade', label: 'Prioridade', render: (r) => String(r.prioridade) },
            {
              key: 'condicoes', label: 'Condições',
              render: (r) => r.condicoes.map((c) => `${FONTE_CONDICAO_LABEL[c.field] || c.field} ${OPERADORES.find((o) => o.value === c.operator)?.label} "${c.value}"`).join(' E '),
            },
            { key: 'saida', label: 'Categorias de saída', render: (r) => r.categoria_ids_saida.map(nomeCategoria).join(', ') },
            {
              key: 'status', label: 'Status',
              render: (r) => <StatusBadge tone={r.habilitada ? 'success' : 'neutral'} label={r.habilitada ? 'Habilitada' : 'Desabilitada'} />,
            },
            {
              key: 'acoes', label: '',
              render: (r) => (
                <Button variant="secondary" onClick={(e) => { e.stopPropagation(); setExcluindo(r); }}>
                  Excluir
                </Button>
              ),
            },
          ]}
        />
      )}

      <Modal
        open={modalAberto}
        onClose={() => setModalAberto(false)}
        title={editando ? 'Editar regra' : 'Nova regra'}
        confirmLabel={salvando ? 'Salvando…' : 'Salvar'}
        confirmDisabled={salvando}
        onConfirm={salvar}
      >
        <Field label="Nome"><input className="ds-input" value={nome} onChange={(e) => setNome(e.target.value)} /></Field>
        <Field label="Dimensão (opcional — regras da mesma dimensão em conflito geram produto em conflito)">
          <input className="ds-input" placeholder="ex: colecao, uf, regiao" value={dimensao} onChange={(e) => setDimensao(e.target.value)} />
        </Field>
        <Field label="Prioridade"><input type="number" className="ds-input" value={prioridade} onChange={(e) => setPrioridade(Number(e.target.value) || 0)} /></Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <input type="checkbox" checked={habilitada} onChange={(e) => setHabilitada(e.target.checked)} /> Habilitada
        </label>

        <Field label="Condições (todas precisam bater — escolha nome do produto ou categoria atual por condição)">
          {condicoes.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <select className="ds-select" value={c.field} onChange={(e) => setCondicoes((atual) => atual.map((x, idx) => idx === i ? { ...x, field: e.target.value as FonteCondicaoRegra } : x))}>
                {FONTES_CONDICAO.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <select className="ds-select" value={c.operator} onChange={(e) => setCondicoes((atual) => atual.map((x, idx) => idx === i ? { ...x, operator: e.target.value as OperadorRegra } : x))}>
                {OPERADORES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <input className="ds-input" placeholder="valor" value={c.value} onChange={(e) => setCondicoes((atual) => atual.map((x, idx) => idx === i ? { ...x, value: e.target.value } : x))} />
              <Button variant="secondary" onClick={() => setCondicoes((atual) => atual.filter((_, idx) => idx !== i))}>Remover</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setCondicoes((atual) => [...atual, vazioCondicao()])}>+ Adicionar condição</Button>
        </Field>

        <Field label="Categorias de saída (união com outras regras que baterem)">
          {!categorias && <Skeleton rows={2} />}
          {categorias && categorias.map((c) => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
              <input
                type="checkbox" checked={categoriaIdsSaida.includes(c.id)}
                onChange={() => setCategoriaIdsSaida((atual) => atual.includes(c.id) ? atual.filter((x) => x !== c.id) : [...atual, c.id])}
              />
              {c.name}
            </label>
          ))}
        </Field>

        {erroForm && <ErrorState description={erroForm} />}
      </Modal>

      <ConfirmDialog
        open={excluindo != null}
        onClose={() => setExcluindo(null)}
        title="Excluir regra"
        description={excluindo ? `Excluir a regra "${excluindo.nome}"? Isso não altera produtos já classificados anteriormente.` : ''}
        onConfirm={confirmarExclusao}
      />

      <PresetModal
        loja={loja} categorias={categorias} open={presetAberto}
        onClose={() => setPresetAberto(false)}
        onCriado={carregar}
        titulo="Pré-carregar regras padrão — Use Origens (Sul)"
        variante="cidade"
        buscarPreview={presetPreviewRules}
        resumoTextoBase="8 coleções × 3 UFs (RS, SC, PR) = 24 regras"
      />

      <PresetModal
        loja={loja} categorias={categorias} open={presetEspecialAberto}
        onClose={() => setPresetEspecialAberto(false)}
        onCriado={carregar}
        titulo="Pré-carregar regras especiais — coleções antigas"
        variante="especial"
        buscarPreview={presetEspeciaisPreviewRules}
        resumoTextoBase="9 mapeamentos de coleção antiga → categoria pública"
      />
    </div>
  );
}

// simulationIdAtiva mora no componente PAI (OrigensMigrationPage), não aqui — uma simulação
// grande pode levar minutos (visto na prática: 20min pra ~85 mil produtos) e o usuário precisa
// poder trocar de aba (ex: ver o Histórico) sem perder o acompanhamento. O <Tabs> desmonta a aba
// inativa, então qualquer estado local daqui (useState) seria perdido ao trocar de aba — subir o
// ID pro pai (que não desmonta) resolve isso; ao remontar, os efeitos abaixo recarregam status/
// itens a partir do ID recebido, como se nunca tivesse saído do ar.
function SimulacaoTab({ categorias, simulationIdAtiva, setSimulationIdAtiva, jobIdAtivo, setJobIdAtivo }: {
  categorias: Categoria[] | null;
  simulationIdAtiva: number | null; setSimulationIdAtiva: (id: number | null) => void;
  jobIdAtivo: number | null; setJobIdAtivo: (id: number | null) => void;
}) {
  const [simulando, setSimulando] = useState(false);
  const [erro, setErro] = useState('');
  const [simulacao, setSimulacao] = useState<MigrationSimulation | null>(null);
  const [reavaliando, setReavaliando] = useState(false);
  const [resultadoReavaliacao, setResultadoReavaliacao] = useState<{ reavaliados: number; resolvidos: number; aindaPendente: number } | null>(null);

  const [statusFiltro, setStatusFiltro] = useState('todos');
  const [page, setPage] = useState(1);
  const [itens, setItens] = useState<{ itens: MigrationSimulationItem[]; total: number; pageSize: number } | null>(null);

  const [confirmandoExecucao, setConfirmandoExecucao] = useState(false);
  // Escopo da execução (pedido do usuário, 2026-09-11): 'todos' é o comportamento de sempre —
  // catálogo inteiro, incluindo tudo que o FALLBACK cidade→UF classificou, que é o que faz uma
  // execução normal mexer em dezenas de milhares de produtos. 'regras' executa só o que bateu em
  // regra explícita, opcionalmente só nas regras marcadas: é o recorte pra aplicar um punhado de
  // regras novas sem reclassificar o catálogo.
  const [escopo, setEscopo] = useState<'todos' | 'regras'>('todos');
  const [regrasSelecionadas, setRegrasSelecionadas] = useState<Set<number>>(new Set());
  const [contagens, setContagens] = useState<{ regras: ContagemPorRegra[]; totalPorRegra: number; totalPorFallback: number } | null>(null);
  // jobId/jobEstado vêm da URL (via props), não de useState local — mesmo motivo do
  // simulationIdAtiva: uma execução real longa não pode se perder ao trocar de aba.
  const jobId = jobIdAtivo;
  const [jobEstado, setJobEstado] = useState<{ job: BulkCategoryJob; falhas: FalhaJobItem[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Debug (pedido do usuário, 2026-09-09): testar 1 item isolado, com a request/response reais
  // da Ink na tela — nem sempre dá pra olhar o log do Railway na hora.
  const [debugItemId, setDebugItemId] = useState<number | null>(null);
  const [debugResultado, setDebugResultado] = useState<DebugTestarItemResultado | null>(null);
  const [debugErro, setDebugErro] = useState('');
  async function testarItemDebug(itemId: number) {
    setDebugItemId(itemId); setDebugResultado(null); setDebugErro('');
    try {
      const r = await debugTestarItem(itemId);
      setDebugResultado(r);
      carregarJob();
    } catch (err) {
      setDebugErro((err as Error).message);
    }
  }

  // Diagnóstico (pedido do usuário, 2026-09-09): comparando 2 produtos via Debug (um que passou,
  // um que não passou), a diferença visível era o product_type — pode ser coincidência de 2
  // amostras. Este relatório busca o tipo de TODAS as falhas atuais do job pra confirmar/descartar
  // com dado real.
  const [tiposCarregando, setTiposCarregando] = useState(false);
  const [tiposResultado, setTiposResultado] = useState<{ totalAnalisado: number; semTipo: number; tipos: FalhaPorTipo[] } | null>(null);
  const [tiposErro, setTiposErro] = useState('');
  async function verFalhasPorTipo(jId: number) {
    setTiposCarregando(true); setTiposErro(''); setTiposResultado(null);
    try {
      const r = await falhasPorTipo(jId);
      setTiposResultado(r);
    } catch (err) {
      setTiposErro((err as Error).message);
    } finally {
      setTiposCarregando(false);
    }
  }

  // Simular só cria a simulação e devolve o id — o processamento roda em background, página por
  // página da Ink (loja com muitos produtos não trava mais a tela esperando tudo de uma vez).
  // Acompanhamos via polling de getMigrationSimulation até o status sair de 'processando'.
  async function rodarSimulacao() {
    setSimulando(true); setErro(''); setSimulacao(null);
    try {
      const r = await simularMigracao();
      setSimulationIdAtiva(r.simulationId);
      setStatusFiltro('todos'); setPage(1);
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSimulando(false);
    }
  }

  const carregarSimulacao = useCallback(() => {
    if (!simulationIdAtiva) { setSimulacao(null); return; }
    getMigrationSimulation(simulationIdAtiva).then((r) => setSimulacao(r.simulacao)).catch((err: Error) => setErro(err.message));
  }, [simulationIdAtiva]);
  useEffect(carregarSimulacao, [carregarSimulacao]);
  useEffect(() => {
    if (!simulacao || simulacao.status !== 'processando') {
      if (simPollRef.current) clearInterval(simPollRef.current);
      return;
    }
    simPollRef.current = setInterval(carregarSimulacao, 2000);
    return () => { if (simPollRef.current) clearInterval(simPollRef.current); };
  }, [simulacao, carregarSimulacao]);
  // Bug real reportado pelo usuário, 2026-09-09: "Ver" no Histórico só restaura simulationIdAtiva
  // — uma simulação já executada (status 'executando'/'executada') tem job_id, mas nada
  // sincronizava isso pro jobIdAtivo (URL), então a tela caía no estado "Simular migração" em vez
  // de mostrar o progresso/resultado do job em andamento/concluído.
  useEffect(() => {
    if (simulacao?.job_id != null && jobIdAtivo !== simulacao.job_id) setJobIdAtivo(simulacao.job_id);
  }, [simulacao?.job_id, jobIdAtivo, setJobIdAtivo]);

  const carregarItens = useCallback(() => {
    if (!simulationIdAtiva || simulacao?.status !== 'simulada') { setItens(null); return; }
    listMigrationSimulationItems(simulationIdAtiva, statusFiltro, page).then(setItens).catch((err: Error) => setErro(err.message));
  }, [simulationIdAtiva, simulacao?.status, statusFiltro, page]);
  useEffect(carregarItens, [carregarItens]);

  // Contagem de produtos por regra: alimenta o seletor de escopo e já denuncia regra que não pegou
  // nada. Vem marcada só quem tem produto, pra o padrão do escopo por regra ser útil de cara.
  useEffect(() => {
    if (!simulationIdAtiva || simulacao?.status !== 'simulada') { setContagens(null); return; }
    getMigrationRuleCounts(simulationIdAtiva)
      .then((r) => {
        setContagens(r);
        setRegrasSelecionadas(new Set(r.regras.filter((x) => x.total > 0).map((x) => x.id)));
      })
      .catch(() => setContagens(null));
  }, [simulationIdAtiva, simulacao?.status]);

  // Reclassifica só quem ficou sem_regra/conflito (ex: depois de importar o dicionário de
  // cidades) sem rodar uma simulação nova do zero — pedido do usuário, 2026-09-10.
  async function reavaliarConflitos() {
    if (!simulationIdAtiva) return;
    setReavaliando(true); setResultadoReavaliacao(null); setErro('');
    try {
      const r = await reavaliarConflitosSimulacao(simulationIdAtiva);
      setResultadoReavaliacao(r);
      carregarSimulacao();
      carregarItens();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setReavaliando(false);
    }
  }

  function nomeCategorias(ids: number[]): string {
    return ids.map((id) => categorias?.find((c) => c.id === id)?.name || `#${id}`).join(', ') || '—';
  }

  async function alternarIgnorar(item: MigrationSimulationItem) {
    if (!simulationIdAtiva) return;
    await overrideMigrationItem(simulationIdAtiva, item.id, { overrideIgnorar: !item.override_ignorar });
    carregarItens();
  }

  // Soma das regras marcadas: um produto que bate em 2 regras é contado 2x aqui, então isso é um
  // teto ("até N"), não o número exato — o backend deduplica por produto na hora de criar o job.
  const totalNoEscopo = escopo === 'todos'
    ? (simulacao?.total_prontos ?? 0)
    : (contagens?.regras || []).filter((r) => regrasSelecionadas.has(r.id)).reduce((soma, r) => soma + r.total, 0);

  async function confirmarExecucao() {
    if (!simulationIdAtiva) return;
    const r = await executarMigracao(
      simulationIdAtiva,
      escopo === 'regras' ? { escopo: 'regras', regraIds: Array.from(regrasSelecionadas) } : { escopo: 'todos' }
    );
    setJobIdAtivo(r.jobId);
  }

  const carregarJob = useCallback(() => {
    if (!jobId) return;
    getCategoryJob(jobId).then(setJobEstado).catch((err: Error) => setErro(err.message));
  }, [jobId]);
  useEffect(carregarJob, [carregarJob]);
  useEffect(() => {
    if (!jobEstado || !JOB_EM_ANDAMENTO.has(jobEstado.job.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(carregarJob, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobEstado, carregarJob]);

  if (jobId) {
    if (!jobEstado) return <Skeleton rows={5} />;
    const { job, falhas } = jobEstado;
    const meta = JOB_STATUS_MAP[job.status] || { label: job.status, tone: 'neutral' as const };
    const progresso = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
    return (
      <div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <StatusBadge tone={meta.tone} label={meta.label} />
          <span>Executando migração — {job.processed}/{job.total}</span>
        </div>
        {JOB_EM_ANDAMENTO.has(job.status) && (
          <Card>
            <ProgressBar value={progresso} label="Progresso da migração" showValue />
          </Card>
        )}
        <KpiStrip label="Resultado da migração">
          <KpiCard title="Total" value={job.total} />
          <KpiCard title="Sucesso" value={job.succeeded} />
          <KpiCard title="Falha" value={job.failed} />
        </KpiStrip>
        <div className="ds-button-row" style={{ marginBottom: 16 }}>
          {JOB_EM_ANDAMENTO.has(job.status) && (
            <Button variant="secondary" onClick={() => cancelCategoryJob(job.id).then(carregarJob).catch((err: Error) => setErro(err.message))}>Cancelar</Button>
          )}
          {/* Job cancelado com trabalho pendente (itens ainda 'pending', nunca tentados) também
              precisa retomar, não só quando há falha — mesmo endpoint resolve os dois casos. */}
          {!JOB_EM_ANDAMENTO.has(job.status) && (job.failed > 0 || (job.status === 'cancelled' && job.processed < job.total)) && (
            <Button variant="secondary" onClick={() => retryFailedCategoryJob(job.id).then(carregarJob).catch((err: Error) => setErro(err.message))}>
              {job.failed > 0 ? 'Reexecutar falhas' : 'Retomar execução'}
            </Button>
          )}
        </div>
        {falhas.length > 0 && (
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ marginTop: 0 }}>Últimas falhas</h3>
              <Button variant="secondary" onClick={() => verFalhasPorTipo(job.id)} disabled={tiposCarregando}>
                {tiposCarregando ? 'Analisando…' : 'Ver falhas por tipo de produto'}
              </Button>
            </div>
            {tiposErro && <ErrorState description={tiposErro} />}
            {tiposResultado && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {tiposResultado.totalAnalisado} falha(s) analisada(s){tiposResultado.semTipo > 0 && `, ${tiposResultado.semTipo} sem tipo identificado`}.
                </p>
                <DataTable
                  rows={tiposResultado.tipos} rowKey={(t) => t.id}
                  columns={[
                    { key: 'tipo', label: 'Tipo de produto', render: (t) => t.nome },
                    { key: 'qtd', label: 'Quantidade de falhas', render: (t) => t.quantidade },
                  ]}
                />
              </div>
            )}
            <DataTable
              rows={falhas} rowKey={(f) => f.product_id}
              columns={[
                { key: 'produto', label: 'Produto', render: (f) => `#${f.product_id}` },
                { key: 'erro', label: 'Erro', render: (f) => f.error || '—' },
                {
                  key: 'debug', label: '',
                  render: (f) => <Button variant="secondary" onClick={() => testarItemDebug(f.id)}>Debug</Button>,
                },
              ]}
            />
          </Card>
        )}
        {debugItemId != null && (
          <Card>
            <h3 style={{ marginTop: 0 }}>Debug — item #{debugItemId}</h3>
            {debugErro && <ErrorState description={debugErro} />}
            {!debugErro && !debugResultado && <Skeleton rows={3} />}
            {debugResultado && (
              <>
                <StatusBadge tone={debugResultado.success ? 'success' : 'danger'} label={debugResultado.success ? 'Sucesso' : 'Falhou'} />
                {/* Todas as chamadas reais feitas à Ink durante o teste, na ordem exata em que
                    aconteceram (pedido do usuário, 2026-09-09) — substitui os blocos fixos de
                    "request"/"resposta" só do PATCH principal, que agora é só mais 1 item da lista. */}
                {debugResultado.requests.map((chamada, i) => (
                  <div key={i} style={{ marginTop: 16 }}>
                    <p style={{ marginBottom: 4, fontWeight: 600 }}>
                      {i + 1}. {chamada.titulo} — <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{chamada.method} {chamada.path}</span>
                    </p>
                    {chamada.body != null && (
                      <>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>Corpo enviado</p>
                        <pre style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 12 }}>
                          {JSON.stringify(chamada.body, null, 2)}
                        </pre>
                      </>
                    )}
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>Resposta (status {chamada.status ?? '—'})</p>
                    <pre style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 12, maxHeight: 320, overflowY: 'auto' }}>
                      {JSON.stringify(chamada.response, null, 2)}
                    </pre>
                  </div>
                ))}
              </>
            )}
          </Card>
        )}
      </div>
    );
  }

  // Simulação ainda rodando (ou acabou de ser criada e o 1º polling ainda não voltou) — mostra
  // progresso real por página em vez de travar a tela esperando o catálogo inteiro.
  if (simulationIdAtiva && (!simulacao || simulacao.status === 'processando' || simulacao.status === 'falhou')) {
    if (simulacao?.status === 'falhou') {
      return (
        <div>
          <ErrorState title="Falha na simulação" description={simulacao.erro || 'Erro desconhecido ao simular.'} />
          <div className="ds-button-row" style={{ marginTop: 16 }}>
            <Button onClick={() => { setSimulationIdAtiva(null); setSimulacao(null); }}>Tentar de novo</Button>
          </div>
        </div>
      );
    }
    const paginasTotal = simulacao?.paginas_total ?? null;
    const paginasProcessadas = simulacao?.paginas_processadas ?? 0;
    const progresso = paginasTotal ? Math.round((paginasProcessadas / paginasTotal) * 100) : 0;
    return (
      <div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <StatusBadge tone="info" label="Processando" />
          <span>
            {paginasTotal
              ? `Analisando produtos — página ${paginasProcessadas}/${paginasTotal} (${simulacao?.produtos_processados ?? 0} produtos)`
              : 'Buscando produtos na Ink…'}
          </span>
        </div>
        {paginasTotal != null && (
          <Card>
            <ProgressBar value={progresso} label="Progresso da migração" showValue />
          </Card>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="ds-button-row" style={{ marginBottom: 16 }}>
        <Button onClick={rodarSimulacao} disabled={simulando}>{simulando ? 'Simulando…' : 'Simular migração'}</Button>
      </div>
      {erro && <ErrorState description={erro} />}

      {simulacao && simulacao.status === 'simulada' && (
        <KpiStrip label="Resultado da simulação">
          <KpiCard title="Analisados" value={simulacao.total_analisados} />
          <KpiCard title="Prontos" value={simulacao.total_prontos} />
          <KpiCard title="Sem regra" value={simulacao.total_sem_regra} />
          <KpiCard title="Conflitos" value={simulacao.total_conflito} />
        </KpiStrip>
      )}

      {simulacao && simulacao.status === 'simulada' && (simulacao.total_sem_regra > 0 || simulacao.total_conflito > 0) && (
        <div className="ds-button-row" style={{ marginBottom: 16, alignItems: 'center' }}>
          <Button variant="secondary" onClick={reavaliarConflitos} disabled={reavaliando}>
            {reavaliando ? 'Reavaliando…' : 'Reavaliar sem regra/conflitos'}
          </Button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Reclassifica só quem ainda não tem categoria (ex: depois de importar o mapa de
            cidades, criar regra ou categoria nova) — não busca produtos de novo na Ink, bem mais
            rápido que rodar uma simulação inteira.
          </span>
          {resultadoReavaliacao && (
            <span style={{ fontSize: 13 }}>
              {resultadoReavaliacao.reavaliados} reavaliado(s) — {resultadoReavaliacao.resolvidos} resolvido(s), {resultadoReavaliacao.aindaPendente} ainda pendente(s).
            </span>
          )}
        </div>
      )}

      {simulacao && simulacao.status === 'simulada' && (
        <>
          <TabList
            label="Filtrar itens da simulação"
            value={statusFiltro}
            onChange={(v) => { setStatusFiltro(v); setPage(1); }}
            items={ITEM_STATUS_TABS.map((t) => ({ value: t.value, label: t.label }))}
          />

          {!itens && <Skeleton rows={5} />}
          {itens && itens.itens.length === 0 && <EmptyState title="Nenhum produto nesse filtro" description="Ajuste o filtro de status." />}
          {itens && itens.itens.length > 0 && (
            <>
              <DataTable
                rows={itens.itens}
                rowKey={(i) => i.id}
                columns={[
                  { key: 'produto', label: 'Produto', render: (i) => i.product_name || `#${i.product_id}` },
                  { key: 'colecao', label: 'Coleção', render: (i) => i.collection_detectada || '—' },
                  { key: 'cidade', label: 'Cidade', render: (i) => i.cidade_detectada || '—' },
                  { key: 'uf', label: 'UF', render: (i) => i.uf_detectada || '—' },
                  { key: 'fonteUf', label: 'Fonte UF', render: (i) => (i.fonte_uf === 'titulo' ? 'Título' : i.fonte_uf === 'mapa_cidade' ? 'Mapa cidade' : '—') },
                  {
                    key: 'confianca', label: 'Confiança',
                    render: (i) => (i.confianca ? <StatusBadge tone={i.confianca === 'alta' ? 'success' : 'warning'} label={i.confianca === 'alta' ? 'Alta' : 'Revisar'} /> : '—'),
                  },
                  { key: 'regiao', label: 'Região', render: (i) => i.regiao_detectada || '—' },
                  {
                    key: 'categorias', label: 'Categorias finais',
                    render: (i) => nomeCategorias(i.override_categorias != null ? i.override_categorias : i.categorias_finais),
                  },
                  {
                    key: 'status', label: 'Status',
                    render: (i) => {
                      const tone = i.status === 'pronto' ? 'success' : i.status === 'conflito' ? 'danger' : 'neutral';
                      return <StatusBadge tone={tone} label={i.status === 'pronto' ? 'Pronto' : i.status === 'conflito' ? 'Conflito' : 'Sem regra'} />;
                    },
                  },
                  { key: 'motivo', label: 'Conflito', render: (i) => i.conflito_motivo || '—' },
                  {
                    key: 'acoes', label: 'Ações',
                    render: (i) => (
                      <Button variant="secondary" onClick={() => alternarIgnorar(i)}>{i.override_ignorar ? 'Reincluir' : 'Ignorar'}</Button>
                    ),
                  },
                ]}
              />
              {itens.total > itens.pageSize && (() => {
                const totalPaginas = Math.max(1, Math.ceil(itens.total / itens.pageSize));
                return (
                  <div className="pc-paginacao">
                    <span>Página {page} de {totalPaginas} · {itens.total} produto(s)</span>
                    <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
                    <Button variant="secondary" disabled={page >= totalPaginas} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      Ir para
                      <input
                        key={page}
                        type="number" min={1} max={totalPaginas} defaultValue={page}
                        className="ds-input" style={{ width: 64 }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          const alvo = Math.min(totalPaginas, Math.max(1, Number(e.currentTarget.value) || 1));
                          setPage(alvo);
                        }}
                        onBlur={(e) => {
                          const alvo = Math.min(totalPaginas, Math.max(1, Number(e.currentTarget.value) || 1));
                          if (alvo !== page) setPage(alvo);
                        }}
                      />
                    </span>
                  </div>
                );
              })()}
            </>
          )}

          <Card>
            <p style={{ marginBottom: 8, fontWeight: 600 }}>Escopo da execução</p>
            <label style={{ display: 'block', padding: '4px 0' }}>
              <input type="radio" checked={escopo === 'todos'} onChange={() => setEscopo('todos')} />
              {' '}Tudo que está pronto ({simulacao?.total_prontos ?? 0})
              {contagens ? ` — inclui ${contagens.totalPorFallback} classificado(s) por cidade→UF, sem nenhuma regra ter batido` : ''}
            </label>
            <label style={{ display: 'block', padding: '4px 0' }}>
              <input type="radio" checked={escopo === 'regras'} onChange={() => setEscopo('regras')} />
              {' '}Só o que bateu em regra ({contagens?.totalPorRegra ?? 0})
            </label>
            {escopo === 'regras' && (
              <div style={{ marginTop: 8, paddingLeft: 16 }}>
                {!contagens && <Skeleton rows={2} />}
                {contagens && contagens.regras.map((r) => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
                    <input
                      type="checkbox"
                      checked={regrasSelecionadas.has(r.id)}
                      disabled={r.total === 0}
                      onChange={() => setRegrasSelecionadas((atual) => {
                        const novo = new Set(atual);
                        if (novo.has(r.id)) novo.delete(r.id); else novo.add(r.id);
                        return novo;
                      })}
                    />
                    <span>{r.nome} · {r.total} produto(s){r.habilitada ? '' : ' · desabilitada'}</span>
                    {r.total === 0 && (
                      <span style={{ color: 'var(--warning)', fontSize: 12 }}>
                        não pegou nenhum produto — as condições de uma regra são somadas com E, então algo como
                        “termina com 041” E “termina com 044” nunca pode ser verdade ao mesmo tempo (quebre em regras separadas)
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </Card>

          <div className="ds-button-row" style={{ marginTop: 16 }}>
            <Button variant="primary" onClick={() => setConfirmandoExecucao(true)} disabled={!simulacao || totalNoEscopo === 0}>
              Confirmar e executar
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmandoExecucao}
        title="Confirmar execução da migração"
        description={
          escopo === 'regras'
            ? `Até ${totalNoEscopo} produto(s) das ${regrasSelecionadas.size} regra(s) escolhida(s) serão atualizados (REPLACE) — produto que bateu em 2 regras conta uma vez só. Nada classificado por cidade→UF entra nesta execução. Essa ação roda em segundo plano.`
            : `${simulacao?.total_prontos ?? 0} produto(s) prontos serão atualizados (REPLACE), incluindo os classificados por cidade→UF sem regra. Produtos em conflito, sem classificação ou marcados como "ignorar" não serão alterados. Essa ação roda em segundo plano.`
        }
        confirmLabel="Confirmar e executar"
        onConfirm={confirmarExecucao}
        onClose={() => setConfirmandoExecucao(false)}
      />
    </div>
  );
}

const UF_OPCOES = ['RS', 'SC', 'PR'];

function BulkImportCidadesModal({ open, onClose, onImportado }: { open: boolean; onClose: () => void; onImportado: () => void }) {
  const [texto, setTexto] = useState('');
  const [preview, setPreview] = useState<CityUfBulkPreviewItem[] | null>(null);
  const [erro, setErro] = useState('');
  const [importando, setImportando] = useState(false);

  useEffect(() => { if (!open) { setTexto(''); setPreview(null); setErro(''); } }, [open]);

  async function analisar() {
    setErro('');
    try {
      const r = await bulkPreviewCityUfMap(texto);
      setPreview(r.itens);
    } catch (err) {
      setErro((err as Error).message);
    }
  }

  async function confirmar() {
    if (!preview) return;
    const prontos = preview.filter((i) => i.status === 'pronta' && i.uf);
    if (!prontos.length) return;
    setImportando(true); setErro('');
    try {
      await bulkCreateCityUfMap(prontos.map((i) => ({ cidade: i.cidade, uf: i.uf as string })));
      onImportado();
      onClose();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setImportando(false);
    }
  }

  const prontas = preview?.filter((i) => i.status === 'pronta').length ?? 0;

  return (
    <Modal
      open={open} onClose={onClose} title="Importar cidades em lote"
      confirmLabel={preview ? (importando ? 'Importando…' : `Importar ${prontas}`) : 'Analisar'}
      confirmDisabled={importando || (preview ? prontas === 0 : !texto.trim())}
      onConfirm={preview ? confirmar : analisar}
    >
      {erro && <ErrorState description={erro} />}
      {!preview && (
        <Field label='1 cidade por linha, formato "Cidade;UF" ou "Cidade,UF" (ex: Joinville;SC)'>
          <textarea className="ds-input" rows={8} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </Field>
      )}
      {preview && (
        <>
          <p>{preview.length} linha(s) — {prontas} pronta(s), {preview.filter((i) => i.status === 'ja_existe').length} já existem, {preview.filter((i) => i.status === 'duplicada_na_lista').length} duplicadas, {preview.filter((i) => i.status === 'uf_invalida').length} com UF inválida.</p>
          <DataTable
            rows={preview} rowKey={(i) => i.linha}
            columns={[
              { key: 'cidade', label: 'Cidade', render: (i) => i.cidade },
              { key: 'uf', label: 'UF', render: (i) => i.uf || '—' },
              {
                key: 'status', label: 'Status',
                render: (i) => {
                  const map: Record<string, { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
                    pronta: { label: 'Pronta', tone: 'success' },
                    ja_existe: { label: 'Já existe', tone: 'neutral' },
                    duplicada_na_lista: { label: 'Duplicada', tone: 'warning' },
                    uf_invalida: { label: 'UF inválida', tone: 'warning' },
                  };
                  return <StatusBadge tone={map[i.status].tone} label={map[i.status].label} />;
                },
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}

function DescobrirCidadesModal({ loja, open, onClose, onSalvo }: { loja: string; open: boolean; onClose: () => void; onSalvo: () => void }) {
  const [cidades, setCidades] = useState<DiscoveredCity[] | null>(null);
  const [ufs, setUfs] = useState<Record<string, string>>({});
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!open) { setCidades(null); setUfs({}); setErro(''); return; }
    discoverCities().then((d) => setCidades(d.cidades)).catch((err: Error) => setErro(err.message));
  }, [open, loja]);

  async function salvar() {
    if (!cidades) return;
    const itens = cidades.filter((c) => ufs[c.cidadeNormalizada]).map((c) => ({ cidade: c.cidadeDisplay, uf: ufs[c.cidadeNormalizada] }));
    if (!itens.length) return;
    setSalvando(true); setErro('');
    try {
      await bulkCreateCityUfMap(itens);
      onSalvo();
      onClose();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  const selecionadas = cidades ? cidades.filter((c) => ufs[c.cidadeNormalizada]).length : 0;

  return (
    <Modal
      open={open} onClose={onClose} title="Descobrir cidades no catálogo"
      confirmLabel={salvando ? 'Salvando…' : `Salvar ${selecionadas}`}
      confirmDisabled={salvando || selecionadas === 0}
      onConfirm={salvar}
    >
      {erro && <ErrorState description={erro} />}
      {!erro && !cidades && <Skeleton rows={5} />}
      {cidades && cidades.length === 0 && <EmptyState title="Nenhuma cidade nova" description="Todas as cidades encontradas no catálogo já estão mapeadas." />}
      {cidades && cidades.length > 0 && (
        <DataTable
          rows={cidades} rowKey={(c) => c.cidadeNormalizada}
          columns={[
            { key: 'cidade', label: 'Cidade', render: (c) => c.cidadeDisplay },
            { key: 'qtd', label: 'Produtos', render: (c) => String(c.quantidadeProdutos) },
            {
              key: 'uf', label: 'UF',
              render: (c) => (
                <select className="ds-select" value={ufs[c.cidadeNormalizada] || ''} onChange={(e) => setUfs((atual) => ({ ...atual, [c.cidadeNormalizada]: e.target.value }))}>
                  <option value="">— selecionar —</option>
                  {UF_OPCOES.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
                </select>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

function CityUfMapTab({ loja }: { loja: string }) {
  const [cidades, setCidades] = useState<CityUfEntry[] | null>(null);
  const [erro, setErro] = useState('');
  const [modalAberto, setModalAberto] = useState(false);
  const [editando, setEditando] = useState<CityUfEntry | null>(null);
  const [cidadeForm, setCidadeForm] = useState('');
  const [ufForm, setUfForm] = useState('');
  const [erroForm, setErroForm] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [excluindo, setExcluindo] = useState<CityUfEntry | null>(null);
  const [importAberto, setImportAberto] = useState(false);
  const [descobrirAberto, setDescobrirAberto] = useState(false);
  const [confirmandoDicionario, setConfirmandoDicionario] = useState(false);
  const [resultadoDicionario, setResultadoDicionario] = useState<{ importados: number; jaExistiam: number; total: number } | null>(null);

  const carregar = useCallback(() => {
    setErro('');
    listCityUfMap().then((d) => setCidades(d.cidades)).catch((err: Error) => setErro(err.message));
  }, [loja]);
  useEffect(carregar, [carregar]);

  function abrirNova() { setEditando(null); setCidadeForm(''); setUfForm(''); setErroForm(''); setModalAberto(true); }
  function abrirEdicao(c: CityUfEntry) { setEditando(c); setCidadeForm(c.cidade_display); setUfForm(c.uf); setErroForm(''); setModalAberto(true); }

  async function salvar() {
    setErroForm('');
    if (!editando && !cidadeForm.trim()) return setErroForm('cidade é obrigatória');
    if (!ufForm) return setErroForm('escolha a UF');
    setSalvando(true);
    try {
      if (editando) await updateCityUfEntry(editando.id, ufForm);
      else await createCityUfEntry(cidadeForm.trim(), ufForm);
      setModalAberto(false);
      carregar();
    } catch (err) {
      setErroForm((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await deleteCityUfEntry(excluindo.id);
    carregar();
  }

  async function confirmarImportarDicionario() {
    const r = await importarDicionarioMunicipios();
    setResultadoDicionario(r);
    carregar();
  }

  return (
    <div>
      <div className="ds-button-row" style={{ marginBottom: 16 }}>
        <Button onClick={abrirNova}>+ Adicionar</Button>
        <Button variant="secondary" onClick={() => setImportAberto(true)}>Importar em lote</Button>
        <Button variant="secondary" onClick={() => setDescobrirAberto(true)}>Descobrir cidades</Button>
        <Button variant="secondary" onClick={() => { setResultadoDicionario(null); setConfirmandoDicionario(true); }}>
          Importar dicionário de municípios (RS/SC/PR)
        </Button>
      </div>
      {resultadoDicionario && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Dicionário: {resultadoDicionario.importados} cidade(s) nova(s) importada(s), {resultadoDicionario.jaExistiam} já existiam (de {resultadoDicionario.total} municípios de RS/SC/PR no dicionário).
        </p>
      )}
      {erro && <ErrorState description={erro} />}
      {!erro && !cidades && <Skeleton rows={4} />}
      {!erro && cidades && cidades.length === 0 && (
        <EmptyState title="Nenhuma cidade mapeada ainda" description='Usado como fallback quando o produto não tem UF explícita no nome (ex: "Joinville | Coordenadas").' />
      )}
      {!erro && cidades && cidades.length > 0 && (
        <DataTable
          rows={cidades} rowKey={(c) => c.id} onRowClick={abrirEdicao}
          columns={[
            { key: 'cidade', label: 'Cidade', render: (c) => c.cidade_display },
            { key: 'uf', label: 'UF', render: (c) => c.uf },
            {
              key: 'acoes', label: '',
              render: (c) => <Button variant="secondary" onClick={(e) => { e.stopPropagation(); setExcluindo(c); }}>Excluir</Button>,
            },
          ]}
        />
      )}

      <Modal
        open={modalAberto} onClose={() => setModalAberto(false)} title={editando ? 'Editar UF da cidade' : 'Adicionar cidade'}
        confirmLabel={salvando ? 'Salvando…' : 'Salvar'} confirmDisabled={salvando} onConfirm={salvar}
      >
        <Field label="Cidade">
          <input className="ds-input" value={cidadeForm} onChange={(e) => setCidadeForm(e.target.value)} disabled={!!editando} />
        </Field>
        <Field label="UF">
          <select className="ds-select" value={ufForm} onChange={(e) => setUfForm(e.target.value)}>
            <option value="">— selecionar —</option>
            {UF_OPCOES.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
          </select>
        </Field>
        {erroForm && <ErrorState description={erroForm} />}
      </Modal>

      <ConfirmDialog
        open={excluindo != null} onClose={() => setExcluindo(null)} title="Excluir cidade do mapa"
        description={excluindo ? `Remover "${excluindo.cidade_display}" do mapa cidade→UF? Simulações futuras vão parar de resolver essa cidade automaticamente.` : ''}
        onConfirm={confirmarExclusao}
      />

      <ConfirmDialog
        open={confirmandoDicionario} onClose={() => setConfirmandoDicionario(false)} title="Importar dicionário de municípios"
        description="Isso vai adicionar até ~1165 municípios conhecidos de RS/SC/PR ao mapa cidade→UF desta loja — nomes já mapeados não são duplicados (fica só o que já estava lá)."
        confirmLabel="Importar" onConfirm={confirmarImportarDicionario}
      />

      <BulkImportCidadesModal open={importAberto} onClose={() => setImportAberto(false)} onImportado={carregar} />
      <DescobrirCidadesModal loja={loja} open={descobrirAberto} onClose={() => setDescobrirAberto(false)} onSalvo={carregar} />
    </div>
  );
}

// Etapas 7/8/12 do doc claude-migracao-final-categorias-snapshot-especiais.md: uma categoria
// antiga só pode ser excluída quando todos os produtos dela já têm destino decidido (a validação
// real acontece sempre no servidor — aqui só refletimos o que ele calculou, nunca deixamos
// selecionar uma categoria bloqueada).
function LimparCategoriasTab({ loja }: { loja: string }) {
  const [dados, setDados] = useState<{ simulacaoUsada: { id: number; criado_em: string; status: string } | null; simulacaoNecessaria: boolean; categorias: CategoriaAntiga[] } | null>(null);
  const [erro, setErro] = useState('');
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<{ excluidas: number; bloqueadas: number; falharam: number } | null>(null);

  const carregar = useCallback(() => {
    setErro(''); setResultado(null); setSelecionadas(new Set());
    listarCategoriasAntigas().then(setDados).catch((err: Error) => setErro(err.message));
  }, [loja]);
  useEffect(carregar, [carregar]);

  const categorias = dados?.categorias ?? [];
  const liberadas = categorias.filter((c) => !c.bloqueada);

  function alternarSelecao(c: CategoriaAntiga) {
    if (c.bloqueada) return;
    setSelecionadas((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(c.id)) proximo.delete(c.id); else proximo.add(c.id);
      return proximo;
    });
  }

  async function confirmarExclusao() {
    const r = await excluirCategoriasAntigas(Array.from(selecionadas), dados?.simulacaoUsada?.id);
    setResultado(r.resumo);
    carregar();
  }

  if (erro) return <ErrorState description={erro} />;
  if (!dados) return <Skeleton rows={5} />;
  if (dados.simulacaoNecessaria) {
    return <EmptyState title="Rode uma simulação primeiro" description="Sem uma simulação recente, nenhuma categoria pode ser considerada segura pra excluir — a categoria atual pode ser a única forma de saber o destino de um produto (coleções especiais)." />;
  }
  if (!categorias.length) {
    return <EmptyState title="Nenhuma categoria encontrada" description="A loja não tem categorias cadastradas ainda." />;
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
        Considerando a simulação de {dados.simulacaoUsada ? new Date(dados.simulacaoUsada.criado_em).toLocaleString('pt-BR') : '—'}.
        Categorias com produto sem destino ficam bloqueadas — rode/atualize a simulação depois de resolver as pendências.
      </p>
      {resultado && (
        <p style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>{resultado.excluidas}</strong> excluída(s), <strong>{resultado.bloqueadas}</strong> bloqueada(s), <strong>{resultado.falharam}</strong> falharam.
        </p>
      )}
      {selecionadas.size > 0 && (
        <div className="ds-button-row" style={{ marginBottom: 12 }}>
          <span style={{ alignSelf: 'center' }}>{selecionadas.size} selecionada(s)</span>
          <Button variant="danger" onClick={() => setConfirmando(true)}>Excluir selecionadas</Button>
        </div>
      )}
      <DataTable
        rows={categorias}
        rowKey={(c) => c.id}
        selection={{
          isSelected: (c) => selecionadas.has(c.id),
          onToggleRow: alternarSelecao,
          allOnPageSelected: liberadas.length > 0 && liberadas.every((c) => selecionadas.has(c.id)),
          onToggleAll: (checked) => setSelecionadas(checked ? new Set(liberadas.map((c) => c.id)) : new Set()),
        }}
        columns={[
          { key: 'nome', label: 'Categoria', render: (c) => c.nome },
          { key: 'total', label: 'Total de produtos', render: (c) => c.totalProdutos },
          { key: 'semDestino', label: 'Sem destino', render: (c) => c.produtosSemDestino },
          { key: 'exemplos', label: 'Exemplos', render: (c) => c.exemplos.join(', ') || '—' },
          {
            key: 'status', label: 'Status',
            render: (c) => <StatusBadge tone={c.bloqueada ? 'danger' : 'success'} label={c.bloqueada ? (c.motivo || 'Bloqueada') : 'Pronta pra excluir'} />,
          },
        ]}
      />
      <ConfirmDialog
        open={confirmando}
        onClose={() => setConfirmando(false)}
        title="Excluir categorias antigas"
        description={`${selecionadas.size} categoria(s) serão excluídas permanentemente da Ink. Só categorias sem produto pendente são excluídas de verdade — o servidor revalida antes de agir.`}
        confirmLabel="Excluir"
        confirmVariant="danger"
        onConfirm={confirmarExclusao}
      />
    </div>
  );
}

function HistoricoTab({ loja, onVerSimulacao }: { loja: string; onVerSimulacao: (id: number) => void }) {
  const [simulacoes, setSimulacoes] = useState<MigrationSimulation[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    listMigrationSimulations().then((d) => setSimulacoes(d.simulacoes)).catch((err: Error) => setErro(err.message));
  }, [loja]);

  if (erro) return <ErrorState description={erro} />;
  if (!simulacoes) return <Skeleton rows={4} />;
  if (!simulacoes.length) return <EmptyState title="Nenhuma simulação ainda" description="Rode uma simulação na aba Simulação." />;

  return (
    <DataTable
      rows={simulacoes}
      rowKey={(s) => s.id}
      columns={[
        { key: 'data', label: 'Data', render: (s) => new Date(s.criado_em).toLocaleString('pt-BR') },
        { key: 'analisados', label: 'Analisados', render: (s) => String(s.total_analisados) },
        { key: 'prontos', label: 'Prontos', render: (s) => String(s.total_prontos) },
        { key: 'conflitos', label: 'Conflitos', render: (s) => String(s.total_conflito) },
        {
          key: 'status', label: 'Status',
          render: (s) => {
            const map: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
              processando: { label: 'Processando…', tone: 'info' },
              falhou: { label: 'Falhou', tone: 'danger' },
              simulada: { label: 'Simulada (não executada)', tone: 'neutral' },
              executando: { label: 'Executando', tone: 'info' },
              executada: { label: 'Executada', tone: 'success' },
            };
            const m = map[s.status] || { label: s.status, tone: 'neutral' as const };
            return <StatusBadge tone={m.tone} label={m.label} />;
          },
        },
        {
          key: 'acoes', label: 'Ações',
          render: (s) => (
            <div className="ds-button-row">
              <Button variant="secondary" onClick={() => onVerSimulacao(s.id)}>Ver</Button>
              <a href={exportMigrationCsvUrl(s.id)} target="_blank" rel="noreferrer" className="ds-btn ds-btn--secondary">Baixar CSV</a>
            </div>
          ),
        },
      ]}
    />
  );
}

// Ordem das abas — usada só pra guardar/ler o índice ativo na URL (?aba=simulacao), não muda o
// que já é passado pro <Tabs> (label continua sendo o texto exibido).
const TAB_KEYS = ['regras', 'cidades', 'simulacao', 'limpar-categorias', 'historico'];

export function OrigensMigrationPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const loja = lojaSelecionada;
  const [categorias, setCategorias] = useState<Categoria[] | null>(null);

  // simulationIdAtiva e a aba ativa moram na URL (não em useState de um componente que o <Tabs>
  // desmonta ao trocar de aba) — sobrevive a trocar de aba E a um F5 da página. Simulação grande
  // pode levar minutos (visto na prática: ~20min pra 85 mil produtos); antes disso, sair da aba
  // "Simulação e execução" perdia o acompanhamento e o resultado, só sobrava "Baixar CSV" no
  // Histórico (usuário reportado, 2026-09-09).
  const [searchParams, setSearchParams] = useSearchParams();
  // Helper único (não 2 chamadas separadas de setSearchParams) — "Ver" no Histórico precisa
  // mudar simulacao+aba ATOMICAMENTE; 2 chamadas seguidas correriam risco de a 2ª ler `prev` sem
  // a mudança da 1ª ainda aplicada (cada uma parte do mesmo snapshot do render atual).
  function atualizarQuery(mutar: (next: URLSearchParams) => void) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutar(next);
      return next;
    }, { replace: true });
  }
  const simulationIdAtiva = (() => {
    const v = searchParams.get('simulacao');
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  })();
  function setSimulationIdAtiva(id: number | null) {
    atualizarQuery((next) => { if (id != null) next.set('simulacao', String(id)); else next.delete('simulacao'); });
  }
  // Mesmo motivo do simulationIdAtiva: executar a migração real (Parte 6) numa loja grande pode
  // levar bastante tempo (é o mesmo job/executor da Fase 2, com o mesmo throughput) — sem isso,
  // trocar de aba durante a execução perdia o acompanhamento igual acontecia com a simulação.
  const jobIdAtivo = (() => {
    const v = searchParams.get('job');
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  })();
  function setJobIdAtivo(id: number | null) {
    atualizarQuery((next) => { if (id != null) next.set('job', String(id)); else next.delete('job'); });
  }
  const activeTabIndex = (() => {
    const idx = TAB_KEYS.indexOf(searchParams.get('aba') || '');
    return idx === -1 ? 0 : idx;
  })();
  function setActiveTabIndex(i: number) {
    atualizarQuery((next) => { next.set('aba', TAB_KEYS[i] || TAB_KEYS[0]); });
  }
  // "Ver" no Histórico: troca simulação ativa + aba num único push de URL (atômico).
  function abrirSimulacaoNaAba(id: number, indiceAba: number) {
    atualizarQuery((next) => { next.set('simulacao', String(id)); next.set('aba', TAB_KEYS[indiceAba] || TAB_KEYS[0]); });
  }
  // A proteção real é do backend (requireInternalTools/404) — este check é só pra não deixar a
  // tela "meio quebrada" mostrando erro de rede pra quem não devia nem ver que ela existe.
  const [habilitada, setHabilitada] = useState<boolean | null>(null);

  useEffect(() => {
    getInternalToolsStatus().then((d) => setHabilitada(d.enabled)).catch(() => setHabilitada(false));
  }, []);

  useEffect(() => {
    if (habilitada) listCategorias().then((d) => setCategorias(d.categorias)).catch(() => setCategorias([]));
  }, [loja, habilitada]);

  if (habilitada === null) return <Skeleton rows={4} />;
  if (!habilitada) return <EmptyState title="Página não encontrada" description="Essa ferramenta não está disponível." />;

  return (
    <>
      <PageHeader
        title="Migração Use Origens"
        description="Ferramenta interna — classifica produtos por regras (nome), simula antes de aplicar, executa em massa. Não é exposta a clientes normais."
        back={{ to: '/admin/categorias', label: 'Voltar pra categorias' }}
      />
      <Tabs
        activeIndex={activeTabIndex}
        onChangeIndex={setActiveTabIndex}
        tabs={[
          { label: 'Regras', render: () => <RegrasTab loja={loja} categorias={categorias} /> },
          { label: 'Mapa Cidade → UF', render: () => <CityUfMapTab loja={loja} /> },
          {
            label: 'Simulação e execução',
            render: () => (
              <SimulacaoTab
                categorias={categorias}
                simulationIdAtiva={simulationIdAtiva} setSimulationIdAtiva={setSimulationIdAtiva}
                jobIdAtivo={jobIdAtivo} setJobIdAtivo={setJobIdAtivo}
              />
            ),
          },
          { label: 'Limpar categorias', render: () => <LimparCategoriasTab loja={loja} /> },
          {
            label: 'Histórico',
            render: () => (
              <HistoricoTab
                loja={loja}
                onVerSimulacao={(id) => abrirSimulacaoNaAba(id, 2)}
              />
            ),
          },
        ]}
      />
    </>
  );
}
