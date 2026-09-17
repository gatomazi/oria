import { useRef, useState, type FormEvent } from 'react';
import { Button, Callout, Card, Field, FormActions, FormGrid, FormStack, Input, PageHeader, PageStack, Textarea } from '../../components/ds';
import { copiar } from '../../lib/format';
import { criarPixManual, qrPreview } from '../../api/pedidoAdmin';

import '../../../../src/pedidos-central.css';

// Porte de src/pedido-novo.js (Fase 3, docs/plan.md).
export function PedidoNovoPage() {
  const [cliente, setCliente] = useState('');
  const [referencia, setReferencia] = useState('');
  const [valor, setValor] = useState('');
  const [pixCode, setPixCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrMsg, setQrMsg] = useState('Cole o código Pix acima para gerar o QR.');
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultadoUrl, setResultadoUrl] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  function onPixCodeChange(value: string) {
    setPixCode(value);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    const codigo = value.trim();
    if (codigo.length < 10) {
      setQrDataUrl(null);
      setQrMsg('Cole o código Pix acima para gerar o QR.');
      return;
    }
    setQrMsg('Gerando prévia…');
    previewTimer.current = setTimeout(() => {
      qrPreview(codigo)
        .then((data) => {
          setQrDataUrl(data.dataUrl);
          setQrMsg('Prévia do QR que será enviado ao cliente.');
        })
        .catch((err: Error) => {
          setQrDataUrl(null);
          setQrMsg(err.message);
        });
    }, 500);
  }

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    setResultadoUrl(null);
    setSalvando(true);
    criarPixManual({ cliente: cliente.trim(), referencia: referencia.trim(), valor: valor.trim(), pixCode: pixCode.trim() })
      .then((data) => {
        setResultadoUrl(window.location.origin + data.url);
        setCliente('');
        setReferencia('');
        setValor('');
        setPixCode('');
        setQrDataUrl(null);
        setQrMsg('Cole o código Pix acima para gerar o QR.');
      })
      .catch((err: Error) => setErro(err.message))
      .finally(() => setSalvando(false));
  }

  return (
    <PageStack>
      <PageHeader title="Novo Pix manual" back={{ to: '/admin/pedidos', label: 'Voltar pra lista' }} />

      {resultadoUrl && (
        <Callout
          tone="success"
          title="Link de pagamento gerado"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                copiar(resultadoUrl, () => {
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 1800);
                })
              }
            >
              {copiado ? 'Copiado!' : 'Copiar link'}
            </Button>
          }
        >
          <span className="ds-num">{resultadoUrl}</span>
        </Callout>
      )}

      <Card>
        <FormStack onSubmit={handleSubmit}>
          <FormGrid>
            <Field label="Valor em R$ (opcional)">
              <Input type="text" placeholder="ex: 129.90" value={valor} onChange={(e) => setValor(e.target.value)} />
            </Field>
          </FormGrid>

          <Field label="Nome do cliente (opcional)">
            <Input type="text" maxLength={120} value={cliente} onChange={(e) => setCliente(e.target.value)} />
          </Field>

          <Field label="Referência do seu pedido (opcional)" hint="Só para você localizar depois — não aparece no link do cliente.">
            <Input type="text" maxLength={60} value={referencia} onChange={(e) => setReferencia(e.target.value)} />
          </Field>

          <Field label="Código Pix copia e cola" required>
            <Textarea required value={pixCode} onChange={(e) => onPixCodeChange(e.target.value)} />
          </Field>

          <Field label="QR Code (gerado automaticamente)">
            <div>
              {qrDataUrl && <img className="pa-file-preview pa-file-preview--visivel" src={qrDataUrl} alt="QR Code do Pix" />}
              <p className="pc-nota">{qrMsg}</p>
            </div>
          </Field>

          {erro && (
            <p className="ds-form-error" role="alert">
              {erro}
            </p>
          )}
          <FormActions>
            <Button type="submit" disabled={salvando}>
              {salvando ? 'Gerando…' : 'Gerar link de pagamento'}
            </Button>
          </FormActions>
        </FormStack>
      </Card>
    </PageStack>
  );
}
