import { useState } from 'react';
import { Button, Callout, EmptyState, StatusBadge } from '../../components/ds';
import { formatarTextoWhatsapp } from '../../lib/whatsappFormat';
import { adminStores } from '../../state/adminStores';
import {
  assumirItemFila,
  concluirItemFila,
  linkWhatsappCelular,
  type WhatsappWebItem,
  type WhatsappWebOrigem,
  type WhatsappWebResumo,
} from '../../api/whatsappWeb';

// Envio assistido pelo celular: sem o computador por perto, a pessoa envia 1 a 1 pelo WhatsApp do
// próprio celular. Em 2 toques de propósito — "Enviar" reserva (fetch) e só então aparece o link
// real do WhatsApp: abrir o link depois de um await perde o gesto do usuário e o iOS bloqueia.
const ORIGEM_LABEL: Record<WhatsappWebOrigem, string> = { pedido: 'Pedido', carrinho: 'Carrinho', pix: 'Pix', campanha: 'Campanha' };

// Mesma prioridade do app desktop: pagamento aprovado primeiro, campanhas por último, mais antigo antes.
function prioridade(item: WhatsappWebItem): number {
  if (item.evento === 'payment.approved') return 0;
  return item.origem === 'campanha' ? 2 : 1;
}

function formatarTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, '');
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : telefone;
}

export function EnviarPeloCelular({
  itens,
  resumo,
  aoAtualizar,
}: {
  itens: WhatsappWebItem[];
  resumo: WhatsappWebResumo;
  aoAtualizar: () => void;
}) {
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<{ id: string; texto: string } | null>(null);

  const emAndamento = itens.filter((i) => i.executor === 'celular' && (i.status === 'claimed' || i.status === 'desconhecido'));
  const disponiveis = itens
    .filter((i) => i.status === 'pending' || i.status === 'aguardando_aprovacao')
    .sort((a, b) => prioridade(a) - prioridade(b) || a.criadoEm.localeCompare(b.criadoEm));

  const teto = resumo.tetoDiario ?? 0;
  const enviadosHoje = resumo.enviadosHoje ?? 0;
  const tetoAtingido = teto > 0 && enviadosHoje >= teto;
  const appEnviando = resumo.agente?.online && !resumo.agente.pausado;

  async function executar(id: string, acao: () => Promise<unknown>) {
    setOcupado(id);
    setErro(null);
    try {
      await acao();
      aoAtualizar();
    } catch (err) {
      setErro({ id, texto: (err as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  function Cartao({ item, reservado }: { item: WhatsappWebItem; reservado: boolean }) {
    return (
      <article className={'wa-celular__cartao' + (reservado ? ' wa-celular__cartao--reservado' : '')}>
        <header className="wa-celular__topo">
          <div>
            <strong>{item.nome || 'Cliente'}</strong>
            <span>{formatarTelefone(item.telefone)}</span>
          </div>
          <StatusBadge tone={item.origem === 'campanha' ? 'premium' : 'info'} label={ORIGEM_LABEL[item.origem]} />
        </header>
        <div className="wa-celular__texto">{formatarTextoWhatsapp(item.texto)}</div>
        {item.loja && <p className="wa-celular__meta">{adminStores.name(item.loja)}</p>}

        {reservado ? (
          <div className="wa-celular__acoes">
            <a className="ds-btn ds-btn--primary ds-btn--block" href={linkWhatsappCelular(item.telefone, item.texto)} target="_blank" rel="noopener noreferrer">
              Abrir WhatsApp
            </a>
            <div className="wa-celular__confirmar">
              <Button disabled={ocupado === item.id} onClick={() => executar(item.id, () => concluirItemFila(item.id, true))}>
                Enviei
              </Button>
              <Button variant="ghost" disabled={ocupado === item.id} onClick={() => executar(item.id, () => concluirItemFila(item.id, false))}>
                Não enviei
              </Button>
            </div>
          </div>
        ) : (
          <div className="wa-celular__acoes">
            <Button block disabled={ocupado !== null || tetoAtingido} onClick={() => executar(item.id, () => assumirItemFila(item.id))}>
              {ocupado === item.id ? 'Reservando…' : 'Enviar pelo WhatsApp'}
            </Button>
          </div>
        )}
        {erro?.id === item.id && <p className="ds-form-error">{erro.texto}</p>}
      </article>
    );
  }

  return (
    <div className="wa-celular">
      <p className="pc-nota">
        Toque em <strong>Enviar pelo WhatsApp</strong>, depois em <strong>Abrir WhatsApp</strong>: a conversa abre no seu celular com o texto
        pronto. Envie e volte aqui pra marcar. Conta no mesmo limite diário do app.
      </p>
      {appEnviando && (
        <Callout tone="info" title="O app do computador também está enviando." className="wa-alerta-espaco">
          Cada mensagem é reservada por quem pegar primeiro — nenhuma sai duas vezes.
        </Callout>
      )}
      {tetoAtingido && (
        <Callout tone="warning" title={`Teto diário de ${teto} mensagens atingido.`} className="wa-alerta-espaco">
          As próximas ficam pra amanhã.
        </Callout>
      )}

      {emAndamento.length > 0 && (
        <section className="wa-celular__grupo">
          <h3>Em andamento</h3>
          {emAndamento.map((item) => (
            <Cartao key={item.id} item={item} reservado />
          ))}
        </section>
      )}

      <section className="wa-celular__grupo">
        <h3>Na fila ({disponiveis.length})</h3>
        {disponiveis.length === 0 ? (
          <EmptyState title="Nada pra enviar" description="Quando uma automação ou campanha gerar mensagem, ela aparece aqui." />
        ) : (
          disponiveis.map((item) => <Cartao key={item.id} item={item} reservado={false} />)
        )}
      </section>
    </div>
  );
}
