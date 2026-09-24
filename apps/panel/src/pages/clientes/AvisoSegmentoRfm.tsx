import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Callout } from '../../components/ds';
import { criarSegmentoRfm, getEstadoSegmentosRfm, type CorteDeValor, type EstadoSegmentoRfm } from '../../api/clientes';
import { formatValor } from '../../lib/format';
import { dataCurta, numero } from './rfmTexto';

const moeda = (v: number) => formatValor(v) ?? '—';
export const rotuloCorte = (c: CorteDeValor | null): string => (c
  ? `${c.metrica === 'ticket_medio' ? 'ticket médio' : 'valor comprado'} ${c.sentido === 'abaixo_de' ? 'abaixo de' : 'a partir de'} ${moeda(c.valor)}`
  : 'sem corte de valor');

// Mostra, na Audiência, o que este segmento RFM realmente é: regra, data de classificação (`asOf`), corte de valor salvo e o
// corte efetivo de hoje. Pessoas dinâmicas; corte materializado. Se divergem, oferece criar um segmento NOVO com o corte atual
// (o salvo nunca é reescrito em silêncio).
export function AvisoSegmentoRfm({ segmentoId }: { segmentoId: string }) {
  const [estado, setEstado] = useState<EstadoSegmentoRfm | null | undefined>(undefined);
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let atual = true;
    setEstado(undefined);
    setErro('');
    getEstadoSegmentosRfm()
      .then((r) => { if (atual) setEstado(r.segmentos.find((s) => s.id === segmentoId) ?? null); })
      .catch((e: Error) => { if (atual) setErro(e.message); });
    return () => { atual = false; };
  }, [segmentoId]);

  if (erro) return <p className="ds-form-note">Não foi possível comparar este segmento com a classificação de hoje: {erro}</p>;
  if (!estado) return null; // carregando, ou segmento que não é RFM

  async function criarComCorteAtual() {
    if (!estado) return;
    setCriando(true);
    try {
      const nome = `RFM · ${estado.nome.replace(/^RFM · /, '')} · corte de ${dataCurta(estado.atual.classificadoEm)}`.slice(0, 120);
      const r = await criarSegmentoRfm(nome, estado.rfmSegmento);
      navigate(`/admin/campanhas/nova?segmento=${encodeURIComponent(r.segmento.id)}`);
    } catch { /* toast em api() */ } finally { setCriando(false); }
  }

  // Segmento salvo com filtros genéricos ("avaliação aproximada"): o aviso e a confirmação vivem no cartão da própria Audiência
  // (RfmAproximadoCard), que também cobre campanhas antigas sem `segmento_id`. Aqui só o corte salvo × de hoje.

  return (
    <Callout
      tone={estado.divergente ? 'warning' : 'info'}
      title={estado.divergente ? 'Este segmento RFM está com o corte defasado' : 'Segmento RFM: regra e corte conferem com hoje'}
      action={estado.divergente ? <Button size="sm" variant="secondary" disabled={criando} onClick={criarComCorteAtual}>{criando ? 'Criando…' : 'Criar segmento com o corte atual'}</Button> : undefined}
    >
      <p className="cli-aviso">
        Regra <strong>{estado.salvo.regraVersao ?? '—'}</strong> · classificado em {dataCurta(estado.salvo.classificadoEm)} · corte salvo: <strong>{rotuloCorte(estado.salvo.corte)}</strong>.
      </p>
      <p className="cli-aviso">
        Hoje ({dataCurta(estado.atual.classificadoEm)}, regra {estado.atual.regraVersao}): <strong>{rotuloCorte(estado.atual.corte)}</strong>
        {estado.divergente && estado.mesmaRegraVersao ? ' — a versão da regra é a mesma, mas o percentil mudou com os pedidos novos.' : ''}
        {estado.divergente && !estado.mesmaRegraVersao ? ' — a regra também mudou.' : ''}
      </p>
      {estado.pessoas.comRegraSalva != null && (
        <p className="cli-aviso">
          Pessoas hoje: {numero(estado.pessoas.comRegraSalva)} pela regra salva · {numero(estado.pessoas.comRegraAtual)} no segmento de hoje.
        </p>
      )}
      <p className="cli-aviso cli-aviso--nota">{estado.politica.texto} A Audiência abaixo usa o corte SALVO.</p>
    </Callout>
  );
}
