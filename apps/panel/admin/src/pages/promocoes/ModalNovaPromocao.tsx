import { useState } from 'react';
import { Button, Field, Input, Modal } from '../../components/ds';
import { criarPromocao, type CriarPromocaoInput, type DiscountTier } from '../../api/promocoes';

// Porte de abrirModalNova() em src/promocoes.js — formulário dinâmico conforme o tipo de
// promoção escolhido (standard/progressive/unit_free).
type TipoPromocao = 'standard' | 'progressive' | 'unit_free';
type ListType = 'all' | 'products' | 'product_types' | 'collections';

interface TierRow {
  desconto: string;
  minimo: string;
}

function listaParaIds(texto: string): number[] {
  return texto
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
}

export function ModalNovaPromocao({
  open,
  onClose,
  onCriada,
}: {
  open: boolean;
  onClose: () => void;
  onCriada: () => void;
}) {
  const [tipo, setTipo] = useState<TipoPromocao>('standard');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percentage' | 'value'>('percentage');
  const [progressKind, setProgressKind] = useState<'cart_value' | 'cart_items'>('cart_value');
  const [listType, setListType] = useState<ListType>('all');
  const [idsTexto, setIdsTexto] = useState('');
  const [minCartItems, setMinCartItems] = useState('');
  const [discount, setDiscount] = useState('');
  const [minCartValue, setMinCartValue] = useState('');
  const [tiers, setTiers] = useState<TierRow[]>([
    { desconto: '', minimo: '' },
    { desconto: '', minimo: '' },
  ]);
  const [applyAutomatically, setApplyAutomatically] = useState(false);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function fechar() {
    setTipo('standard');
    setCode('');
    setKind('percentage');
    setProgressKind('cart_value');
    setListType('all');
    setIdsTexto('');
    setMinCartItems('');
    setDiscount('');
    setMinCartValue('');
    setTiers([{ desconto: '', minimo: '' }, { desconto: '', minimo: '' }]);
    setApplyAutomatically(false);
    setErro('');
    setSalvando(false);
    onClose();
  }

  function confirmar() {
    const codigo = code.trim();
    if (!codigo) {
      setErro('Informe o código.');
      return;
    }

    const payload: CriarPromocaoInput = {
      type: tipo,
      code: codigo,
      list_type: listType,
      apply_automatically: applyAutomatically,
    };
    const ids = idsTexto.trim() ? listaParaIds(idsTexto) : [];
    if (listType === 'products') payload.product_ids = ids;
    if (listType === 'product_types') payload.product_type_ids = ids;
    if (listType === 'collections') payload.collection_ids = ids;

    if (tipo === 'unit_free') {
      const minItens = Number(minCartItems);
      if (!minItens || minItens < 4 || minItens > 8) {
        setErro('Itens mínimos deve ser entre 4 e 8.');
        return;
      }
      payload.discount_tier = { min_cart_items: minItens };
    } else if (tipo === 'standard') {
      payload.kind = kind;
      const desc = Number(discount);
      if (!desc) {
        setErro('Informe o desconto.');
        return;
      }
      const tier: DiscountTier = { discount: desc };
      if (minCartValue) tier.min_cart_value = Number(minCartValue);
      if (minCartItems) tier.min_cart_items = Number(minCartItems);
      payload.discount_tier = tier;
    } else {
      payload.kind = kind;
      payload.progress_kind = progressKind;
      const discountTiers = tiers
        .map((t) => {
          const tier: DiscountTier = { discount: Number(t.desconto) };
          if (progressKind === 'cart_value') tier.min_cart_value = Number(t.minimo);
          else tier.min_cart_items = Number(t.minimo);
          return tier;
        })
        .filter((t) => t.discount);
      if (!discountTiers.length) {
        setErro('Informe ao menos 1 patamar.');
        return;
      }
      payload.discount_tiers = discountTiers;
    }

    setSalvando(true);
    criarPromocao(payload)
      .then(() => {
        fechar();
        onCriada();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <Modal open={open} onClose={fechar} title="Nova promoção" confirmLabel="Criar" confirmDisabled={salvando} onConfirm={confirmar}>
      <div className="pm-tipo-row">
        {(
          [
            ['standard', 'Desconto simples'],
            ['progressive', 'Progressiva'],
            ['unit_free', 'Compre N e ganhe 1'],
          ] as [TipoPromocao, string][]
        ).map(([value, label]) => (
          <label key={value}>
            <input type="radio" name="tipo-promo" checked={tipo === value} onChange={() => setTipo(value)} />
            {label}
          </label>
        ))}
      </div>

      <div className="tn-form">
        <Field label="Código">
          <Input placeholder="Ex: BEMVINDO10" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>

        {tipo !== 'unit_free' && (
          <Field label="Tipo de desconto">
            <select className="ds-select" value={kind} onChange={(e) => setKind(e.target.value as 'percentage' | 'value')}>
              <option value="percentage">Percentual</option>
              <option value="value">Valor fixo</option>
            </select>
          </Field>
        )}

        {tipo === 'progressive' && (
          <Field label="Progride por">
            <select className="ds-select" value={progressKind} onChange={(e) => setProgressKind(e.target.value as 'cart_value' | 'cart_items')}>
              <option value="cart_value">Valor do carrinho</option>
              <option value="cart_items">Itens no carrinho</option>
            </select>
          </Field>
        )}

        <Field label="Aplica em">
          <select className="ds-select" value={listType} onChange={(e) => setListType(e.target.value as ListType)}>
            <option value="all">Toda a loja</option>
            <option value="products">Produtos específicos</option>
            <option value="product_types">Tipos de produto</option>
            <option value="collections">Categorias</option>
          </select>
        </Field>
        <Field label="IDs (produtos/tipos/categorias, conforme acima)">
          <Input placeholder="Ex: 12, 34" value={idsTexto} onChange={(e) => setIdsTexto(e.target.value)} />
        </Field>

        {tipo === 'unit_free' && (
          <Field label="Itens mínimos no carrinho (4 a 8)">
            <Input type="number" value={minCartItems} onChange={(e) => setMinCartItems(e.target.value)} />
          </Field>
        )}
        {tipo === 'standard' && (
          <>
            <Field label="Desconto">
              <Input type="number" placeholder="Ex: 10" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </Field>
            <Field label="Valor mínimo do carrinho (opcional)">
              <Input type="number" value={minCartValue} onChange={(e) => setMinCartValue(e.target.value)} />
            </Field>
            <Field label="Itens mínimos (opcional)">
              <Input type="number" value={minCartItems} onChange={(e) => setMinCartItems(e.target.value)} />
            </Field>
          </>
        )}
        {tipo === 'progressive' && (
          <>
            <p className="ds-form-note">Patamares (1 por linha): desconto, mínimo</p>
            {tiers.map((t, i) => (
              <div className="pm-tier-row" key={i}>
                <input
                  className="ds-input"
                  aria-label={`Desconto (%) do patamar ${i + 1}`}
                  placeholder="Desconto (%)"
                  type="number"
                  value={t.desconto}
                  onChange={(e) => setTiers((prev) => prev.map((row, idx) => (idx === i ? { ...row, desconto: e.target.value } : row)))}
                />
                <input
                  className="ds-input"
                  aria-label={`Mínimo do patamar ${i + 1}`}
                  placeholder="Mínimo"
                  value={t.minimo}
                  onChange={(e) => setTiers((prev) => prev.map((row, idx) => (idx === i ? { ...row, minimo: e.target.value } : row)))}
                />
              </div>
            ))}
            <Button variant="ghost" onClick={() => setTiers((prev) => [...prev, { desconto: '', minimo: '' }])}>
              + patamar
            </Button>
          </>
        )}

        <label className="ds-check-row">
          <input type="checkbox" checked={applyAutomatically} onChange={(e) => setApplyAutomatically(e.target.checked)} />
          {' '}Aplicar automaticamente (sem digitar código)
        </label>
      </div>

      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}
