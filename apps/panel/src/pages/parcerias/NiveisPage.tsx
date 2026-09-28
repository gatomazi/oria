import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, PageStack, Select, Skeleton, Textarea } from '../../components/ds';
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

function descreverBeneficio(b: NivelDeRegra['beneficio']): string {
  if (b.tipo === 'nenhum') return 'Sem peça';
  if (b.tipo === 'primeira_peca') return `1ª peça após ${plural(b.aPartirDeVendas ?? 0, 'venda')}`;
  return `Peça a cada ${plural(b.aCadaDias ?? 0, 'dia')}${b.exigeVendasUltimos30d ? ` · exige ${b.exigeVendasUltimos30d}+ vendas em 30 dias` : ''}`;
}

function EditorDeRegras({ niveis, isOwner, onSalvo }: { niveis: NivelDeRegra[]; isOwner: boolean; onSalvo: () => void }) {
  const [linhas, setLinhas] = useState<NivelDeRegra[]>(niveis);
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [avisoOrfaos, setAvisoOrfaos] = useState<{ key: string; partners: number; exemplo: string }[]>([]);
  useEffect(() => setLinhas(niveis), [niveis]);
  const alterado = JSON.stringify(linhas.map(({ ordem: _ordem, ...resto }) => resto)) !== JSON.stringify(niveis.map(({ ordem: _ordem, ...resto }) => resto));

  const reindexar = (ls: NivelDeRegra[]) => ls.map((n, i) => ({ ...n, ordem: i }));
  const atualizar = (i: number, patch: Partial<NivelDeRegra>) => setLinhas((ls) => reindexar(ls.map((n, j) => (j === i ? { ...n, ...patch } : n))));
  const atualizarBeneficio = (i: number, b: NivelDeRegra['beneficio']) => atualizar(i, { beneficio: b });

  function adicionar() {
    const emUso = new Set(linhas.map((n) => n.key));
    const label = `Nível ${linhas.length + 1}`;
    const ultimo = linhas[linhas.length - 1];
    setLinhas((ls) => reindexar([...ls, {
      key: sugerirChave(label, emUso), label, ordem: ls.length, janelaDias: 90,
      vendasQualificadas: ultimo.vendasQualificadas + 10, margemCents: ultimo.margemCents + 15000, mesesComVenda: 0, vendasUltimos60d: 0,
      tetoMargemBps: Math.min(10000, ultimo.tetoMargemBps + 500), beneficio: { tipo: 'nenhum' },
    }]));
  }
  function remover(i: number) { if (i > 0 && linhas.length > MIN_NIVEIS) setLinhas((ls) => reindexar(ls.filter((_, j) => j !== i))); }
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

  async function salvar() {
    setEnviando(true); setErro(''); setAvisoOrfaos([]);
    try {
      const r = await afiliados.salvarRegrasDeNivel({ niveis: linhas }, motivo.trim());
      toast('Regras de nível salvas em nova versão.', 'sucesso'); setMotivo(''); setAvisoOrfaos(r.avisos.niveisOrfaos); onSalvo();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <div className="pa-form">
      {linhas.map((n, i) => (
        <div key={i} className="pa-shell pa-mb-5">
          <div className="ds-toolbar">
            <Field label="Nome do nível"><Input value={n.label} disabled={!isOwner} maxLength={60} onChange={(e) => atualizar(i, { label: e.target.value })} style={{ minWidth: 180 }} /></Field>
            <Field label="Chave interna" hint="Identifica o nível entre versões; parceiros já neste nível avisam se ela sumir."><Input value={n.key} disabled={!isOwner} onChange={(e) => atualizar(i, { key: e.target.value.trim().toLowerCase() })} style={{ minWidth: 140 }} /></Field>
            {i === 0 && <span className="pa-aviso">Nível base — todo parceiro aprovado começa aqui; metas não se aplicam.</span>}
            {isOwner && (
              <div className="ds-toolbar__end">
                <Button size="sm" variant="ghost" disabled={i <= 1} onClick={() => mover(i, -1)} aria-label={`Mover ${n.label} para cima`}>↑</Button>
                <Button size="sm" variant="ghost" disabled={i === 0 || i === linhas.length - 1} onClick={() => mover(i, 1)} aria-label={`Mover ${n.label} para baixo`}>↓</Button>
                <Button size="sm" variant="ghost" disabled={i === 0 || linhas.length <= MIN_NIVEIS} onClick={() => remover(i)}>Remover</Button>
              </div>
            )}
          </div>
          {i > 0 && (
            <div className="pa-form__linha">
              <Field label="Vendas qualificadas"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: vendas qualificadas`} value={texto(n.vendasQualificadas)} disabled={!isOwner} onChange={(e) => atualizar(i, { vendasQualificadas: Number(e.target.value) })} /></Field>
              <Field label="Margem verificada (R$)"><Input inputMode="decimal" controlSize="sm" aria-label={`${n.label}: margem`} value={(n.margemCents / 100).toFixed(2).replace('.', ',')} disabled={!isOwner} onChange={(e) => atualizar(i, { margemCents: centavosDeTexto(e.target.value) ?? 0 })} /></Field>
              <Field label="Meses com venda"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: meses`} value={texto(n.mesesComVenda)} disabled={!isOwner} onChange={(e) => atualizar(i, { mesesComVenda: Number(e.target.value) })} /></Field>
              <Field label="Vendas em 60 dias"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: vendas em 60 dias`} value={texto(n.vendasUltimos60d)} disabled={!isOwner} onChange={(e) => atualizar(i, { vendasUltimos60d: Number(e.target.value) })} /></Field>
              <Field label="Janela (dias)" hint="O maior valor entre os níveis define até quando o sistema olha vendas para trás (mínimo 90 dias)."><Input type="number" min={1} controlSize="sm" placeholder="90" value={texto(n.janelaDias)} disabled={!isOwner} onChange={(e) => atualizar(i, { janelaDias: e.target.value ? Number(e.target.value) : null })} /></Field>
            </div>
          )}
          <div className="pa-form__linha">
            <Field label="Teto sobre margem (%)"><Input inputMode="decimal" controlSize="sm" aria-label={`${n.label}: teto`} value={(n.tetoMargemBps / 100).toString().replace('.', ',')} disabled={!isOwner} onChange={(e) => atualizar(i, { tetoMargemBps: Math.round((Number(e.target.value.replace(',', '.')) || 0) * 100) })} /></Field>
            <Field label="Peça / benefício">
              <Select controlSize="sm" value={n.beneficio.tipo} disabled={!isOwner} onChange={(e) => {
                const tipo = e.target.value as NivelDeRegra['beneficio']['tipo'];
                atualizarBeneficio(i, tipo === 'nenhum' ? { tipo } : tipo === 'primeira_peca' ? { tipo, aPartirDeVendas: 10 } : { tipo, aCadaDias: 90 });
              }}>
                <option value="nenhum">Sem peça</option>
                <option value="primeira_peca">1ª peça após N vendas</option>
                <option value="peca_periodica">Peça a cada N dias</option>
              </Select>
            </Field>
            {n.beneficio.tipo === 'primeira_peca' && (
              <Field label="A partir de quantas vendas"><Input type="number" min={0} controlSize="sm" value={texto(n.beneficio.aPartirDeVendas)} disabled={!isOwner} onChange={(e) => atualizarBeneficio(i, { tipo: 'primeira_peca', aPartirDeVendas: Number(e.target.value) })} /></Field>
            )}
            {n.beneficio.tipo === 'peca_periodica' && (
              <>
                <Field label="A cada quantos dias"><Input type="number" min={1} controlSize="sm" value={texto(n.beneficio.aCadaDias)} disabled={!isOwner} onChange={(e) => atualizarBeneficio(i, { ...n.beneficio, tipo: 'peca_periodica', aCadaDias: Number(e.target.value) })} /></Field>
                <Field label="Exige vendas nos últimos 30 dias" hint="Opcional; deixe em branco para não exigir."><Input type="number" min={0} controlSize="sm" placeholder="—" value={texto(n.beneficio.exigeVendasUltimos30d)} disabled={!isOwner} onChange={(e) => atualizarBeneficio(i, { ...n.beneficio, tipo: 'peca_periodica', exigeVendasUltimos30d: e.target.value ? Number(e.target.value) : undefined })} /></Field>
              </>
            )}
          </div>
          <p className="pa-aviso">{descreverBeneficio(n.beneficio)}</p>
        </div>
      ))}
      {isOwner && linhas.length < MAX_NIVEIS && <div><Button variant="secondary" onClick={adicionar}>+ Adicionar nível</Button></div>}
      <p className="pa-aviso">As metas de cada nível (menos o base) são simultâneas. As regras ficam versionadas por loja: cada gravação é uma versão nova, nunca reescreve vendas já capturadas. O nível nunca reescreve um contrato em vigor — quem decide muda-lo é você, aqui.</p>
      {isOwner && (
        <>
          {problemas.length > 0 && <Callout tone="danger" role="alert"><ul className="pa-lista">{problemas.map((p) => <li key={p}>{p}</li>)}</ul></Callout>}
          {avisoOrfaos.length > 0 && (
            <Callout tone="warning">
              <ul className="pa-lista">{avisoOrfaos.map((a) => <li key={a.key}>{plural(a.partners, 'parceiro está', 'parceiros estão')} no nível "{a.key}" (ex.: {a.exemplo}), que não existe mais nesta versão — {a.partners === 1 ? 'ele' : 'eles'} volta{a.partners === 1 ? '' : 'm'} para o nível base até a próxima proposta.</li>)}</ul>
            </Callout>
          )}
          <Field label="Motivo da alteração" hint="Obrigatório para gravar uma nova versão das regras."><Textarea rows={2} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
          {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
          <div><Button onClick={salvar} disabled={enviando || !alterado || !motivo.trim() || problemas.length > 0}>{enviando ? 'Aguarde…' : 'Salvar nova versão das regras'}</Button></div>
        </>
      )}
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
      <div className="pa-form__linha">
        <Field label="Crédito de benefícios (% da contribuição)" hint="Até esta fração da contribuição pós-parceria positiva e verificada vira crédito na carteira."><Input inputMode="decimal" value={benef} disabled={!isOwner} onChange={(e) => setBenef(e.target.value)} /></Field>
        <Field label="Contribuição mínima por item (%)" hint="Alerta de margem — nunca bloqueia o pedido."><Input inputMode="decimal" value={minContrib} disabled={!isOwner} onChange={(e) => setMinContrib(e.target.value)} /></Field>
        <Field label="Progressão conta">
          <Select value={contarPor} disabled={!isOwner} onChange={(e) => setContarPor(e.target.value as typeof contarPor)}><option value="orders">Pedidos elegíveis distintos (padrão)</option><option value="units">Unidades elegíveis</option></Select>
        </Field>
        <Field label="Carência de rebaixamento (dias)"><Input type="number" min={0} value={grace} disabled={!isOwner} onChange={(e) => setGrace(e.target.value)} /></Field>
        <Field label="Avisos de vencimento (dias antes)" hint="Ex.: 7, 3, 1. Avisos aparecem só aqui, no painel."><Input value={alertas} disabled={!isOwner} onChange={(e) => setAlertas(e.target.value)} /></Field>
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
      <PageHeader title="Níveis e benefícios" description="Metas simultâneas, propostas que dependem da sua aprovação e uma carteira de benefícios separada das comissões." actions={isOwner ? <Button variant="secondary" onClick={reavaliar} disabled={avaliando}>{avaliando ? 'Avaliando…' : 'Reavaliar níveis'}</Button> : undefined} />

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

      <Card title="Regras de nível" description={regras.dado ? `Versão ${regras.dado.padrao ? 'padrão (ainda não personalizada)' : regras.dado.version}` : undefined}>
        {regras.erro && <ErrorState description={regras.erro} onRetry={regras.recarregar} />}
        {regras.carregando && !regras.dado && <Skeleton rows={4} />}
        {regras.dado && <EditorDeRegras niveis={regras.dado.regras.niveis} isOwner={isOwner} onSalvo={regras.recarregar} />}
      </Card>

      <Card title="Configuração da loja" description="Carteira de benefícios, alertas e contagem para progressão."><ConfiguracaoDaLoja isOwner={isOwner} /></Card>

      <MotivoDialog
        open={!!decidir} onClose={() => setDecidir(null)} titulo={decidir?.decisao === 'approve' ? `Aprovar ${decidir?.p.fromLevel} → ${decidir?.p.toLevel}` : 'Descartar proposta'} obrigatorio={false} rotulo="Observação (opcional)"
        descricao={decidir?.decisao === 'approve' ? 'O nível muda a partir de agora. Comissões de vendas já capturadas e contratos em vigor não mudam.' : 'A proposta some; ela pode ser gerada de novo se as metas continuarem valendo.'}
        onConfirm={async (m) => { if (decidir) { await afiliados.decidirProposta(decidir.p.id, { decision: decidir.decisao, reason: m || undefined }); toast('Proposta decidida.', 'sucesso'); propostas.recarregar(); } }}
      />
    </PageStack>
  );
}
