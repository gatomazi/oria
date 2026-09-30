import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, Callout, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, PageStack, RowActionsMenu, Select, Skeleton, StatusBadge,
} from '../../components/ds';
import { afiliados, type NivelDeRegra, type PropostaDeNivel } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { toast } from '../../lib/toast';
import { brl, centavosDeTexto, dataCurta, mensagemDoErro, pct, plural } from '../../lib/parcerias';
import { MotivoDialog } from './modais';
import { useParcerias } from './ParceriasLayout';

function texto(v: number | null | undefined): string { return v === null || v === undefined ? '' : String(v); }

const CHAVE_VALIDA = /^[a-z][a-z0-9_]{1,30}$/;
const MIN_NIVEIS = 1;
const MAX_NIVEIS = 16;

// Sugestão de chave a partir do nome (só para o botão "Adicionar nível" pré-preencher algo razoável); o campo continua
// livre para o lojista editar — a chave é a identidade do nível entre versões, então ele decide o quanto mexe nela.
function sugerirChave(label: string, emUso: Set<string>): string {
  const base = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  const raiz = base.length >= 2 ? base.slice(0, 31) : 'nivel';
  if (!emUso.has(raiz)) return raiz;
  for (let i = 2; i < 1000; i += 1) { const tentativa = `${raiz.slice(0, 27)}_${i}`; if (!emUso.has(tentativa)) return tentativa; }
  return `${raiz.slice(0, 20)}_${Date.now().toString(36)}`;
}

// Só o benefício em si (sem a comissão) — usado como retorno rápido dentro do próprio formulário de edição.
function descreverBeneficio(b: NivelDeRegra['beneficio']): string {
  if (b.tipo === 'nenhum') return 'Sem peça';
  if (b.tipo === 'primeira_peca') return `1ª peça após ${plural(b.aPartirDeVendas ?? 0, 'venda')}`;
  return `Peça a cada ${plural(b.aCadaDias ?? 0, 'dia')}${b.exigeVendasUltimos30d ? ` · exige ${b.exigeVendasUltimos30d}+ vendas em 30 dias` : ''}`;
}

// Fragmentos curtos das metas de progressão (vazio quando não se aplicam) — a mesma lista alimenta o resumo fechado
// (bullets) e a frase completa dentro da edição; nunca é hardcoded, sempre lido do nível atual.
function fragmentosDeRequisito(n: NivelDeRegra): string[] {
  const partes: string[] = [];
  if (n.vendasQualificadas > 0) partes.push(plural(n.vendasQualificadas, 'venda qualificada', 'vendas qualificadas'));
  if (n.margemCents > 0) partes.push(`${brl(n.margemCents)} de margem`);
  if (n.mesesComVenda > 0) partes.push(`vendas em ${plural(n.mesesComVenda, 'mês', 'meses')}`);
  if (n.vendasUltimos60d > 0) partes.push(`${plural(n.vendasUltimos60d, 'venda recente', 'vendas recentes')}`);
  return partes;
}

function resumoRequisitos(n: NivelDeRegra): string {
  const partes = fragmentosDeRequisito(n);
  if (n.janelaDias) partes.push(`janela de ${plural(n.janelaDias, 'dia')}`);
  return partes.length ? partes.join(' • ') : 'Sem meta de vendas própria';
}

function fraseRequisitos(n: NivelDeRegra): string {
  const partes = fragmentosDeRequisito(n);
  if (!partes.length) return 'Este nível não exige metas de vendas — qualquer parceiro aprovado alcança.';
  let frase = `O parceiro precisa cumprir ${partes.join(' + ')}`;
  if (n.janelaDias) frase += `, considerando os últimos ${plural(n.janelaDias, 'dia')}`;
  return `${frase}.`;
}

function resumoBeneficios(n: NivelDeRegra): string {
  return [`Até ${pct(n.tetoMargemBps)} de comissão`, descreverBeneficio(n.beneficio)].join(' • ');
}

// Um card por nível: fechado mostra o resumo (o que exige, o que dá); só um fica aberto em edição por vez — trocar
// com edição não salva avisa antes de descartar. `ordem` nunca é campo do formulário: é a posição no array.
function EditorDeRegras({ niveis, isOwner, onSalvo }: { niveis: NivelDeRegra[]; isOwner: boolean; onSalvo: () => void }) {
  const [linhas, setLinhas] = useState<NivelDeRegra[]>(niveis);
  const [editando, setEditando] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<NivelDeRegra | null>(null);
  const [novoAberto, setNovoAberto] = useState(false); // o card em edição nunca existiu numa versão salva: Cancelar remove a linha, não só reverte campos
  const [trocaPendente, setTrocaPendente] = useState<number | 'adicionar' | null>(null);
  const [removendo, setRemovendo] = useState<number | null>(null);
  const [modalSalvar, setModalSalvar] = useState(false);
  const [avisoOrfaos, setAvisoOrfaos] = useState<{ key: string; partners: number; exemplo: string }[]>([]);
  useEffect(() => { setLinhas(niveis); setEditando(null); setSnapshot(null); setNovoAberto(false); }, [niveis]);
  const alterado = JSON.stringify(linhas.map(({ ordem: _ordem, ...resto }) => resto)) !== JSON.stringify(niveis.map(({ ordem: _ordem, ...resto }) => resto));
  const sujo = editando !== null && snapshot !== null && JSON.stringify(linhas[editando]) !== JSON.stringify(snapshot);

  const reindexar = (ls: NivelDeRegra[]) => ls.map((n, i) => ({ ...n, ordem: i }));
  const atualizar = (i: number, patch: Partial<NivelDeRegra>) => setLinhas((ls) => reindexar(ls.map((n, j) => (j === i ? { ...n, ...patch } : n))));
  const atualizarBeneficio = (i: number, b: NivelDeRegra['beneficio']) => atualizar(i, { beneficio: b });

  function abrirEdicao(i: number) {
    if (sujo && editando !== i) { setTrocaPendente(i); return; }
    setEditando(i); setSnapshot(linhas[i]); setNovoAberto(false);
  }
  function cancelarEdicao() {
    if (editando !== null) {
      if (novoAberto) setLinhas((ls) => reindexar(ls.filter((_, j) => j !== editando))); // nunca foi salvo: cancelar tira a linha inteira
      else if (snapshot) setLinhas((ls) => ls.map((n, j) => (j === editando ? snapshot : n)));
    }
    setEditando(null); setSnapshot(null); setNovoAberto(false);
  }
  function concluirEdicaoDoCard() { setEditando(null); setSnapshot(null); setNovoAberto(false); } // fecha o card; o que foi digitado FICA em `linhas` (só publica ao Salvar alterações)

  function novoNivel(): NivelDeRegra {
    const emUso = new Set(linhas.map((n) => n.key));
    const label = `Nível ${linhas.length + 1}`;
    const ultimo = linhas[linhas.length - 1];
    return {
      key: sugerirChave(label, emUso), label, ordem: linhas.length, janelaDias: 90,
      vendasQualificadas: ultimo.vendasQualificadas + 10, margemCents: ultimo.margemCents + 15000, mesesComVenda: 0, vendasUltimos60d: 0,
      tetoMargemBps: Math.min(10000, ultimo.tetoMargemBps + 500), beneficio: { tipo: 'nenhum' },
    };
  }
  function adicionar() {
    if (sujo) { setTrocaPendente('adicionar'); return; }
    const indiceNovo = linhas.length;
    const nova = novoNivel();
    setLinhas((ls) => reindexar([...ls, nova]));
    setEditando(indiceNovo); setSnapshot(nova); setNovoAberto(true);
  }
  function confirmarTroca() {
    const alvo = trocaPendente;
    cancelarEdicao();
    if (alvo === 'adicionar') { const nova = novoNivel(); setLinhas((ls) => reindexar([...ls, nova])); setEditando(linhas.length); setSnapshot(nova); setNovoAberto(true); }
    else if (alvo !== null) { setEditando(alvo); setSnapshot(linhas[alvo]); setNovoAberto(false); }
    setTrocaPendente(null);
  }
  function removerDeVerdade(i: number) {
    setLinhas((ls) => reindexar(ls.filter((_, j) => j !== i)));
    if (editando === i) { setEditando(null); setSnapshot(null); setNovoAberto(false); }
  }
  function mover(i: number, delta: number) {
    const j = i + delta;
    if (i === 0 || j <= 0 || j >= linhas.length) return;
    setLinhas((ls) => { const copia = [...ls]; [copia[i], copia[j]] = [copia[j], copia[i]]; return reindexar(copia); });
  }

  const chaves = new Set(linhas.map((n) => n.key));
  const problemas: string[] = [];
  if (linhas.length < MIN_NIVEIS || linhas.length > MAX_NIVEIS) problemas.push(`use de ${MIN_NIVEIS} a ${MAX_NIVEIS} níveis (hoje: ${linhas.length})`);
  if (chaves.size !== linhas.length) problemas.push('há chaves de nível repetidas');
  linhas.forEach((n, i) => {
    if (!CHAVE_VALIDA.test(n.key)) problemas.push(`nível ${i + 1}: chave inválida (a-z, 0-9, _; começa com letra; 2 a 31 caracteres)`);
    if (!n.label.trim()) problemas.push(`nível ${i + 1}: nome é obrigatório`);
  });

  async function salvar(motivo: string) {
    const r = await afiliados.salvarRegrasDeNivel({ niveis: linhas }, motivo);
    setAvisoOrfaos(r.avisos.niveisOrfaos);
    toast('Regras de nível salvas em nova versão.', 'sucesso');
    onSalvo();
  }

  return (
    <div className="pa-form">
      {avisoOrfaos.length > 0 && (
        <Callout tone="warning">
          <ul className="pa-lista">{avisoOrfaos.map((a) => <li key={a.key}>{plural(a.partners, 'parceiro está', 'parceiros estão')} no nível "{a.key}" (ex.: {a.exemplo}), que não existe mais nesta versão — {a.partners === 1 ? 'ele' : 'eles'} volta{a.partners === 1 ? '' : 'm'} para o nível base até a próxima proposta.</li>)}</ul>
        </Callout>
      )}
      {linhas.map((n, i) => {
        const aberto = editando === i;
        return (
          <div key={i} className={`pa-nivel${aberto ? ' pa-nivel--aberto' : ''}`}>
            <div className="pa-nivel__cabecalho">
              <span className="pa-nivel__ordinal" aria-hidden="true">{i + 1}</span>
              <strong className="pa-nivel__nome">{n.label || '(sem nome)'}</strong>
              {i === 0 && <StatusBadge tone="neutral" label="Nível inicial" />}
              {isOwner && (
                <div className="ds-toolbar__end">
                  <Button size="sm" variant="ghost" disabled={i <= 1} onClick={() => mover(i, -1)} aria-label={`Mover ${n.label} para cima`}>↑</Button>
                  <Button size="sm" variant="ghost" disabled={i === 0 || i === linhas.length - 1} onClick={() => mover(i, 1)} aria-label={`Mover ${n.label} para baixo`}>↓</Button>
                  <RowActionsMenu items={[{ label: 'Remover nível', variant: 'danger', disabled: i === 0 || linhas.length <= MIN_NIVEIS, onSelect: () => setRemovendo(i) }]} />
                </div>
              )}
            </div>

            {!aberto ? (
              <div className="pa-nivel__resumo">
                {i === 0 ? (
                  <>
                    <p className="pa-nivel__linha-resumo">Todo parceiro aprovado começa aqui.</p>
                    <p className="pa-nivel__linha-resumo">Comissão máxima: <strong>{pct(n.tetoMargemBps)}</strong> · Benefício: <strong>{descreverBeneficio(n.beneficio)}</strong></p>
                  </>
                ) : (
                  <>
                    <p className="pa-nivel__linha-resumo">Para chegar aqui: {resumoRequisitos(n)}</p>
                    <p className="pa-nivel__linha-resumo">Benefícios: {resumoBeneficios(n)}</p>
                  </>
                )}
                {isOwner && (
                  <div className="ds-toolbar"><span /><div className="ds-toolbar__end"><Button size="sm" variant="secondary" onClick={() => abrirEdicao(i)}>Editar nível</Button></div></div>
                )}
              </div>
            ) : (
              <div className="pa-form">
                <div className="pa-subgrupo">
                  <h4 className="pa-subgrupo__titulo">Identificação</h4>
                  <div className="pa-form__linha">
                    <Field label="Nome do nível"><Input value={n.label} maxLength={60} onChange={(e) => atualizar(i, { label: e.target.value })} /></Field>
                    <Field label="Chave interna" hint="Usada internamente pelo sistema; parceiros já neste nível avisam se ela sumir."><Input controlSize="sm" value={n.key} onChange={(e) => atualizar(i, { key: e.target.value.trim().toLowerCase() })} /></Field>
                  </div>
                </div>

                {i > 0 ? (
                  <div className="pa-subgrupo">
                    <h4 className="pa-subgrupo__titulo">Requisitos para alcançar este nível</h4>
                    <div className="pa-form__linha">
                      <Field label="Vendas qualificadas"><Input type="number" min={0} aria-label={`${n.label}: vendas qualificadas`} value={texto(n.vendasQualificadas)} onChange={(e) => atualizar(i, { vendasQualificadas: Number(e.target.value) })} /></Field>
                      <Field label="Margem mínima gerada (R$)"><Input inputMode="decimal" aria-label={`${n.label}: margem`} value={(n.margemCents / 100).toFixed(2).replace('.', ',')} onChange={(e) => atualizar(i, { margemCents: centavosDeTexto(e.target.value) ?? 0 })} /></Field>
                      <Field label="Meses com venda"><Input type="number" min={0} aria-label={`${n.label}: meses`} value={texto(n.mesesComVenda)} onChange={(e) => atualizar(i, { mesesComVenda: Number(e.target.value) })} /></Field>
                      <Field label="Vendas recentes" hint="Quantidade mínima de vendas dentro dos últimos 60 dias."><Input type="number" min={0} aria-label={`${n.label}: vendas em 60 dias`} value={texto(n.vendasUltimos60d)} onChange={(e) => atualizar(i, { vendasUltimos60d: Number(e.target.value) })} /></Field>
                      <Field label="Janela de avaliação (dias)" hint="O maior valor entre os níveis define até quando o sistema olha vendas para trás (mínimo 90 dias)."><Input type="number" min={1} placeholder="90" value={texto(n.janelaDias)} onChange={(e) => atualizar(i, { janelaDias: e.target.value ? Number(e.target.value) : null })} /></Field>
                    </div>
                    <p className="pa-aviso">{fraseRequisitos(n)}</p>
                  </div>
                ) : (
                  <p className="pa-aviso">Nível base: todo parceiro aprovado começa aqui, sem meta de vendas.</p>
                )}

                <div className="pa-subgrupo">
                  <h4 className="pa-subgrupo__titulo">Benefícios deste nível</h4>
                  <div className="pa-form__linha">
                    <Field label="Comissão máxima (%)" hint="Percentual máximo da margem que pode ser negociado com parceiros deste nível."><Input inputMode="decimal" aria-label={`${n.label}: comissão máxima`} value={(n.tetoMargemBps / 100).toString().replace('.', ',')} onChange={(e) => atualizar(i, { tetoMargemBps: Math.round((Number(e.target.value.replace(',', '.')) || 0) * 100) })} /></Field>
                    <Field label="Benefício de produto">
                      <Select value={n.beneficio.tipo} onChange={(e) => {
                        const tipo = e.target.value as NivelDeRegra['beneficio']['tipo'];
                        atualizarBeneficio(i, tipo === 'nenhum' ? { tipo } : tipo === 'primeira_peca' ? { tipo, aPartirDeVendas: 10 } : { tipo, aCadaDias: 90 });
                      }}>
                        <option value="nenhum">Sem peça</option>
                        <option value="primeira_peca">1ª peça após N vendas</option>
                        <option value="peca_periodica">Peça a cada N dias</option>
                      </Select>
                    </Field>
                    {n.beneficio.tipo === 'primeira_peca' && (
                      <Field label="A partir de quantas vendas"><Input type="number" min={0} value={texto(n.beneficio.aPartirDeVendas)} onChange={(e) => atualizarBeneficio(i, { tipo: 'primeira_peca', aPartirDeVendas: Number(e.target.value) })} /></Field>
                    )}
                    {n.beneficio.tipo === 'peca_periodica' && (
                      <>
                        <Field label="Frequência do benefício (dias)"><Input type="number" min={1} value={texto(n.beneficio.aCadaDias)} onChange={(e) => atualizarBeneficio(i, { ...n.beneficio, tipo: 'peca_periodica', aCadaDias: Number(e.target.value) })} /></Field>
                        <Field label="Vendas mínimas recentes para receber o benefício" hint="Opcional; deixe em branco para não exigir."><Input type="number" min={0} placeholder="—" value={texto(n.beneficio.exigeVendasUltimos30d)} onChange={(e) => atualizarBeneficio(i, { ...n.beneficio, tipo: 'peca_periodica', exigeVendasUltimos30d: e.target.value ? Number(e.target.value) : undefined })} /></Field>
                      </>
                    )}
                  </div>
                </div>

                <div className="ds-toolbar">
                  <span />
                  <div className="ds-toolbar__end">
                    <Button size="sm" variant="ghost" onClick={cancelarEdicao}>Cancelar</Button>
                    <Button size="sm" onClick={concluirEdicaoDoCard}>Salvar alterações</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {isOwner && linhas.length < MAX_NIVEIS && <div><Button variant="secondary" onClick={adicionar}>+ Adicionar nível</Button></div>}
      <p className="pa-aviso">As metas de cada nível (menos o base) são simultâneas. As regras ficam versionadas por loja: cada gravação é uma versão nova, nunca reescreve vendas já capturadas. O nível nunca reescreve um contrato em vigor — quem decide mudá-lo é você, aqui.</p>
      {isOwner && problemas.length > 0 && <Callout tone="danger" role="alert"><ul className="pa-lista">{problemas.map((p) => <li key={p}>{p}</li>)}</ul></Callout>}
      {isOwner && (
        <div><Button onClick={() => { setEditando(null); setSnapshot(null); setModalSalvar(true); }} disabled={!alterado || problemas.length > 0}>Salvar alterações</Button></div>
      )}

      <ConfirmDialog
        open={trocaPendente !== null} onClose={() => setTrocaPendente(null)} title="Descartar alterações não salvas?"
        description={editando !== null ? `Suas edições em "${linhas[editando]?.label}" ainda não foram salvas. Se continuar, elas serão descartadas.` : undefined}
        confirmLabel="Descartar e continuar" confirmVariant="danger" onConfirm={confirmarTroca}
      />
      <ConfirmDialog
        open={removendo !== null} onClose={() => setRemovendo(null)} title={`Remover o nível "${removendo !== null ? linhas[removendo]?.label : ''}"?`}
        description="A remoção só é gravada quando você salvar as alterações. Se algum parceiro estiver hoje neste nível, o aviso aparece antes de confirmar."
        confirmLabel="Remover nível" confirmVariant="danger" onConfirm={() => { if (removendo !== null) removerDeVerdade(removendo); setRemovendo(null); }}
      />
      <MotivoDialog
        open={modalSalvar} onClose={() => setModalSalvar(false)} titulo="Salvar nova versão das regras?" rotulo="Motivo da alteração"
        descricao="As novas regras valem para as próximas avaliações. Vendas e contratos já registrados não mudam." confirmLabel="Salvar nova versão"
        onConfirm={salvar}
      />
    </div>
  );
}

function ConfiguracaoDaLoja({ isOwner }: { isOwner: boolean }) {
  const { dado, erro, recarregar } = useAsync(() => afiliados.config(), []);
  const [benef, setBenef] = useState('');
  const [minContrib, setMinContrib] = useState('');
  const [contarPor, setContarPor] = useState<'orders' | 'units'>('orders');
  const [grace, setGrace] = useState('');
  const [alertas, setAlertas] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState('');

  useEffect(() => {
    if (!dado) return;
    setBenef(String(dado.benefitBudgetBps / 100).replace('.', ',')); setMinContrib(String(dado.minContributionBps / 100).replace('.', ',')); setContarPor(dado.progressionCountsBy); setGrace(String(dado.downgradeGraceDays)); setAlertas(dado.alertDays.join(', '));
  }, [dado]);

  async function salvar() {
    setEnviando(true); setErroSalvar('');
    try {
      await afiliados.salvarConfig({
        benefitBudgetBps: Math.round((Number(benef.replace(',', '.')) || 0) * 100), minContributionBps: Math.round((Number(minContrib.replace(',', '.')) || 0) * 100), progressionCountsBy: contarPor,
        downgradeGraceDays: Number(grace), alertDays: alertas.split(/[\s,;]+/).filter(Boolean).map(Number),
      });
      toast('Configuração salva.', 'sucesso'); recarregar();
    } catch (e) { setErroSalvar(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  if (erro) return <ErrorState description={erro} onRetry={recarregar} />;
  if (!dado) return <Skeleton rows={3} />;
  return (
    <div className="pa-form">
      <div className="pa-subgrupo">
        <h4 className="pa-subgrupo__titulo">Benefícios</h4>
        <div className="pa-form__linha">
          <Field label="Crédito de benefícios (% da contribuição)" hint="Até esta fração da contribuição pós-parceria positiva e verificada vira crédito na carteira."><Input inputMode="decimal" value={benef} disabled={!isOwner} onChange={(e) => setBenef(e.target.value)} /></Field>
        </div>
      </div>
      <div className="pa-subgrupo">
        <h4 className="pa-subgrupo__titulo">Elegibilidade</h4>
        <div className="pa-form__linha">
          <Field label="Contribuição mínima por item (%)" hint="Alerta de margem — nunca bloqueia o pedido."><Input inputMode="decimal" value={minContrib} disabled={!isOwner} onChange={(e) => setMinContrib(e.target.value)} /></Field>
          <Field label="Progressão conta">
            <Select value={contarPor} disabled={!isOwner} onChange={(e) => setContarPor(e.target.value as typeof contarPor)}><option value="orders">Pedidos elegíveis distintos (padrão)</option><option value="units">Unidades elegíveis</option></Select>
          </Field>
        </div>
      </div>
      <div className="pa-subgrupo">
        <h4 className="pa-subgrupo__titulo">Rebaixamento</h4>
        <div className="pa-form__linha">
          <Field label="Carência de rebaixamento (dias)"><Input type="number" min={0} value={grace} disabled={!isOwner} onChange={(e) => setGrace(e.target.value)} /></Field>
        </div>
      </div>
      <div className="pa-subgrupo">
        <h4 className="pa-subgrupo__titulo">Alertas</h4>
        <div className="pa-form__linha">
          <Field label="Avisos de vencimento (dias antes)" hint="Ex.: 7, 3, 1. Avisos aparecem só aqui, no painel."><Input value={alertas} disabled={!isOwner} onChange={(e) => setAlertas(e.target.value)} /></Field>
        </div>
      </div>
      <p className="pa-aviso">Fuso da loja: {dado.timezone}. Fim de semana não é tratado como feriado: sem calendário confiável, feriados não são calculados.</p>
      {erroSalvar && <Callout tone="danger" role="alert">{erroSalvar}</Callout>}
      {isOwner && <div><Button onClick={salvar} disabled={enviando}>{enviando ? 'Aguarde…' : 'Salvar configuração'}</Button></div>}
    </div>
  );
}

export function NiveisPage() {
  const { isOwner, tz } = useParcerias();
  const regras = useAsync(() => afiliados.regrasDeNivel(), []);
  const propostas = useAsync(() => afiliados.propostasDeNivel('pending'), []);
  const [decidir, setDecidir] = useState<{ p: PropostaDeNivel; decisao: 'approve' | 'dismiss' } | null>(null);
  const [avaliando, setAvaliando] = useState(false);

  async function reavaliar() {
    setAvaliando(true);
    try { const r = await afiliados.avaliarNiveis(); toast(r.propostasCriadas ? `${plural(r.propostasCriadas, 'proposta criada', 'propostas criadas')}.` : 'Nenhuma mudança de nível a propor agora.', 'sucesso'); propostas.recarregar(); }
    catch (e) { toast(mensagemDoErro(e)); } finally { setAvaliando(false); }
  }

  return (
    <PageStack>
      <PageHeader title="Níveis e benefícios" description="Defina como os parceiros evoluem e quais benefícios recebem em cada etapa." actions={isOwner ? <Button variant="secondary" onClick={reavaliar} disabled={avaliando}>{avaliando ? 'Avaliando…' : 'Reavaliar níveis'}</Button> : undefined} />

      <Card title="Propostas de mudança de nível" description="O sistema calcula; quem decide é você. Aprovar altera elegibilidade e benefícios — não reescreve contrato em vigor.">
        {propostas.erro && <ErrorState description={propostas.erro} onRetry={propostas.recarregar} />}
        {propostas.carregando && !propostas.dado && <Skeleton rows={2} />}
        {propostas.dado && !propostas.dado.itens.length && <EmptyState title="Nenhuma proposta pendente" description="Quando um parceiro cumprir as metas do próximo nível (ou deixar de cumprir as do atual depois da carência), a proposta aparece aqui." />}
        {propostas.dado && propostas.dado.itens.length > 0 && (
          <DataTable<PropostaDeNivel>
            label="Propostas pendentes" rows={propostas.dado.itens} rowKey={(p) => p.id}
            columns={[
              { key: 'p', label: 'Parceiro', render: (p) => <Link className="pa-link" to={`/admin/parcerias/parceiros/${p.partnerId}`}>{p.partnerName}</Link> },
              { key: 'm', label: 'Mudança', render: (p) => `${p.fromLevel} → ${p.toLevel} (${p.direction === 'upgrade' ? 'subida' : 'rebaixamento'})` },
              { key: 'v', label: 'Vendas / margem', priority: 'low', render: (p) => `${p.observed.vendasQualificadas} · ${p.observed.margemVerificada ? brl(p.observed.margemCents) : 'não verificada'}` },
              { key: 'e', label: 'Efeito', priority: 'low', render: (p) => `teto de margem ${pct(p.economicEffect.newMarginCapBps)}; contrato não é reescrito` },
              { key: 'c', label: 'Desde', priority: 'low', render: (p) => dataCurta(p.createdAt, tz) },
              { key: 'a', label: 'Ações', align: 'right', render: (p) => (isOwner ? <span className="pa-badges"><Button size="sm" onClick={() => setDecidir({ p, decisao: 'approve' })}>Aprovar</Button><Button size="sm" variant="ghost" onClick={() => setDecidir({ p, decisao: 'dismiss' })}>Descartar</Button></span> : null) },
            ]}
          />
        )}
      </Card>

      <Card title="Seus níveis" description={regras.dado ? `Versão ${regras.dado.padrao ? 'padrão (ainda não personalizada)' : regras.dado.version}.` : undefined}>
        {regras.erro && <ErrorState description={regras.erro} onRetry={regras.recarregar} />}
        {regras.carregando && !regras.dado && <Skeleton rows={4} />}
        {regras.dado && <EditorDeRegras niveis={regras.dado.regras.niveis} isOwner={isOwner} onSalvo={regras.recarregar} />}
      </Card>

      <Card title="Configurações do programa" description="Carteira de benefícios, elegibilidade, rebaixamento e alertas."><ConfiguracaoDaLoja isOwner={isOwner} /></Card>

      <MotivoDialog
        open={!!decidir} onClose={() => setDecidir(null)} titulo={decidir?.decisao === 'approve' ? `Aprovar ${decidir?.p.fromLevel} → ${decidir?.p.toLevel}` : 'Descartar proposta'} obrigatorio={false} rotulo="Observação (opcional)"
        descricao={decidir?.decisao === 'approve' ? 'O nível muda a partir de agora. Comissões de vendas já capturadas e contratos em vigor não mudam.' : 'A proposta some; ela pode ser gerada de novo se as metas continuarem valendo.'}
        onConfirm={async (m) => { if (decidir) { await afiliados.decidirProposta(decidir.p.id, { decision: decidir.decisao, reason: m || undefined }); toast('Proposta decidida.', 'sucesso'); propostas.recarregar(); } }}
      />
    </PageStack>
  );
}
