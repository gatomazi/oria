import { useState } from 'react';
import { Button, Callout, Card, ConfirmDialog } from '../../components/ds';
import { afiliados } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { toast } from '../../lib/toast';
import { dataHora, mensagemDoErro, plural } from '../../lib/parcerias';
import { useParcerias } from './ParceriasLayout';

// Link público (capability URL) do PARCEIRO ver as próprias vendas/comissão/saldo — NÃO é login: sem
// conta, sem senha, sem e-mail. O segredo vai no FRAGMENTO da URL (depois de `#`), nunca na parte que
// o navegador manda ao servidor — mesmo cuidado de src/pages/convite/AceitarConvitePage.tsx. O token
// só existe na resposta de "Gerar link"/"Gerar novo link"; depois disso não há como recuperá-lo — só
// gerar outro (o que revoga o anterior na hora).
function montarUrl(token: string): string {
  return `${window.location.origin}/parcerias/preview#key=${token}`;
}

export function PreviewLinkCard({ partnerId }: { partnerId: string }) {
  const { isOwner, tz } = useParcerias();
  const { dado, carregando, recarregar } = useAsync(() => afiliados.statusDoLinkPreview(partnerId), [partnerId]);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [linkRevelado, setLinkRevelado] = useState<string | null>(null); // só existe em memória, nunca persiste
  const [confirmarRevogar, setConfirmarRevogar] = useState(false);

  if (!isOwner) return null;

  async function gerar() {
    setEnviando(true); setErro('');
    try {
      const r = await afiliados.gerarLinkPreview(partnerId);
      setLinkRevelado(montarUrl(r.token));
      recarregar();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  async function revogar() {
    setEnviando(true); setErro('');
    try { await afiliados.revogarLinkPreview(partnerId); setLinkRevelado(null); toast('Link público revogado.', 'sucesso'); recarregar(); }
    catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); setConfirmarRevogar(false); }
  }
  async function copiar(url: string) {
    try { await navigator.clipboard.writeText(url); toast('Link copiado.', 'sucesso'); } catch { toast('Não deu para copiar automaticamente — selecione o link e copie manualmente.', 'erro'); }
  }

  return (
    <Card
      title="Link público do parceiro" description="Leitura só dele: vendas, comissão e saldo — sem login, sem senha. Quem tem o link, vê; ninguém mais."
      action={dado && !carregando ? (
        dado.ativo
          ? <span className="pa-badges"><Button size="sm" variant="secondary" onClick={gerar} disabled={enviando}>Gerar novo link</Button><Button size="sm" variant="danger" onClick={() => setConfirmarRevogar(true)} disabled={enviando}>Revogar</Button></span>
          : <Button size="sm" onClick={gerar} disabled={enviando}>{enviando ? 'Gerando…' : 'Gerar link'}</Button>
      ) : undefined}
    >
      {carregando && !dado && <p className="pa-aviso">Carregando…</p>}
      {dado && !dado.ativo && !linkRevelado && <p className="pa-aviso">Nenhum link gerado ainda. Gerar cria um novo; o parceiro não é avisado automaticamente — envie o link a ele por fora.</p>}
      {dado?.ativo && (
        <p className="pa-aviso">
          Ativo desde {dataHora(dado.createdAt, tz)} · {plural(dado.accessCount ?? 0, 'acesso')}
          {dado.lastAccessedAt ? ` · último em ${dataHora(dado.lastAccessedAt, tz)}` : ' · ainda não acessado'}.
        </p>
      )}
      {linkRevelado && (
        <Callout tone="warning" title="Copie agora">
          Por segurança, este link só aparece uma vez. Se perder, gere um novo (o antigo para de funcionar na hora).
          <div className="pa-shell pa-mt-3"><code className="pa-num" style={{ wordBreak: 'break-all', userSelect: 'all' }}>{linkRevelado}</code></div>
          <div className="pa-mt-3"><Button size="sm" onClick={() => copiar(linkRevelado)}>Copiar link</Button></div>
        </Callout>
      )}
      {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      <ConfirmDialog
        open={confirmarRevogar} onClose={() => setConfirmarRevogar(false)} title="Revogar o link público?"
        description="O link para de funcionar na hora. O parceiro que estiver com ele aberto deixa de ver dados novos." confirmLabel="Revogar" confirmVariant="danger"
        onConfirm={revogar}
      />
    </Card>
  );
}
