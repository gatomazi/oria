import { useState } from 'react';
import { Button, Card, EmptyState, Field, FormActions, Input, PageHeader, PageStack, Stepper } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { useLojaAtiva } from '../../auth/AuthContext';
import { formatValor } from '../../lib/format';
import { EXCHANGE_REASONS } from '../../lib/statusMap';
import { criarTroca, getPedidoCentral, type CentralOrder } from '../../api/trocas';

import '../../../../src/pedidos-central.css';
import '../../../../src/trocas-nova.css';

// Porte do wizard de 6 passos em src/trocas-nova.js.
const STEP_LABELS = ['Pedido', 'Motivo', 'Itens', 'Nova opção', 'Evidências', 'Revisão'];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma !== -1 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface SelectedItem {
  quantity: number;
  product_v2_id: number | null;
  product_variant_id: number | null;
}

interface WizardState {
  step: number;
  loja: string;
  orderId: string;
  order: CentralOrder | null;
  buscaErro: string | null;
  reason: string | null;
  selected: Record<number, SelectedItem>;
  problemDescription: string;
  photos: { name: string; base64: string }[];
  criarErro: string | null;
  criando: boolean;
}

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="pc-kv__row">
      <span className="pc-kv__label">{label}</span>
      <span className="pc-kv__value">{value == null || value === '' ? '—' : String(value)}</span>
    </div>
  );
}

export function TrocasNovaPage() {
  const storeSelecionada = useLojaAtiva() ?? '';
  const [wizard, setWizard] = useState<WizardState>(() => ({
    step: 0,
    loja: storeSelecionada,
    orderId: '',
    order: null,
    buscaErro: null,
    reason: null,
    selected: {},
    problemDescription: '',
    photos: [],
    criarErro: null,
    criando: false,
  }));
  const [buscando, setBuscando] = useState(false);

  function patch(p: Partial<WizardState>) {
    setWizard((w) => ({ ...w, ...p }));
  }

  function reasonMeta(value: string | null) {
    return EXCHANGE_REASONS.find((r) => r.value === value) || null;
  }

  function exigeSuporte() {
    return !!reasonMeta(wizard.reason)?.suporte;
  }

  function itensSelecionados(): number[] {
    return Object.keys(wizard.selected).map(Number);
  }

  function podeAvancar(): boolean {
    switch (wizard.step) {
      case 0:
        return !!(wizard.order && wizard.order.exchangeable);
      case 1:
        return !!wizard.reason;
      case 2:
        return itensSelecionados().length > 0;
      case 3:
        return itensSelecionados().every((id) => {
          const s = wizard.selected[id];
          return Number.isInteger(s.product_v2_id) && Number.isInteger(s.product_variant_id);
        });
      case 4:
        if (!exigeSuporte()) return true;
        return !!(wizard.problemDescription.trim() && wizard.photos.length);
      default:
        return true;
    }
  }

  function buscarPedido() {
    const id = Number(wizard.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      patch({ buscaErro: 'Informe um número de pedido válido.', order: null });
      return;
    }
    setBuscando(true);
    getPedidoCentral(id)
      .then((data) => {
        setBuscando(false);
        patch({ order: data.order, buscaErro: null });
      })
      .catch((err: Error) => {
        setBuscando(false);
        patch({ order: null, buscaErro: err.message });
      });
  }

  function renderStep0() {
    return (
      <div className="tn-form">
        <Field label="Número do pedido">
          <Input type="number" value={wizard.orderId} onChange={(e) => patch({ orderId: e.target.value })} />
        </Field>
        <Button variant="secondary" disabled={buscando} onClick={buscarPedido}>
          Buscar pedido
        </Button>
        {wizard.buscaErro && <p className="ds-form-error" role="alert">{wizard.buscaErro}</p>}
        {!wizard.buscaErro && wizard.order && (
          <>
            <div className="pc-kv">
              <Row label="Cliente" value={[wizard.order.buyer?.first_name, wizard.order.buyer?.last_name].filter(Boolean).join(' ')} />
              <Row label="Valor" value={formatValor(wizard.order.total_value)} />
              <Row label="Status do pedido" value={wizard.order.order_status} />
            </div>
            {!wizard.order.exchangeable ? (
              <p className="ds-form-error" role="alert">Este pedido não está elegível para troca pela Reserva Ink agora (campo "exchangeable" retornou falso).</p>
            ) : (
              <p className="pc-nota">Pedido elegível para troca.</p>
            )}
          </>
        )}
      </div>
    );
  }

  function renderStep1() {
    return (
      <div className="tn-form">
        <p className="pc-nota">Qual é o motivo da troca?</p>
        {EXCHANGE_REASONS.map((r) => (
          <label className="tn-radio-row" key={r.value}>
            <input
              type="radio"
              name="motivo"
              value={r.value}
              checked={wizard.reason === r.value}
              onChange={() => patch({ reason: r.value })}
            />
            {r.label}
            {r.suporte ? ' (exige aprovação do suporte)' : ''}
          </label>
        ))}
      </div>
    );
  }

  function renderStep2() {
    const items = wizard.order?.items || [];
    if (!items.length) return <EmptyState title="Pedido sem itens" />;
    return (
      <div className="tn-form">
        {items.map((item) => {
          const sel = wizard.selected[item.id];
          return (
            <div className="tn-item-row" key={item.id}>
              <input
                type="checkbox"
                checked={!!sel}
                onChange={(e) => {
                  const next = { ...wizard.selected };
                  if (e.target.checked) {
                    next[item.id] = {
                      quantity: item.quantity || 1,
                      product_v2_id: item.product_v2?.id ?? null,
                      product_variant_id: item.product_variant?.id ?? null,
                    };
                  } else {
                    delete next[item.id];
                  }
                  patch({ selected: next });
                }}
              />
              <span className="tn-item-row__nome">
                {item.product_v2?.name || `Item #${item.id}`} · {item.quantity || 1}x
              </span>
              <input
                type="number"
                className="ds-input ds-input--sm"
                aria-label={`Quantidade a trocar de ${item.product_v2?.name || `item #${item.id}`}`}
                min="1"
                max={String(item.quantity || 1)}
                value={sel?.quantity ?? item.quantity ?? 1}
                disabled={!sel}
                onChange={(e) => {
                  if (!sel) return;
                  const next = { ...wizard.selected, [item.id]: { ...sel, quantity: Number(e.target.value) || 1 } };
                  patch({ selected: next });
                }}
              />
            </div>
          );
        })}
      </div>
    );
  }

  function renderStep3() {
    const ids = itensSelecionados();
    if (!ids.length) return <EmptyState title="Volte e selecione ao menos 1 item" />;
    return (
      <div className="tn-form">
        {ids.map((id) => {
          const item = (wizard.order?.items || []).find((i) => i.id === id);
          const sel = wizard.selected[id];
          return (
            <div className="tn-nova-opcao" key={id}>
              <div className="tn-nova-opcao__titulo">{item?.product_v2?.name || `Item #${id}`}</div>
              <div className="tn-nova-opcao__campos">
                <Field label="Produto">
                  <input
                    type="number"
                    className="ds-input"
                    placeholder="ID do produto"
                    value={sel.product_v2_id ?? ''}
                    onChange={(e) => patch({ selected: { ...wizard.selected, [id]: { ...sel, product_v2_id: Number(e.target.value) || null } } })}
                  />
                </Field>
                <Field label="Variante">
                  <input
                    type="number"
                    className="ds-input"
                    placeholder="ID da variante"
                    value={sel.product_variant_id ?? ''}
                    onChange={(e) => patch({ selected: { ...wizard.selected, [id]: { ...sel, product_variant_id: Number(e.target.value) || null } } })}
                  />
                </Field>
              </div>
              <p className="pc-nota">Sem catálogo integrado ainda — confira o ID na tela de Pedidos ou peça pro time de catálogo.</p>
            </div>
          );
        })}
      </div>
    );
  }

  function renderStep4() {
    if (!exigeSuporte()) {
      return (
        <EmptyState
          title="Não é necessário para esse motivo"
          description="Só motivos de defeito, posição ou qualidade de impressão exigem descrição e fotos."
        />
      );
    }
    return (
      <div className="tn-form">
        <Field label="Descreva o problema">
          <textarea
            className="ds-textarea"
            maxLength={1000}
            value={wizard.problemDescription}
            onChange={(e) => patch({ problemDescription: e.target.value })}
          />
        </Field>
        <Field label="Fotos" hint="Pelo menos 1 foto do problema.">
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              Promise.all(files.map((f) => fileToBase64(f).then((base64) => ({ name: f.name, base64 })))).then((fotos) =>
                patch({ photos: fotos }),
              );
            }}
          />
        </Field>
        <ul className="pc-timeline">
          {wizard.photos.map((f, i) => (
            <li key={i}>{f.name}</li>
          ))}
        </ul>
      </div>
    );
  }

  function criar() {
    patch({ criando: true, criarErro: null });
    const body = {
      original_order_id: Number(wizard.orderId),
      exchange_reason: wizard.reason as string,
      items: itensSelecionados().map((id) => {
        const s = wizard.selected[id];
        return { old_item_id: id, product_v2_id: s.product_v2_id, product_variant_id: s.product_variant_id, quantity: s.quantity };
      }),
      ...(exigeSuporte()
        ? { problem_description: wizard.problemDescription, photos: wizard.photos.map((f) => ({ photo_attachment: f.base64 })) }
        : {}),
    };
    criarTroca(body)
      .then(() => {
        window.location.href = '/admin/trocas';
      })
      .catch((err: Error) => patch({ criando: false, criarErro: err.message }));
  }

  function renderStep5() {
    return (
      <div className="tn-form">
        <div className="pc-kv">
          <Row label="Loja" value={adminStores.name(wizard.loja)} />
          <Row label="Pedido" value={`#${wizard.orderId}`} />
          <Row label="Motivo" value={reasonMeta(wizard.reason)?.label} />
          <Row label="Itens" value={itensSelecionados().length} />
          {exigeSuporte() && <Row label="Fotos anexadas" value={wizard.photos.length} />}
        </div>
        {wizard.criarErro && <p className="ds-form-error" role="alert">{wizard.criarErro}</p>}
        <Button variant="primary" disabled={wizard.criando} onClick={criar}>
          {wizard.criando ? 'Criando…' : 'Criar troca'}
        </Button>
      </div>
    );
  }

  const STEP_RENDERERS = [renderStep0, renderStep1, renderStep2, renderStep3, renderStep4, renderStep5];

  return (
    <PageStack>
      <PageHeader title="Nova troca" description="Crie uma troca pra um pedido elegível." />
      <Stepper steps={STEP_LABELS} current={wizard.step} label="Etapas da nova troca" />
      <Card>{STEP_RENDERERS[wizard.step]()}</Card>
      <FormActions
        start={
          <Button variant="secondary" disabled={wizard.step === 0} onClick={() => patch({ step: wizard.step - 1 })}>
            Voltar
          </Button>
        }
      >
        {wizard.step < STEP_RENDERERS.length - 1 && (
          <Button variant="primary" disabled={!podeAvancar()} onClick={() => patch({ step: wizard.step + 1 })}>
            Continuar
          </Button>
        )}
      </FormActions>
    </PageStack>
  );
}
