import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Callout, Checkbox, Field, Input, Modal, Select, Skeleton, Textarea } from '../../components/ds';
import type { ButtonVariant } from '../../components/ds';
import {
  afiliados, type Contrato, type LancamentoDoExtrato, type Lote, type Modalidade, type SimulacaoContrato, type TermosDeContrato, type VersaoContrato,
} from '../../api/afiliados';
import { toast } from '../../lib/toast';
import {
  ROTULOS_BASE_COMISSAO, ROTULOS_METODO, ROTULOS_POLITICA_CONFLITO, bpsDeTexto, brl, centavosDeTexto, dataCurta, hojeNoFuso, mensagemDoErro, novaChave, pct, plural, resumoInkDoFechamento,
} from '../../lib/parcerias';

// Diálogos de ação do módulo. Nada é dado como feito antes de a API responder com sucesso: o botão fica "Aguarde…" e erros voltam na própria tela.

function useEnvio() {
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  async function executar(fn: () => Promise<unknown>): Promise<boolean> {
    setEnviando(true);
    setErro('');
    try { await fn(); return true; } catch (err) { setErro(mensagemDoErro(err)); return false; } finally { setEnviando(false); }
  }
  return { enviando, erro, setErro, executar };
}

// ── Motivo obrigatório ─────────────────────────────────────────────────────────────────────────
export function MotivoDialog({
  open, onClose, titulo, descricao, confirmLabel = 'Confirmar', confirmVariant = 'primary', rotulo = 'Motivo', obrigatorio = true, onConfirm,
}: {
  open: boolean; onClose: () => void; titulo: string; descricao?: ReactNode; confirmLabel?: string; confirmVariant?: ButtonVariant; rotulo?: string; obrigatorio?: boolean;
  onConfirm: (motivo: string) => Promise<unknown>;
}) {
  const [motivo, setMotivo] = useState('');
  const { enviando, erro, executar, setErro } = useEnvio();
  useEffect(() => { if (open) { setMotivo(''); setErro(''); } }, [open, setErro]);
  return (
    <Modal
      open={open} onClose={() => { if (!enviando) onClose(); }} title={titulo} confirmLabel={enviando ? 'Aguarde…' : confirmLabel} confirmVariant={confirmVariant}
      confirmDisabled={enviando || (obrigatorio && !motivo.trim())}
      onConfirm={async () => { if (await executar(() => onConfirm(motivo.trim()))) onClose(); }}
    >
      <div className="pa-form">
        {descricao && <p className="pa-aviso">{descricao}</p>}
        <Field label={rotulo} required={obrigatorio} hint="Fica registrado na auditoria.">
          <Textarea rows={3} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

// ── Contrato (novo ou nova versão) ────────────────────────────────────────────────────────────
interface TermosForm {
  commissionBasis: TermosDeContrato['commissionBasis']; percentual: string; fixoPorUnidade: string; cache: string; conflictPolicy: NonNullable<TermosDeContrato['conflictPolicy']>; splitCollab: string;
  dualConfirmado: boolean; holdDias: string; diaPagamento: string; mesesAte: string; minimo: string; acumula: boolean; fimDeSemana: boolean; overrideTeto: string; notas: string;
}

function formDeVersao(v?: VersaoContrato): TermosForm {
  return {
    commissionBasis: v?.commissionBasis ?? 'verified_margin_percent',
    percentual: v?.commissionBps != null ? String(v.commissionBps / 100).replace('.', ',') : '',
    fixoPorUnidade: v?.fixedPerUnitCents != null ? (v.fixedPerUnitCents / 100).toFixed(2).replace('.', ',') : '',
    cache: v?.fixedCampaignFeeCents != null ? (v.fixedCampaignFeeCents / 100).toFixed(2).replace('.', ',') : '',
    conflictPolicy: v?.conflictPolicy ?? 'collab_precedence', splitCollab: v?.splitCollabBps != null ? String(v.splitCollabBps / 100).replace('.', ',') : '70',
    dualConfirmado: false, holdDias: String(v?.releaseHoldDays ?? 7), diaPagamento: String(v?.payoutDay ?? 10), mesesAte: String(v?.payoutMonthOffset ?? 1),
    minimo: v ? (v.minPayoutCents / 100).toFixed(2).replace('.', ',') : '50,00', acumula: v?.accumulateBelowMin ?? true, fimDeSemana: v?.weekendShift ?? true,
    overrideTeto: v?.levelCapOverrideReason ?? '', notas: v?.notes ?? '',
  };
}

function termosDoForm(f: TermosForm): TermosDeContrato {
  const t: TermosDeContrato = { commissionBasis: f.commissionBasis };
  if (f.commissionBasis === 'fixed_per_unit') t.fixedPerUnitCents = centavosDeTexto(f.fixoPorUnidade) ?? undefined;
  else t.commissionBps = bpsDeTexto(f.percentual) ?? undefined;
  const cache = centavosDeTexto(f.cache);
  if (cache !== null) t.fixedCampaignFeeCents = cache;
  t.conflictPolicy = f.conflictPolicy;
  if (f.conflictPolicy === 'split_explicit') { t.splitCollabBps = bpsDeTexto(f.splitCollab) ?? undefined; t.dualCommissionConfirmed = f.dualConfirmado; }
  t.releaseHoldDays = Number(f.holdDias);
  t.payoutDay = Number(f.diaPagamento);
  t.payoutMonthOffset = Number(f.mesesAte);
  t.minPayoutCents = centavosDeTexto(f.minimo) ?? 0;
  t.accumulateBelowMin = f.acumula;
  t.weekendShift = f.fimDeSemana;
  if (f.overrideTeto.trim()) t.levelCapOverrideReason = f.overrideTeto.trim();
  if (f.notas.trim()) t.notes = f.notas.trim();
  return t;
}

export function ContratoDialog({
  open, onClose, partnerId, contrato, isOwner, onSalvo,
}: { open: boolean; onClose: () => void; partnerId: string; contrato?: Contrato | null; isOwner: boolean; onSalvo: () => void }) {
  const nova = !!contrato;
  const [titulo, setTitulo] = useState('');
  const [modalidade, setModalidade] = useState<Modalidade>('coupon');
  const [status, setStatus] = useState<'draft' | 'active' | 'paused' | 'ended'>('draft');
  const [f, setF] = useState<TermosForm>(formDeVersao());
  const [motivo, setMotivo] = useState('');
  const [simulacao, setSimulacao] = useState<SimulacaoContrato | null>(null);
  const [simulando, setSimulando] = useState(false);
  const { enviando, erro, executar, setErro } = useEnvio();

  useEffect(() => {
    if (!open) return;
    setTitulo(contrato?.title ?? '');
    setModalidade(contrato?.modality ?? 'coupon');
    setStatus(contrato?.current.status ?? 'draft');
    setF(formDeVersao(contrato?.current));
    setMotivo(''); setSimulacao(null); setErro('');
  }, [open, contrato, setErro]);

  const set = <K extends keyof TermosForm>(k: K, v: TermosForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const termos = useMemo(() => termosDoForm(f), [f]);

  async function simular() {
    setSimulando(true); setErro('');
    try {
      setSimulacao(await afiliados.simularContrato({
        comparar: [
          { commissionBasis: 'verified_margin_percent', commissionBps: termos.commissionBps ?? 1500 },
          { commissionBasis: 'net_item_revenue_percent', commissionBps: termos.commissionBps ?? 1000 },
          ...(termos.fixedPerUnitCents ? [{ commissionBasis: 'fixed_per_unit', fixedPerUnitCents: termos.fixedPerUnitCents }] : []),
        ],
      }));
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setSimulando(false); }
  }

  const valido = titulo.trim().length > 0 && motivo.trim().length > 0
    && (f.commissionBasis === 'fixed_per_unit' ? termos.fixedPerUnitCents !== undefined : termos.commissionBps !== undefined);

  async function salvar() {
    const ok = await executar(async () => {
      if (nova && contrato) {
        const r = await afiliados.novaVersao(contrato.id, { status, reason: motivo.trim(), terms: termos });
        if (r.cupons) toast(`Contrato encerrado · ${plural(r.cupons.encerrados, 'cupom vinculado encerrado', 'cupons vinculados encerrados')}${resumoInkDoFechamento(r.cupons.ink).texto ? ` · ${resumoInkDoFechamento(r.cupons.ink).texto}` : ''}.`, resumoInkDoFechamento(r.cupons.ink).ok ? 'sucesso' : 'erro');
      } else {
        await afiliados.criarContrato({ partnerId, modality: modalidade, title: titulo.trim(), status: status === 'active' ? 'active' : 'draft', reason: motivo.trim(), terms: termos });
      }
    });
    if (ok) { toast(nova ? 'Nova versão do contrato registrada.' : 'Contrato criado.', 'sucesso'); onSalvo(); onClose(); }
  }

  return (
    <Modal
      open={open} onClose={() => { if (!enviando) onClose(); }} title={nova ? `Nova versão · ${contrato?.title}` : 'Novo contrato'} maxWidth={720}
      confirmLabel={enviando ? 'Aguarde…' : (nova ? 'Registrar versão' : 'Criar contrato')} confirmDisabled={enviando || !valido} onConfirm={salvar}
    >
      <div className="pa-form">
        <p className="pa-aviso">Cada mudança vira uma <strong>nova versão</strong>: a versão anterior e as comissões já capturadas nunca são reescritas. A vigência começa agora.</p>
        {!nova && (
          <div className="pa-form__linha">
            <Field label="Título do contrato" required><Input value={titulo} maxLength={160} onChange={(e) => setTitulo(e.target.value)} /></Field>
            <Field label="Modalidade" required hint="Uma pessoa pode ter vários contratos; não crie outro perfil só por mudar de modalidade.">
              <Select value={modalidade} onChange={(e) => setModalidade(e.target.value as Modalidade)}>
                <option value="coupon">Cupom</option><option value="collab">Collab (por estampa)</option><option value="hybrid">Híbrida (cupom + collab)</option>
              </Select>
            </Field>
          </div>
        )}
        <div className="pa-form__linha">
          <Field label="Base da comissão" required hint="A base fica rotulada em todas as telas: percentual de receita e de margem nunca se misturam.">
            <Select value={f.commissionBasis} onChange={(e) => set('commissionBasis', e.target.value as TermosForm['commissionBasis'])}>
              {(Object.keys(ROTULOS_BASE_COMISSAO) as (keyof typeof ROTULOS_BASE_COMISSAO)[]).map((k) => <option key={k} value={k}>{ROTULOS_BASE_COMISSAO[k]}</option>)}
            </Select>
          </Field>
          {f.commissionBasis === 'fixed_per_unit'
            ? <Field label="Valor por unidade (R$)" required><Input inputMode="decimal" value={f.fixoPorUnidade} onChange={(e) => set('fixoPorUnidade', e.target.value)} placeholder="5,00" /></Field>
            : <Field label="Percentual (%)" required><Input inputMode="decimal" value={f.percentual} onChange={(e) => set('percentual', e.target.value)} placeholder="15" /></Field>}
          <Field label="Cachê por conteúdo (R$)" optional hint="Categoria separada de comissão por venda."><Input inputMode="decimal" value={f.cache} onChange={(e) => set('cache', e.target.value)} placeholder="0,00" /></Field>
        </div>
        <p className="pa-aviso">
          {f.commissionBasis === 'verified_margin_percent'
            ? 'Margem = receita líquida do item (após descontos) − custo de produção da INK. Não inclui taxas nem impostos.'
            : f.commissionBasis === 'net_item_revenue_percent' ? 'Receita líquida = valor do item após o desconto rateado; frete nunca entra na base.' : 'Pago por unidade elegível (unidades devolvidas não contam).'}
        </p>

        <div className="pa-form__linha">
          <Field label="Conflito collab × cupom no mesmo item">
            <Select value={f.conflictPolicy} onChange={(e) => set('conflictPolicy', e.target.value as TermosForm['conflictPolicy'])}>
              {(Object.keys(ROTULOS_POLITICA_CONFLITO) as (keyof typeof ROTULOS_POLITICA_CONFLITO)[]).map((k) => <option key={k} value={k}>{ROTULOS_POLITICA_CONFLITO[k]}</option>)}
            </Select>
          </Field>
          {f.conflictPolicy === 'split_explicit' && (
            <>
              <Field label="Fatia da collab (%)" hint="O restante vai para o cupom."><Input inputMode="decimal" value={f.splitCollab} onChange={(e) => set('splitCollab', e.target.value)} /></Field>
              <Checkbox label="Confirmo pagar comissão dupla na mesma linha" description="Exige confirmação administrativa; o custo total entra na simulação." checked={f.dualConfirmado} onChange={(e) => set('dualConfirmado', e.target.checked)} />
            </>
          )}
        </div>

        <div className="pa-form__linha">
          <Field label="Carência após a entrega (dias)"><Input type="number" min={0} max={365} value={f.holdDias} onChange={(e) => set('holdDias', e.target.value)} /></Field>
          <Field label="Dia do pagamento (1–28)"><Input type="number" min={1} max={28} value={f.diaPagamento} onChange={(e) => set('diaPagamento', e.target.value)} /></Field>
          <Field label="Meses depois da liberação" hint="1 = mês seguinte."><Input type="number" min={0} max={12} value={f.mesesAte} onChange={(e) => set('mesesAte', e.target.value)} /></Field>
          <Field label="Mínimo para repasse (R$)"><Input inputMode="decimal" value={f.minimo} onChange={(e) => set('minimo', e.target.value)} /></Field>
        </div>
        <div className="pa-form__linha">
          <Checkbox label="Acumular saldo abaixo do mínimo" checked={f.acumula} onChange={(e) => set('acumula', e.target.checked)} />
          <Checkbox label="Vencimento em fim de semana vai para segunda" description="Sem calendário de feriados." checked={f.fimDeSemana} onChange={(e) => set('fimDeSemana', e.target.checked)} />
        </div>

        <Field label="Motivo do override do teto do nível" optional hint="Só é exigido se a remuneração passar do teto do nível do parceiro (margem: Raiz 15%, Voz 20%, Referência 25%, Embaixador 30%).">
          <Input value={f.overrideTeto} maxLength={500} onChange={(e) => set('overrideTeto', e.target.value)} />
        </Field>
        <Field label="Observações" optional><Textarea rows={2} value={f.notas} maxLength={4000} onChange={(e) => set('notas', e.target.value)} /></Field>

        {isOwner && (
          <Field label="Estado da versão" hint="Rascunho não remunera. Ativo passa a valer a partir de agora (exige owner).">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="draft">Rascunho</option><option value="active">Ativo</option>{nova && <option value="paused">Pausado</option>}{nova && <option value="ended">Encerrado</option>}
            </Select>
          </Field>
        )}
        <Field label="Motivo da alteração" required hint="Fica no histórico imutável do contrato."><Input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>

        <div>
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={simular} disabled={simulando}>{simulando ? 'Simulando…' : 'Simular contra as vendas recentes'}</button>
        </div>
        {simulando && <Skeleton rows={2} />}
        {simulacao && (
          <div className="pa-form">
            <p className="pa-aviso">{simulacao.aviso} Amostra: {simulacao.amostra.pedidos} pedidos · {simulacao.amostra.unidades} unidades · receita {brl(simulacao.amostra.receitaCents)} · margem {brl(simulacao.amostra.margemCents)}.</p>
            <table className="ds-table" aria-label="Simulação comparativa">
              <thead><tr><th>Base</th><th className="pa-right">Comissão na amostra</th><th className="pa-right">Equivale a % da margem</th><th>Teto do nível</th></tr></thead>
              <tbody>
                {simulacao.alternativas.map((a, i) => (
                  <tr key={i}>
                    <td>{a.rotulo}{a.commissionBps != null ? ` · ${pct(a.commissionBps)}` : ''}</td>
                    <td className="pa-right pa-num">{brl(a.comissaoNaAmostraCents)}</td>
                    <td className="pa-right pa-num">{a.equivalenteMargemBps == null ? 'sem amostra' : pct(a.equivalenteMargemBps)}</td>
                    <td>{a.dentroDoTeto === null ? 'não verificável' : a.dentroDoTeto ? `dentro (${pct(a.tetoMargemBps)})` : `acima de ${pct(a.tetoMargemBps)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

// ── Cupom manual ───────────────────────────────────────────────────────────────────────────────
export function CupomDialog({
  open, onClose, partnerId, contratos, onSalvo,
}: { open: boolean; onClose: () => void; partnerId: string; contratos: Contrato[]; onSalvo: () => void }) {
  const elegiveis = contratos.filter((c) => c.modality !== 'collab');
  const [contractId, setContractId] = useState('');
  const [codigo, setCodigo] = useState('');
  const [tipo, setTipo] = useState<'percentage' | 'value' | ''>('percentage');
  const [desconto, setDesconto] = useState('');
  const [ate, setAte] = useState('');
  const { enviando, erro, executar, setErro } = useEnvio();
  useEffect(() => { if (open) { setContractId(elegiveis[0]?.id ?? ''); setCodigo(''); setTipo('percentage'); setDesconto(''); setAte(''); setErro(''); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const valido = !!contractId && /^[A-Za-z0-9_-]{3,32}$/.test(codigo.trim());
  async function salvar() {
    const ok = await executar(async () => {
      await afiliados.criarCupom({
        partnerId, contractId, code: codigo.trim(), ...(tipo === 'percentage' && desconto ? { discountKind: 'percentage' as const, discountBps: bpsDeTexto(desconto) ?? undefined }
          : tipo === 'value' && desconto ? { discountKind: 'value' as const, discountCents: centavosDeTexto(desconto) ?? undefined } : {}),
        ...(ate ? { validUntil: new Date(`${ate}T23:59:59-03:00`).toISOString() } : {}),
      });
    });
    if (ok) { toast('Cupom cadastrado. Ele só comissiona depois de ativado.', 'sucesso'); onSalvo(); onClose(); }
  }

  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Cadastrar cupom" confirmLabel={enviando ? 'Aguarde…' : 'Cadastrar'} confirmDisabled={enviando || !valido} onConfirm={salvar} maxWidth={560}>
      <div className="pa-form">
        {!elegiveis.length && <Callout tone="warning">Crie antes um contrato de cupom (ou híbrido) para este parceiro.</Callout>}
        <Callout tone="info" title="Cupom comum da INK">
          O código precisa existir como <strong>promoção comum</strong> na INK (criada no painel da INK). O Oria só calcula comissão sobre pedidos que trazem esse código; a criação automática na INK está desligada nesta versão.
        </Callout>
        <Field label="Contrato" required>
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>{elegiveis.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select>
        </Field>
        <Field label="Código do cupom" required hint="3–32 caracteres: letras, números, _ e -. Maiúsculas/minúsculas são equivalentes."><Input value={codigo} maxLength={32} onChange={(e) => setCodigo(e.target.value)} /></Field>
        <div className="pa-form__linha">
          <Field label="Desconto ao cliente" optional>
            <Select value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}><option value="percentage">Percentual</option><option value="value">Valor fixo</option><option value="">Não informar</option></Select>
          </Field>
          {tipo && <Field label={tipo === 'percentage' ? 'Desconto (%)' : 'Desconto (R$)'}><Input inputMode="decimal" value={desconto} onChange={(e) => setDesconto(e.target.value)} /></Field>}
          <Field label="Válido até" optional><Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></Field>
        </div>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

// ── Registrar pagamento (parcial ou total, com rateio explícito) ────────────────────────────────
export function PagamentoDialog({
  open, onClose, partnerId, partnerName, tz, lote, onRegistrado,
}: { open: boolean; onClose: () => void; partnerId: string; partnerName: string; tz: string; lote?: Lote | null; onRegistrado: () => void }) {
  const [entradas, setEntradas] = useState<LancamentoDoExtrato[] | null>(null);
  const [marcadas, setMarcadas] = useState<Record<string, boolean>>({});
  const [valores, setValores] = useState<Record<string, string>>({});
  const [paidAt, setPaidAt] = useState(hojeNoFuso(tz));
  const [metodo, setMetodo] = useState<'pix' | 'transfer' | 'other'>('pix');
  const [referencia, setReferencia] = useState('');
  const [comprovante, setComprovante] = useState('');
  const [obs, setObs] = useState('');
  const [etapa, setEtapa] = useState<'form' | 'confirmar'>('form');
  const [chave, setChave] = useState(novaChave());
  const [recibo, setRecibo] = useState<NonNullable<Awaited<ReturnType<typeof afiliados.registrarPagamento>>['recibo']> | null>(null);
  const { enviando, erro, executar, setErro } = useEnvio();

  useEffect(() => {
    if (!open) return;
    setEntradas(null); setEtapa('form'); setRecibo(null); setChave(novaChave()); setErro('');
    setPaidAt(hojeNoFuso(tz)); setMetodo('pix'); setReferencia(''); setComprovante(''); setObs('');
    afiliados.extrato(partnerId, { limit: 200 }).then((r) => {
      const abertas = r.itens.filter((i) => i.status === 'released' && i.openCents !== 0);
      setEntradas(abertas);
      setMarcadas(Object.fromEntries(abertas.map((i) => [i.id, true])));
      setValores(Object.fromEntries(abertas.map((i) => [i.id, (Math.abs(i.openCents) / 100).toFixed(2).replace('.', ',')])));
    }).catch((e) => setErro(mensagemDoErro(e)));
  }, [open, partnerId, tz, setErro]);

  const linhas = useMemo(() => (entradas ?? []).filter((e) => marcadas[e.id]).map((e) => {
    const digitado = centavosDeTexto(valores[e.id] ?? '');
    const sinal = e.openCents < 0 ? -1 : 1;
    const valor = digitado === null ? null : sinal * Math.abs(digitado);
    return { e, valor, excede: valor !== null && Math.abs(valor) > Math.abs(e.openCents), invalido: valor === null || valor === 0 };
  }), [entradas, marcadas, valores]);

  const total = linhas.reduce((s, l) => s + (l.valor ?? 0), 0);
  const saldoAberto = (entradas ?? []).reduce((s, e) => s + e.openCents, 0);
  const restante = saldoAberto - total;
  const invalido = linhas.length === 0 || linhas.some((l) => l.invalido || l.excede) || total <= 0 || !paidAt;
  const parcial = restante > 0;

  async function registrar() {
    const ok = await executar(async () => {
      const r = await afiliados.registrarPagamento({
        partnerId, batchId: lote?.id, idempotencyKey: chave, method: metodo, paidAt: new Date(`${paidAt}T12:00:00-03:00`).toISOString(),
        externalReference: referencia.trim() || undefined, attachmentRef: comprovante.trim() || undefined, notes: obs.trim() || undefined,
        amountCents: total, allocations: linhas.map((l) => ({ ledgerId: l.e.id, amountCents: l.valor as number })),
      });
      setRecibo(r.recibo ?? null);
    });
    if (ok) { toast('Pagamento registrado.', 'sucesso'); onRegistrado(); }
  }

  if (recibo) {
    return (
      <Modal open={open} onClose={onClose} title="Pagamento registrado" maxWidth={520}>
        <div className="pa-form">
          <Callout tone="success" title={recibo.tipo}>
            {brl(recibo.valorCents)} para <strong>{recibo.parceiro}</strong> · pago em {dataCurta(recibo.pagoEm, tz)} ({recibo.metodo}) · {plural(recibo.lancamentos, 'lançamento', 'lançamentos')}.
          </Callout>
          <p className="pa-aviso">Saldo liberado restante deste parceiro: <strong>{brl(recibo.saldoRestanteLiberadoCents)}</strong>. {recibo.referencia ? `Referência: ${recibo.referencia}.` : ''}</p>
          <p className="pa-aviso">Este recibo é gerencial, não é comprovante bancário. Para corrigir, faça um estorno administrativo do pagamento — o registro original nunca é apagado.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open} onClose={() => { if (!enviando) onClose(); }} title={`Registrar pagamento · ${partnerName}`} maxWidth={760}
      confirmLabel={enviando ? 'Aguarde…' : etapa === 'form' ? 'Revisar' : `Confirmar pagamento de ${brl(total)}`} confirmDisabled={enviando || invalido}
      onConfirm={() => (etapa === 'form' ? setEtapa('confirmar') : registrar())}
    >
      <div className="pa-form">
        {lote && <Callout tone="info">Pagamento do lote <strong>{lote.competenceLabel}</strong> (proposto {brl(lote.proposedCents)}).</Callout>}
        {entradas === null && !erro && <Skeleton rows={4} />}
        {entradas && entradas.length === 0 && <Callout tone="warning">Não há lançamentos liberados em aberto para este parceiro. Comissão só é paga depois de liberada.</Callout>}
        {entradas && entradas.length > 0 && etapa === 'form' && (
          <>
            <p className="pa-aviso">Escolha o que está pagando e o valor de cada lançamento (rateio explícito). Pagamento parcial mantém o saldo restante em aberto. Ajustes negativos (estorno/devolução) são compensados junto.</p>
            <div className="ds-table-wrap">
              <table className="ds-table" aria-label="Lançamentos liberados">
                <thead><tr><th><span className="ds-sr-only">Incluir</span></th><th>Competência</th><th>Origem</th><th className="pa-right">Em aberto</th><th className="pa-right">Pagar agora (R$)</th></tr></thead>
                <tbody>
                  {entradas.map((e) => {
                    const l = linhas.find((x) => x.e.id === e.id);
                    return (
                      <tr key={e.id}>
                        <td><input type="checkbox" aria-label={`Incluir lançamento ${e.inkOrderId ?? e.id}`} checked={!!marcadas[e.id]} onChange={(ev) => setMarcadas((m) => ({ ...m, [e.id]: ev.target.checked }))} /></td>
                        <td>{e.competence.slice(0, 7)}</td>
                        <td>{e.entryType === 'accrual' ? (e.basis === 'collab' ? `Collab · pedido ${e.inkOrderId}` : `Cupom ${e.couponCode ?? ''} · pedido ${e.inkOrderId}`) : e.category === 'content_fee' ? 'Cachê por conteúdo' : `Ajuste${e.inkOrderId ? ` · pedido ${e.inkOrderId}` : ''}`}</td>
                        <td className="pa-right pa-num">{brl(e.openCents)}</td>
                        <td className="pa-right">
                          <Input className="pa-num" inputMode="decimal" controlSize="sm" aria-label="Valor a pagar" value={valores[e.id] ?? ''} disabled={!marcadas[e.id]} onChange={(ev) => setValores((v) => ({ ...v, [e.id]: ev.target.value }))} aria-invalid={!!l && (l.invalido || l.excede)} />
                          {e.openCents < 0 && <div className="pa-muted">compensa (−)</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pa-total"><span>Total a pagar agora: <strong>{brl(total)}</strong></span><span>Saldo restante: <strong>{brl(restante)}</strong>{parcial ? ' (pagamento parcial)' : ' (quita tudo)'}</span></div>
            {total <= 0 && linhas.length > 0 && <Callout tone="warning">O pagamento líquido precisa ser maior que zero.</Callout>}
            {linhas.some((l) => l.excede) && <Callout tone="danger">Há valor acima do saldo em aberto de um lançamento (adiantamento não é suportado).</Callout>}
            <div className="pa-form__linha">
              <Field label="Data efetiva do pagamento" required hint="O dia em que a transferência saiu — não o dia deste registro."><Input type="date" value={paidAt} max={hojeNoFuso(tz)} onChange={(e) => setPaidAt(e.target.value)} /></Field>
              <Field label="Forma de pagamento" required>
                <Select value={metodo} onChange={(e) => setMetodo(e.target.value as typeof metodo)}>{(Object.keys(ROTULOS_METODO) as (keyof typeof ROTULOS_METODO)[]).map((m) => <option key={m} value={m}>{ROTULOS_METODO[m]}</option>)}</Select>
              </Field>
              <Field label="Referência (ID do Pix / transferência)" optional hint="A mesma referência não pode ser lançada duas vezes."><Input value={referencia} maxLength={120} onChange={(e) => setReferencia(e.target.value)} /></Field>
            </div>
            <div className="pa-form__linha">
              <Field label="Comprovante (referência ou link)" optional><Input value={comprovante} maxLength={300} onChange={(e) => setComprovante(e.target.value)} /></Field>
              <Field label="Observação" optional><Input value={obs} maxLength={1000} onChange={(e) => setObs(e.target.value)} /></Field>
            </div>
          </>
        )}
        {entradas && etapa === 'confirmar' && (
          <Callout tone="warning" title="Confirme o registro">
            Você está registrando que <strong>já transferiu {brl(total)}</strong> a <strong>{partnerName}</strong> em <strong>{dataCurta(`${paidAt}T12:00:00Z`, 'UTC')}</strong> ({ROTULOS_METODO[metodo]}) — {plural(linhas.length, 'lançamento', 'lançamentos')}. {parcial ? `Restarão ${brl(restante)} em aberto.` : 'O saldo liberado ficará zerado.'} O Oria não faz o Pix: isto é só o registro. Não dá para apagar; só estornar.
          </Callout>
        )}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}
