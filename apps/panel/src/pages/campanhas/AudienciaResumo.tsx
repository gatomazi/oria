import { Callout, StatusBadge } from '../../components/ds';
import type { AudienciaFiltroRfmValor, AudienciaPreviewResultado } from '../../api/campanhas';
import { rotuloCorte } from '../clientes/AvisoSegmentoRfm';
import { dataHora, descreverPredicado, numero } from '../clientes/rfmTexto';
import { plural } from '../../lib/format';

// Por que cada pessoa foi excluída DEPOIS de entrar na população comercial. A ordem é a do servidor: cada excluído tem UM motivo.
export function motivosDeExclusao(b: AudienciaPreviewResultado['breakdown']): { rotulo: string; n: number }[] {
  return [
    { rotulo: 'sem opt-in de marketing', n: b.optOut },
    { rotulo: 'sem telefone válido', n: b.numeroInvalido },
    { rotulo: 'comprou recentemente', n: b.compradoRecentemente },
    { rotulo: 'recebeu campanha recentemente', n: b.recebeuCampanhaRecentemente },
  ].filter((m) => m.n > 0);
}

// O filtro RFM salvo no segmento: regra e corte SALVOS (a Audiência usa o corte salvo; o de hoje só é informado).
export function RfmFiltroCard({ filtro, preview }: { filtro: AudienciaFiltroRfmValor; preview: AudienciaPreviewResultado | null }) {
  const rfm = preview?.rfm;
  return (
    <div className="ad-rfm-card">
      <div className="ad-rfm-card__topo">
        <strong>Segmento RFM{rfm ? `: ${rfm.segmentoNome}` : ''}</strong>
        <StatusBadge tone="neutral" label="Condição obrigatória" />
      </div>
      <ul className="ad-rfm-card__regra" aria-label="Regra do segmento">
        {descreverPredicado(filtro.predicado).map((l) => (
          <li key={l.rotulo}><span>{l.rotulo}</span> {l.texto}</li>
        ))}
      </ul>
      <p className="pc-nota">
        Regra {filtro.regraVersao} · salvo em {dataHora(filtro.classificadoEm)}. A população é a mesma da matriz de Clientes: mesma classificação, mesmas
        compras válidas (sem troca) e dia de calendário no fuso da loja. Para outro segmento, volte a Clientes.
      </p>
    </div>
  );
}

interface ResumoProps {
  preview: AudienciaPreviewResultado | null;
  carregando: boolean;
  erro: string;
}

// Prévia da Audiência: elegíveis, população comercial, motivos de exclusão e — no segmento RFM — universos, `asOf`, regra e corte.
export function AudienciaResumo({ preview, carregando, erro }: ResumoProps) {
  const motivos = preview ? motivosDeExclusao(preview.breakdown) : [];
  const rfm = preview?.rfm;
  return (
    <div className="ad-segmento-preview" aria-live="polite">
      {carregando && <span className="pc-nota">Calculando…</span>}
      {erro && !carregando && (
        <div role="alert" className="ad-preview-erro">
          <span className="ds-form-error">{erro}</span>
          <span className="pc-nota">Nenhuma contagem é exibida: uma audiência que não pôde ser calculada não vira "todos os clientes".</span>
        </div>
      )}
      {preview && !carregando && !erro && (
        <>
          <div>
            <strong>{preview.eligible}</strong> {preview.eligible === 1 ? 'cliente elegível' : 'clientes elegíveis'}
            <span className="pc-nota"> — {preview.matched} {rfm ? 'no segmento' : 'encontrados'}, {preview.excluded} excluídos</span>
          </div>
          {motivos.length > 0 && (
            <p className="pc-nota ad-preview-linha">Excluídos por contato: {motivos.map((m) => `${numero(m.n)} ${m.rotulo}`).join(' · ')}.</p>
          )}
          {rfm && (
            <p className="pc-nota ad-preview-linha">
              {plural(rfm.universos.segmento, 'pessoa', 'pessoas')} no segmento RFM · {plural(rfm.universos.compradoresValidos, 'comprador válido', 'compradores válidos')} classificados ·{' '}
              {plural(rfm.universos.pessoasComPedido, 'pessoa com pedido', 'pessoas com pedido')} · calculado agora ({dataHora(rfm.asOf)}, regra {rfm.regraVersao}).
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Corte salvo × corte de hoje (só informativo: a Audiência usa o SALVO).
export function AvisoCorteDaAudiencia({ preview }: { preview: AudienciaPreviewResultado | null }) {
  const rfm = preview?.rfm;
  if (!rfm || !rfm.divergente) return null;
  return (
    <Callout tone="warning" title="Corte de valor defasado">
      <p className="cli-aviso">
        Esta audiência usa o corte salvo — <strong>{rotuloCorte(rfm.corteSalvo)}</strong> — e hoje o corte é <strong>{rotuloCorte(rfm.corteAtual)}</strong>.
        {rfm.pessoasNoSegmentoDeHoje != null ? ` O segmento de hoje teria ${numero(rfm.pessoasNoSegmentoDeHoje)} pessoas; esta audiência tem ${numero(rfm.universos.segmento)}.` : ''}
      </p>
      <p className="cli-aviso cli-aviso--nota">O segmento salvo não é reescrito. Para usar o corte de hoje, crie um novo segmento em Clientes.</p>
    </Callout>
  );
}
