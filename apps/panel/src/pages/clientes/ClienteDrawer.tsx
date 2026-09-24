import { useEffect, useRef, useState } from 'react';
import { Callout, Button, Disclosure, Drawer, ErrorState, MaskedValue, Skeleton, StatusBadge } from '../../components/ds';
import { getDetalheCliente, type DetalheCliente, type PedidoDetalhe } from '../../api/clientes';
import { PAYMENT_STATUS_MAP, ORDER_STATUS_MAP } from '../../lib/statusMap';
import { formatValor, plural } from '../../lib/format';
import { GrupoBadge } from './RfmExplorer';
import { dataCurta, dataHora, numero } from './rfmTexto';

const moeda = (v: number | null | undefined) => (v == null ? '—' : (formatValor(v) ?? '—'));

function Par({ rotulo, valor }: { rotulo: string; valor: React.ReactNode }) {
  return (
    <div className="cli-par">
      <dt>{rotulo}</dt>
      <dd>{valor}</dd>
    </div>
  );
}

// Um pedido do histórico. Os componentes do valor aparecem como a Ink os fecha (itens + frete − desconto = total pago);
// o que o cache não sabe (itens antigos sem gravação, reembolso parcial) aparece como "—"/aviso, nunca como número inventado.
function PedidoItem({ p }: { p: PedidoDetalhe }) {
  const pag = PAYMENT_STATUS_MAP[p.statusPagamento ?? ''] ?? { label: p.statusPagamento ?? '—', tone: 'neutral' as const };
  const ped = ORDER_STATUS_MAP[p.statusPedido ?? ''];
  return (
    <li className="cli-pedido">
      <details>
        <summary className="cli-pedido__resumo">
          <span className="cli-pedido__id">Pedido {p.inkOrderId ?? '—'}</span>
          <span className="cli-pedido__data">{dataCurta(p.criadoEm)}</span>
          <StatusBadge tone={pag.tone} label={pag.label} />
          {p.troca && <StatusBadge tone="neutral" label="Troca" />}
          <span className="cli-pedido__total">{moeda(p.totalPago)}</span>
        </summary>
        <div className="cli-pedido__corpo">
          {!p.contaNoLtv && <p className="cli-detalhe__nota">Este pedido não entra no LTV ({pag.label.toLowerCase()}{p.troca ? ', troca' : ''}).</p>}
          <dl className="cli-pedido__valores">
            <Par rotulo="Subtotal dos itens" valor={moeda(p.subtotal)} />
            <Par rotulo="Desconto" valor={p.desconto == null ? '—' : `− ${moeda(p.desconto)}`} />
            <Par rotulo="Frete" valor={moeda(p.frete)} />
            <Par rotulo="Total pago" valor={moeda(p.totalPago)} />
            <Par rotulo="Devolvido" valor={p.devolvido != null ? moeda(p.devolvido) : 'Sem reembolso total'} />
            <Par rotulo="Total líquido" valor={moeda(p.totalLiquido)} />
          </dl>
          {p.conciliado === false && (
            <Callout tone="warning" title="A soma dos itens não fecha com o pedido">
              Itens somam {moeda(p.somaItens)} e o subtotal calculado é {moeda(p.subtotal)}. Pode haver serviço adicional ou ajuste que o cache não detalha.
            </Callout>
          )}
          {ped && <p className="cli-detalhe__nota">Situação do pedido: {ped.label}.</p>}
          {p.itens.length ? (
            <ul className="cli-itens">
              {p.itens.map((i, idx) => (
                <li key={`${p.inkOrderId}-${idx}`} className="cli-item">
                  {/* Sem imagem real na Ink: placeholder neutro, nunca uma URL inventada. */}
                  <span className="cli-item__imagem" aria-hidden="true">{(i.produto ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className="cli-item__texto">
                    <span className="cli-item__nome">{i.produto ?? 'Produto sem nome'}</span>
                    <span className="cli-item__variacao">{[i.modelo, i.cor, i.tamanho && `Tam. ${i.tamanho}`, i.sku].filter(Boolean).join(' · ') || 'Sem variação registrada'}</span>
                  </span>
                  <span className="cli-item__valor">{i.quantidade}× · {moeda(i.valorLiquido)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cli-detalhe__nota">Os itens deste pedido ainda não estão no cache local (pedido anterior à gravação de itens).</p>
          )}
        </div>
      </details>
    </li>
  );
}

interface Props {
  customerKey: string | null;
  nomeInicial: string | null;
  onClose: () => void;
}

// Drawer 360°. Só abre por ação do usuário; nunca dispara mensagem. Os botões de canal só são clicáveis quando há uma rota
// REAL (telefone válido → abrir o WhatsApp fora do Oria; e-mail válido → abrir o app de e-mail) e dizem que não enviam por aqui.
export function ClienteDrawer({ customerKey, nomeInicial, onClose }: Props) {
  const [dados, setDados] = useState<DetalheCliente | null>(null);
  const [erro, setErro] = useState('');
  const historico = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!customerKey) return;
    let atual = true;
    setDados(null);
    setErro('');
    getDetalheCliente(customerKey)
      .then((d) => { if (atual) setDados(d); })
      .catch((e: Error) => { if (atual) setErro(e.message); });
    return () => { atual = false; };
  }, [customerKey]);

  const aberto = customerKey != null;
  const c = dados?.cliente;
  const canais = dados?.canais;

  return (
    <Drawer
      open={aberto}
      onClose={onClose}
      title={c?.nome || nomeInicial || 'Cliente'}
      description={dados?.rfm ? `${dados.rfm.segmento.nome} · classificado em ${dataCurta(dados.rfm.asOf)}` : 'Visão 360° do cliente'}
      footer={canais && (
        <>
          <Button variant="ghost" size="sm" onClick={() => historico.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Ver pedidos</Button>
          {canais.email.acao === 'abrir_cliente_de_email' && c?.email ? (
            <a className="ds-btn ds-btn--secondary ds-btn--sm" href={`mailto:${c.email}`} title={canais.email.motivo}>E-mail (abre seu app)</a>
          ) : (
            <Button variant="secondary" size="sm" disabled title={canais.email.motivo}>E-mail indisponível</Button>
          )}
          {canais.whatsapp.acao === 'abrir_externo' && canais.whatsapp.telefoneWa ? (
            <a
              className="ds-btn ds-btn--primary ds-btn--sm"
              href={`https://wa.me/${canais.whatsapp.telefoneWa}`}
              target="_blank"
              rel="noopener noreferrer"
              title={canais.whatsapp.motivo}
            >
              WhatsApp (abre fora do Oria)
            </a>
          ) : (
            <Button size="sm" disabled title={canais.whatsapp.motivo}>WhatsApp indisponível</Button>
          )}
        </>
      )}
    >
      {erro && <ErrorState description={erro} />}
      {!erro && !dados && <Skeleton variant="table" rows={6} />}
      {dados && c && (
        <div className="cli-drawer">
          <div className="cli-drawer__badges">
            {dados.rfm && <GrupoBadge id={dados.rfm.segmento.id} />}
            {dados.distintivos.map((d) => <StatusBadge key={d.id} tone="neutral" label={d.label} />)}
          </div>

          <section aria-label="Identidade">
            <dl className="cli-pares">
              <Par rotulo="E-mail" valor={c.email ?? '—'} />
              <Par rotulo="Telefone" valor={c.telefone ?? '—'} />
              <Par rotulo="Documento" valor={<MaskedValue value={c.documento} label="documento" />} />
              <Par rotulo="UF" valor={c.uf ?? '—'} />
              <Par rotulo="Primeira compra" valor={dataCurta(dados.indicadores.primeiraCompraEm)} />
              <Par rotulo="Última compra" valor={dados.indicadores.ultimaCompraEm ? `${dataCurta(dados.indicadores.ultimaCompraEm)} (${plural(dados.indicadores.diasSemComprar ?? 0, 'dia', 'dias')})` : '—'} />
            </dl>
            {dados.identidade.motivosDeUniao.length > 0 && (
              <p className="cli-detalhe__nota">
                {plural(dados.identidade.pedidosAgrupados, 'pedido', 'pedidos')} reunidos como uma pessoa por {dados.identidade.motivosDeUniao.join(' e ')} em comum.
              </p>
            )}
          </section>

          <section aria-label="Indicadores">
            <div className="cli-indicadores">
              <div><span>LTV líquido</span><strong>{moeda(dados.indicadores.ltv)}</strong></div>
              <div><span>Pedidos pagos</span><strong>{numero(dados.indicadores.pedidosPagos)}</strong></div>
              <div><span>Ticket médio</span><strong>{moeda(dados.indicadores.ticketMedio)}</strong></div>
              <div>
                <span>Itens comprados</span>
                <strong>{dados.indicadores.itensComprados == null ? '—' : numero(dados.indicadores.itensComprados)}</strong>
                {dados.indicadores.itensComprados == null && dados.indicadores.pedidosSemItens > 0 && <em>{plural(dados.indicadores.pedidosSemItens, 'pedido sem itens no cache', 'pedidos sem itens no cache')}</em>}
              </div>
            </div>
          </section>

          <section aria-label="Classificação RFM">
            <h3 className="cli-drawer__secao">Classificação RFM</h3>
            {dados.rfm ? (
              dados.rfm.amostraSuficiente && dados.rfm.escore ? (
                <>
                  <dl className="cli-pares">
                    <Par rotulo="Recência" valor={`${numero(dados.rfm.r)} dias · nota ${dados.rfm.escore.r}/5`} />
                    <Par rotulo="Frequência" valor={`${numero(dados.rfm.f)} na janela (${numero(dados.rfm.fVida)} no total) · nota ${dados.rfm.escore.f}/5`} />
                    <Par rotulo="Valor" valor={`${moeda(dados.rfm.m)} · nota ${dados.rfm.escore.m}/5`} />
                  </dl>
                  <p className="cli-detalhe__nota">Regra {dados.rfm.versao}: o segmento vem das faixas de recência, frequência e valor; as notas 1–5 são só uma leitura relativa à base.</p>
                </>
              ) : (
                <Callout tone="warning" title="Dados insuficientes para classificar">{dados.rfm.motivoInsuficiencia}</Callout>
              )
            ) : (
              <p className="cli-detalhe__nota">Sem compra válida (paga, sem troca): fica fora da RFM.</p>
            )}
          </section>

          <section aria-label="Consentimento e canais">
            <h3 className="cli-drawer__secao">Consentimento e canais</h3>
            <dl className="cli-pares">
              <Par rotulo="Aceita marketing" valor={dados.canais.consentimento.aceitaMarketing == null ? 'Não informado' : dados.canais.consentimento.aceitaMarketing ? 'Sim (checkout)' : 'Não'} />
              <Par rotulo="WhatsApp Oria" valor={dados.canais.whatsapp.conexaoOria === 'conectada' ? 'Conectado' : 'Desconectado'} />
            </dl>
            <p className="cli-detalhe__nota">{dados.canais.consentimento.fonte} O Oria ainda não registra opt-in/opt-out por canal.</p>
          </section>

          <section aria-label="Histórico de compras">
            <h3 className="cli-drawer__secao" ref={historico} tabIndex={-1}>Histórico de compras</h3>
            {dados.pedidos.length ? <ul className="cli-pedidos">{dados.pedidos.map((p) => <PedidoItem key={p.inkOrderId ?? p.criadoEm} p={p} />)}</ul> : <p className="cli-detalhe__nota">Nenhum pedido.</p>}
          </section>

          <section aria-label="Campanhas do Oria">
            <h3 className="cli-drawer__secao">Campanhas do Oria</h3>
            {dados.campanhas.length ? (
              <ul className="cli-campanhas">
                {dados.campanhas.map((k) => (
                  <li key={`${k.campanhaId}-${k.enviadoEm}`}>
                    <span>{k.campanha}</span>
                    <StatusBadge tone={k.status === 'failed' ? 'danger' : k.status === 'pending' ? 'warning' : 'info'} label={k.status} />
                    <span className="cli-detalhe__nota">{dataHora(k.enviadoEm)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cli-detalhe__nota">Nenhuma campanha do Oria enviada a este cliente.</p>
            )}
          </section>

          <Disclosure summary="O que este histórico não cobre">
            <ul className="cli-lacunas">{dados.lacunas.map((l) => <li key={l}>{l}</li>)}</ul>
          </Disclosure>
        </div>
      )}
    </Drawer>
  );
}
