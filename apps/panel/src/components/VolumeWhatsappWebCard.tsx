import { Card, StatusBadge, type Tone } from './ds';
import type { WhatsappWebResumo } from '../api/whatsappWeb';

import '../whatsapp-web.css';

// Medidor de volume diário do WhatsApp Web. Na API da Meta o limite é o tier da conta e o saldo;
// aqui o que pesa é o risco de bloqueio do número — por isso as faixas (seguro/atenção/risco) e
// o limite recomendado ficam sempre visíveis onde houver envio.
const ORIGEM_LABEL: Record<string, string> = { pedido: 'pedidos', carrinho: 'carrinhos', pix: 'Pix', campanha: 'campanhas' };

export function faixaDoVolume(total: number, faixas: { seguro: number; atencao: number }): { tone: Tone; label: string } {
  if (total <= faixas.seguro) return { tone: 'success', label: 'Seguro' };
  if (total <= faixas.atencao) return { tone: 'warning', label: 'Atenção' };
  return { tone: 'danger', label: 'Risco' };
}

export function VolumeWhatsappWebCard({ resumo }: { resumo: WhatsappWebResumo }) {
  if (!resumo.disponivel || !resumo.faixas) return null;
  const total = resumo.enviadosHoje ?? 0;
  const { faixas } = resumo;
  const faixa = faixaDoVolume(total, faixas);
  const percentual = Math.min(100, (total / faixas.risco) * 100);
  const composicao = Object.entries(resumo.porOrigem || {})
    .filter(([, n]) => n > 0)
    .map(([origem, n]) => `${n} ${ORIGEM_LABEL[origem] || origem}`)
    .join(' + ');

  return (
    <Card className="wa-volume">
      <div className="wa-volume__topo">
        <div>
          <p className="wa-volume__titulo">Mensagens WhatsApp enviadas hoje</p>
          <strong className="wa-volume__valor">{total}</strong>
          <p className="wa-volume__composicao">{composicao || 'nenhuma mensagem enviada ainda hoje'}</p>
        </div>
        <StatusBadge tone={faixa.tone} label={faixa.label} />
      </div>

      <div
        className="wa-volume__barra"
        role="meter"
        aria-label="Volume de mensagens enviadas hoje"
        aria-valuemin={0}
        aria-valuemax={faixas.risco}
        aria-valuenow={total}
      >
        <div className={`wa-volume__preenchimento wa-volume__preenchimento--${faixa.tone}`} style={{ width: '100%', transform: `scaleX(${Math.min(100, Math.max(0, percentual)) / 100})` }} />
        {resumo.limiteRecomendado != null && (
          <span className="wa-volume__marca" style={{ left: `${Math.min(100, (resumo.limiteRecomendado / faixas.risco) * 100)}%` }} />
        )}
      </div>
      <div className="wa-volume__faixas">
        <span className="wa-volume__faixa wa-volume__faixa--success">0–{faixas.seguro} seguro</span>
        <span className="wa-volume__faixa wa-volume__faixa--warning">
          {faixas.seguro + 1}–{faixas.atencao} atenção
        </span>
        <span className="wa-volume__faixa wa-volume__faixa--danger">
          {faixas.atencao + 1}–{faixas.risco} risco
        </span>
      </div>

      <p className="wa-volume__nota">
        <strong>Limite recomendado: {resumo.limiteRecomendado} mensagens por dia.</strong> Ultrapassar esse volume aumenta o risco de bloqueio
        pelo WhatsApp. Acima dele, campanhas ficam na fila para o dia seguinte; pedidos, Pix e carrinhos continuam saindo até o teto de{' '}
        {resumo.tetoDiario}. Se precisar enviar mais, distribua as campanhas em vários dias.
      </p>
    </Card>
  );
}
