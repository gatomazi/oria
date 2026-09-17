import { DIAS_DA_SEMANA, formatNumero, formatSessoesCelula } from '../../lib/ga4';

const HORAS = Array.from({ length: 24 }, (_, h) => h);

// Sessões por dia da semana × hora. Serve pra decidir horário de post e de disparo de WhatsApp —
// por isso a leitura é "onde está quente", não o número exato (que fica no title de cada célula).
export function MapaDeCalorGa4({ horarios }: { horarios: { dia: number; hora: number; sessions: number }[] }) {
  const porChave = new Map(horarios.map((h) => [`${h.dia}-${h.hora}`, h.sessions]));
  const pico = horarios.reduce((max, h) => Math.max(max, h.sessions), 0);

  // Normalizar pelo maior valor deixa o mapa lavado quando existe uma hora muito fora da curva:
  // todas as outras viram quase a mesma cor. O teto da escala é o percentil 95 — as poucas horas
  // acima dele saturam no topo, e a faixa onde a loja realmente vive usa a escala inteira.
  const ordenados = horarios.map((h) => h.sessions).sort((a, b) => a - b);
  const teto = ordenados.length
    ? Math.max(1, ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * 0.95))])
    : 1;

  return (
    <div>
      {/* Rola na horizontal no celular: precisa ser focável pra quem navega por teclado conseguir
          rolar a região (axe › scrollable-region-focusable). */}
      <div className="ga-heat__scroll" tabIndex={0} role="group" aria-label="Sessões por dia da semana e hora">
        <div className="ga-heat">
          <span aria-hidden="true" />
          {HORAS.map((h) => (
            <span className="ga-heat__rotulo-hora" key={`h-${h}`} aria-hidden="true">
              {h % 3 === 0 ? `${h}h` : ''}
            </span>
          ))}

          {DIAS_DA_SEMANA.map((dia, indiceDia) => (
            <Linha key={dia} dia={dia} indiceDia={indiceDia} porChave={porChave} teto={teto} />
          ))}
        </div>
      </div>

      <p className="ga-heat__legenda">
        <span>Menos</span>
        <span className="ga-heat__legenda-escala" aria-hidden="true" />
        <span>Mais sessões</span>
        {pico > 0 && <span>· pico de {formatNumero(pico)} sessões numa hora</span>}
      </p>
    </div>
  );
}

function Linha({ dia, indiceDia, porChave, teto }: {
  dia: string; indiceDia: number; porChave: Map<string, number>; teto: number;
}) {
  return (
    <>
      <span className="ga-heat__rotulo-dia">{dia}</span>
      {HORAS.map((hora) => {
        const sessoes = porChave.get(`${indiceDia}-${hora}`) || 0;
        // Raiz quadrada sobre a razão já limitada a 1: separa melhor a faixa baixa, que é onde fica
        // a maior parte das horas.
        const intensidade = Math.sqrt(Math.min(1, sessoes / teto));
        // A rampa para em 55% de --info de propósito: acima disso o fundo clareia até a faixa onde
        // nem texto claro nem escuro alcançam 4,5:1, e o número da célula fica ilegível justamente
        // nas horas de pico. Com o número dentro da célula a cor não precisa mais carregar a
        // grandeza sozinha — ela mostra o padrão, o número dá o valor.
        return (
          <span
            className="ga-heat__celula"
            key={`${dia}-${hora}`}
            style={intensidade > 0 ? { background: `color-mix(in srgb, var(--info) ${Math.round(intensidade * 55)}%, var(--surface-2))` } : undefined}
            title={`${dia}, ${hora}h — ${formatNumero(sessoes)} sessões`}
          >
            {formatSessoesCelula(sessoes)}
          </span>
        );
      })}
    </>
  );
}
