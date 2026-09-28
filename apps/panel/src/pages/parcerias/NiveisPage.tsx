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

function EditorDeRegras({ niveis, isOwner, onSalvo }: { niveis: NivelDeRegra[]; isOwner: boolean; onSalvo: () => void }) {
  const [linhas, setLinhas] = useState<NivelDeRegra[]>(niveis);
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  useEffect(() => setLinhas(niveis), [niveis]);
  const alterado = JSON.stringify(linhas) !== JSON.stringify(niveis);

  const set = (i: number, campo: keyof NivelDeRegra, valor: number) => setLinhas((l) => l.map((n, j) => (j === i ? { ...n, [campo]: valor } : n)));
  async function salvar() {
    setEnviando(true); setErro('');
    try { await afiliados.salvarRegrasDeNivel({ niveis: linhas }, motivo.trim()); toast('Regras de nível salvas em nova versão.', 'sucesso'); setMotivo(''); onSalvo(); }
    catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <div className="pa-form">
      <div className="ds-table-wrap">
        <table className="ds-table" aria-label="Regras de nível">
          <thead><tr><th>Nível</th><th className="pa-right">Vendas qualificadas</th><th className="pa-right">Margem verificada (R$)</th><th className="pa-right">Meses com venda</th><th className="pa-right">Vendas em 60 dias</th><th className="pa-right">Teto sobre margem (%)</th><th>Benefício</th></tr></thead>
          <tbody>
            {linhas.map((n, i) => (
              <tr key={n.key}>
                <td><strong>{n.label}</strong></td>
                <td className="pa-right"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: vendas qualificadas`} value={texto(n.vendasQualificadas)} disabled={!isOwner || n.ordem === 0} onChange={(e) => set(i, 'vendasQualificadas', Number(e.target.value))} /></td>
                <td className="pa-right"><Input inputMode="decimal" controlSize="sm" aria-label={`${n.label}: margem`} value={(n.margemCents / 100).toFixed(2).replace('.', ',')} disabled={!isOwner || n.ordem === 0} onChange={(e) => set(i, 'margemCents', centavosDeTexto(e.target.value) ?? 0)} /></td>
                <td className="pa-right"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: meses`} value={texto(n.mesesComVenda)} disabled={!isOwner || n.ordem === 0} onChange={(e) => set(i, 'mesesComVenda', Number(e.target.value))} /></td>
                <td className="pa-right"><Input type="number" min={0} controlSize="sm" aria-label={`${n.label}: vendas em 60 dias`} value={texto(n.vendasUltimos60d)} disabled={!isOwner || n.ordem === 0} onChange={(e) => set(i, 'vendasUltimos60d', Number(e.target.value))} /></td>
                <td className="pa-right"><Input inputMode="decimal" controlSize="sm" aria-label={`${n.label}: teto`} value={(n.tetoMargemBps / 100).toString().replace('.', ',')} disabled={!isOwner} onChange={(e) => set(i, 'tetoMargemBps', Math.round((Number(e.target.value.replace(',', '.')) || 0) * 100))} /></td>
                <td>{n.beneficio.tipo === 'nenhum' ? 'Sem peça' : n.beneficio.tipo === 'primeira_peca' ? `1ª peça após ${plural(n.beneficio.aPartirDeVendas ?? 0, 'venda')}` : `Peça a cada ${plural(n.beneficio.aCadaDias ?? 0, 'dia')}${n.beneficio.exigeVendasUltimos30d ? ` com ${n.beneficio.exigeVendasUltimos30d}+ vendas em 30 dias` : ''}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pa-aviso">As metas são simultâneas e as regras ficam versionadas por loja. Os números acima são o padrão sugerido para o piloto — não uma promessa de percentual. O nível nunca reescreve um contrato em vigor.</p>
      {isOwner && (
        <>
          <Field label="Motivo da alteração" hint="Obrigatório para gravar uma nova versão das regras."><Textarea rows={2} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
          {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
          <div><Button onClick={salvar} disabled={enviando || !alterado || !motivo.trim()}>{enviando ? 'Aguarde…' : 'Salvar nova versão das regras'}</Button></div>
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
