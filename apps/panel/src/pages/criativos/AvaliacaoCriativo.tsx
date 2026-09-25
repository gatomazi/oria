import { useState } from 'react';
import { Button } from '../../components/ds';
import { clearFeedback, setFeedback, type Avaliacao, type Veredito } from '../../api/criativos';

// Gostei / Não gostei / Copiar dados de um criativo pronto. Clicar no veredito já marcado limpa a avaliação.
// O veredito é da pessoa logada; nada aqui muda a próxima geração (é só memória para consulta futura).
export function AvaliacaoCriativo({ creativeId, inicial, onCopiar }: { creativeId: string; inicial: Avaliacao | null | undefined; onCopiar: (creativeId: string) => Promise<void> }) {
  const [veredito, setVeredito] = useState<Veredito | null>(inicial?.verdict ?? null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');

  async function executar(acao: () => Promise<void>) {
    setOcupado(true);
    setErro('');
    try {
      await acao();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'não foi possível concluir');
    } finally {
      setOcupado(false);
    }
  }

  const marcar = (alvo: Veredito) => executar(async () => {
    if (veredito === alvo) {
      await clearFeedback(creativeId);
      setVeredito(null);
    } else {
      await setFeedback(creativeId, alvo);
      setVeredito(alvo);
    }
  });

  return (
    <div className="criativos-avaliacao">
      <div className="criativos-avaliacao__acoes">
        <Button size="sm" variant={veredito === 'liked' ? 'primary' : 'secondary'} aria-pressed={veredito === 'liked'} disabled={ocupado} onClick={() => marcar('liked')}>Gostei</Button>
        <Button size="sm" variant={veredito === 'disliked' ? 'primary' : 'secondary'} aria-pressed={veredito === 'disliked'} disabled={ocupado} onClick={() => marcar('disliked')}>Não gostei</Button>
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => executar(() => onCopiar(creativeId))}>Copiar dados</Button>
      </div>
      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
    </div>
  );
}
