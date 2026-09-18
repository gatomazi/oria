import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton } from '../../components/ds';
import { formatValor, copiar } from '../../lib/format';
import { hasEntitlement, loadEntitlements } from '../../state/entitlements';
import { simularFrete, type SimulacaoFrete } from '../../api/simularFrete';

import '../../pedidos-central.css';
import '../../trocas-nova.css';
import '../../simular-frete.css';

// Porte de src/simular-frete.js.
function textoResposta(sim: SimulacaoFrete): string {
  let texto = `Opções de entrega pra ${sim.cep}:\n`;
  (sim.delivery_options || []).forEach((op) => {
    texto += `- ${op.name || 'Entrega'}: ${formatValor(op.cost)}${op.estimated_business_days ? ` (${op.estimated_business_days} dias úteis)` : ''}\n`;
  });
  return texto;
}

export function SimularFretePage() {

  const [cep, setCep] = useState('');
  const [sim, setSim] = useState<SimulacaoFrete | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [whatsappHabilitado, setWhatsappHabilitado] = useState(false);

  useEffect(() => {
    loadEntitlements().then(() => setWhatsappHabilitado(hasEntitlement('whatsapp')));
  }, []);

  function calcular() {
    setErro('');
    setSim(null);
    setCarregando(true);
    simularFrete(cep)
      .then((data) => {
        setCarregando(false);
        setSim(data.simulacao);
      })
      .catch((err: Error) => {
        setCarregando(false);
        setErro(err.message);
      });
  }

  const resposta = sim ? textoResposta(sim) : '';

  return (
    <>
      <PageHeader
        title="Simular frete"
        description={
          'Estimativa sobre um produto de referência — o frete real pode variar por peso/dimensão.'
        }
      />

      <Card className="sf-form-card">
        <div className="tn-form">
          <Field label="CEP">
            <Input
              placeholder="88200-000"
              value={cep}
              onChange={(e) => setCep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') calcular();
              }}
            />
          </Field>
          <Button variant="primary" disabled={carregando} onClick={calcular}>
            Calcular
          </Button>
        </div>
      </Card>

      <div className="ds-bloco-seguinte">
        {carregando && <Skeleton rows={3} />}
        {erro && <ErrorState description={erro} />}
        {!carregando && !erro && sim && (!sim.delivery_options || !sim.delivery_options.length) && (
          <EmptyState title="Sem cobertura de entrega para esse CEP" />
        )}
        {!carregando && !erro && sim && sim.delivery_options && sim.delivery_options.length > 0 && (
          <>
            <Card title="Opções de entrega">
              <div className="pc-kv">
                {sim.delivery_options.map((op, i) => (
                  <div className="pc-kv__row" key={i}>
                    <span className="pc-kv__label">{op.name || 'Entrega'}</span>
                    <span className="pc-kv__value">
                      {formatValor(op.cost)}
                      {op.estimated_business_days ? ` · ${op.estimated_business_days} dias úteis` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
            {sim.reference_product && (
              <p className="pc-nota">
                Estimativa baseada em: {sim.reference_product.description} ({sim.reference_product.weight}kg,{' '}
                {sim.reference_product.width}×{sim.reference_product.height}×{sim.reference_product.length}cm).
              </p>
            )}
            <div className="ds-button-row">
              <Button
                variant="secondary"
                onClick={() => {
                  copiar(resposta, () => {
                    setCopiado(true);
                    setTimeout(() => setCopiado(false), 1800);
                  });
                }}
              >
                {copiado ? 'Copiado!' : 'Copiar resposta'}
              </Button>
              {whatsappHabilitado && (
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(resposta)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ds-btn ds-btn--secondary"
                >
                  Enviar pelo WhatsApp
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
