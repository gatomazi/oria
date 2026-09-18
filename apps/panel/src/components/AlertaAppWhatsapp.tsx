import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getWhatsappWebResumo, type WhatsappWebResumo } from '../api/whatsappWeb';
import { plural } from '../lib/format';

import '../whatsapp-web.css';

// Aviso global (modo WhatsApp Web): tem mensagem parada na fila e o app desktop não está enviando.
// As automações continuam enfileirando com o computador desligado — sem esse aviso, a fila crescia
// em silêncio. Oferece as duas saídas: abrir o app ou enviar pelo celular.
const REFRESH_MS = 60 * 1000;

function tempoDesde(iso: string | null): string {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `há ${Math.max(1, min)} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `há ${horas} h`;
  return `há ${plural(Math.floor(horas / 24), 'dia', 'dias')}`;
}

export function AlertaAppWhatsapp() {
  const { pathname } = useLocation();
  const [resumo, setResumo] = useState<WhatsappWebResumo | null>(null);
  const [dispensadoCom, setDispensadoCom] = useState<number | null>(null);

  useEffect(() => {
    let ativo = true;
    const carregar = () => {
      getWhatsappWebResumo()
        .then((r) => { if (ativo) setResumo(r); })
        .catch(() => { /* aviso é best-effort — sem ele a página segue normal */ });
    };
    carregar();
    const timer = window.setInterval(carregar, REFRESH_MS);
    return () => {
      ativo = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!resumo?.disponivel || resumo.provider !== 'whatsapp_web' || !resumo.agente) return null;
  const parados = resumo.fila?.pendentes ?? 0;
  const { agente } = resumo;
  if (parados === 0 || (agente.online && !agente.pausado)) return null;
  // Dispensar vale até a quantidade na fila mudar.
  if (dispensadoCom === parados) return null;

  const situacao = !agente.ultimoHeartbeatEm
    ? 'O app Envio WhatsApp ainda não foi conectado'
    : agente.online
      ? 'O app Envio WhatsApp está pausado'
      : `O app Envio WhatsApp está offline ${tempoDesde(agente.ultimoHeartbeatEm)}`;
  const naFila = pathname.startsWith('/admin/whatsapp/fila');

  return (
    <div className="wa-alerta-app" role="status">
      <p>
        <strong>{situacao}</strong> — {parados === 1 ? '1 mensagem parada' : `${parados} mensagens paradas`} na fila. Abra o app no computador
        {naFila ? ' ou use "Enviar pelo celular" abaixo.' : ' ou envie pelo celular.'}
      </p>
      <div className="wa-alerta-app__acoes">
        {!naFila && (
          <Link to="/admin/whatsapp/fila?modo=celular" className="ds-btn ds-btn--primary">
            Enviar pelo celular
          </Link>
        )}
        <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setDispensadoCom(parados)}>
          Dispensar
        </button>
      </div>
    </div>
  );
}
