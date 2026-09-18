import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Field, FormActions, Icon, Input, PageHeader, PageStack, StatusBadge, Stepper } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { useLojaAtiva } from '../../auth/AuthContext';
import { listCategorias, type Categoria } from '../../api/categorias';
import { criarProduto, listProdutoTipos, type ProdutoTipo, type ProdutoTipoArea } from '../../api/produtos';

import '../../pedidos-central.css';
import '../../trocas-nova.css';
import '../../produtos-novo.css';

// Porte de src/produtos-novo.js — wizard de 6 passos. Estado único (`wizard`) espelha o objeto
// mutável original, só que via useState + updateWizard(patch) em vez de mutação direta.
const STEP_LABELS = ['Tipo', 'Informações', 'Arte', 'Variantes', 'Categorias', 'Revisão'];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function base64DoDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

function mimeDoDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl);
  return match ? match[1] : 'image/png';
}

function tituloArea(area: ProdutoTipoArea) {
  return [area.model, area.color?.name].filter(Boolean).join(' · ') || area.description || `Área #${area.base_image_id}`;
}

// "Tamanho" costuma ser a única opção realmente variável por SKU — cor/modelo já vêm fixados
// pela área de impressão escolhida.
function acharOpcaoTamanho(productType: ProdutoTipo) {
  return (productType.options || []).find((o) => /tamanho|size/i.test(o.name)) || null;
}

interface AreaSelecionada {
  meta: ProdutoTipoArea;
  base64: string;
  mime: string;
}

// Uma arte pode valer pra várias cores/versões ao mesmo tempo — igual no painel da Ink (escolhe
// a arte, depois marca em quais cores ela entra), em vez de exigir 1 arquivo por área. Estado
// local só de agrupamento; a fonte de verdade que sobrevive entre passos continua sendo
// `wizard.areasSelecionadas` (reconstruída aqui a partir dela ao entrar no passo).
interface GrupoArte {
  id: string;
  dataUrl: string;
  areaIds: number[];
}

function PassoArte({
  areas,
  areasSelecionadas,
  onChange,
}: {
  areas: ProdutoTipoArea[];
  areasSelecionadas: Record<number, AreaSelecionada>;
  onChange: (next: Record<number, AreaSelecionada>) => void;
}) {
  const [grupos, setGrupos] = useState<GrupoArte[]>(() => {
    const porBase64 = new Map<string, number[]>();
    for (const area of areas) {
      const sel = areasSelecionadas[area.base_image_id];
      if (!sel) continue;
      const lista = porBase64.get(sel.base64) || [];
      lista.push(area.base_image_id);
      porBase64.set(sel.base64, lista);
    }
    // Reconstrói o data URL com o mime original (guardado em cada área selecionada) — sem isso o
    // preview quebraria ao voltar/avançar entre passos (mime desconhecido não renderiza).
    const mimePorBase64 = new Map<string, string>();
    for (const sel of Object.values(areasSelecionadas)) mimePorBase64.set(sel.base64, sel.mime);
    return Array.from(porBase64.entries()).map(([base64, areaIds]) => ({
      id: crypto.randomUUID(),
      dataUrl: `data:${mimePorBase64.get(base64) || 'image/png'};base64,${base64}`,
      areaIds,
    }));
  });

  function aplicar(novosGrupos: GrupoArte[]) {
    setGrupos(novosGrupos);
    const next: Record<number, AreaSelecionada> = {};
    for (const g of novosGrupos) {
      const base64 = base64DoDataUrl(g.dataUrl);
      const mime = mimeDoDataUrl(g.dataUrl);
      for (const areaId of g.areaIds) {
        const meta = areas.find((a) => a.base_image_id === areaId);
        if (meta) next[areaId] = { meta, base64, mime };
      }
    }
    onChange(next);
  }

  function donoDaArea(areaId: number): string | null {
    return grupos.find((g) => g.areaIds.includes(areaId))?.id ?? null;
  }

  return (
    <div className="pn-artes">
      <p className="pc-nota">
        Envie 1 arte e marque em quais cores/versões ela entra — como no painel da Ink (a mesma arte pode valer pra várias cores).
      </p>

      {grupos.map((g, i) => (
        <div key={g.id} className="pn-arte-grupo">
          <div className="pn-arte-grupo__topo">
            <img className="pn-arte-grupo__preview" src={g.dataUrl} alt="" />
            <div className="pn-arte-grupo__info">
              <strong>Arte {i + 1}</strong>
              <span className="pc-nota">{g.areaIds.length === 1 ? '1 cor selecionada' : `${g.areaIds.length} cores selecionadas`}</span>
            </div>
            <Button variant="secondary" onClick={() => aplicar(grupos.filter((x) => x.id !== g.id))}>
              Remover
            </Button>
          </div>
          <div className="pn-arte-grupo__areas">
            {areas.map((area) => {
              const dono = donoDaArea(area.base_image_id);
              const marcada = dono === g.id;
              const indisponivel = !!dono && !marcada;
              return (
                <label key={area.base_image_id} className={'pn-area-chip' + (indisponivel ? ' pn-area-chip--indisponivel' : '')}>
                  <input
                    type="checkbox"
                    checked={marcada}
                    disabled={indisponivel}
                    onChange={(e) => {
                      const marcar = e.target.checked;
                      aplicar(
                        grupos.map((x) => {
                          if (x.id === g.id) {
                            return {
                              ...x,
                              areaIds: marcar ? [...x.areaIds, area.base_image_id] : x.areaIds.filter((id) => id !== area.base_image_id),
                            };
                          }
                          // Cada área pertence a no máximo 1 arte — marcar aqui tira de onde estava.
                          return marcar ? { ...x, areaIds: x.areaIds.filter((id) => id !== area.base_image_id) } : x;
                        }),
                      );
                    }}
                  />
                  {tituloArea(area)}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <Field label={grupos.length ? 'Adicionar outra arte' : 'Adicionar arte'}>
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const dataUrl = await fileToDataUrl(file);
            aplicar([...grupos, { id: crypto.randomUUID(), dataUrl, areaIds: [] }]);
            e.target.value = '';
          }}
        />
      </Field>
    </div>
  );
}

interface WizardState {
  step: number;
  loja: string;
  tipos: ProdutoTipo[] | null;
  productType: ProdutoTipo | null;
  areasSelecionadas: Record<number, AreaSelecionada>;
  name: string;
  description: string;
  price: string;
  tagsTexto: string;
  visibleInStore: boolean;
  customizableByBuyer: boolean;
  categorias: Categoria[] | null;
  categoriasSelecionadas: Record<number, boolean>;
  novasCategorias: string[];
  criando: boolean;
  criarErro: string | null;
}

export function ProdutosNovoPage() {
  const lojaSelecionada = useLojaAtiva() ?? '';
  const [wizard, setWizard] = useState<WizardState>(() => ({
    step: 0,
    loja: lojaSelecionada,
    tipos: null,
    productType: null,
    areasSelecionadas: {},
    name: '',
    description: '',
    price: '',
    tagsTexto: '',
    visibleInStore: true,
    customizableByBuyer: false,
    categorias: null,
    categoriasSelecionadas: {},
    novasCategorias: [],
    criando: false,
    criarErro: null,
  }));

  function update(patch: Partial<WizardState>) {
    setWizard((w) => ({ ...w, ...patch }));
  }

  useEffect(() => {
    listProdutoTipos()
      .then((data) => update({ tipos: data.tipos || [] }))
      .catch(() => update({ tipos: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard.loja]);

  useEffect(() => {
    if (wizard.step === 4 && wizard.categorias == null) {
      listCategorias()
        .then((data) => update({ categorias: data.categorias || [] }))
        .catch(() => update({ categorias: [] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard.step, wizard.loja]);

  function podeAvancar(): boolean {
    switch (wizard.step) {
      case 0:
        return !!wizard.productType;
      case 1:
        return !!(wizard.name.trim() && wizard.price.trim());
      case 2:
        return Object.keys(wizard.areasSelecionadas).length > 0;
      default:
        return true;
    }
  }

  function criar() {
    if (!wizard.productType) return;
    update({ criando: true, criarErro: null });
    const tags = wizard.tagsTexto.split(',').map((t) => t.trim()).filter(Boolean);

    // Agrupa por arte (base64) — a mesma arte usada em várias cores manda o arquivo 1x só,
    // não 1x por área (senão o upload trava num produto com várias cores/versões).
    const idsPorBase64 = new Map<string, number[]>();
    for (const [baseImageId, a] of Object.entries(wizard.areasSelecionadas)) {
      const lista = idsPorBase64.get(a.base64) || [];
      lista.push(Number(baseImageId));
      idsPorBase64.set(a.base64, lista);
    }
    const artGroups = Array.from(idsPorBase64.entries()).map(([base64, base_image_ids]) => ({
      base_image_ids,
      art_attachment: base64,
    }));

    criarProduto({
      productTypeId: wizard.productType.id,
      name: wizard.name.trim(),
      description: wizard.description.trim() || undefined,
      price: wizard.price.trim(),
      tags,
      visibleInStore: wizard.visibleInStore,
      customizableByBuyer: wizard.customizableByBuyer,
      collections: Object.keys(wizard.categoriasSelecionadas).map(Number),
      newCollections: wizard.novasCategorias,
      artGroups,
    })
      .then(() => {
        window.location.href = '/admin/produtos';
      })
      .catch((err: Error) => update({ criando: false, criarErro: err.message }));
  }

  return (
    <PageStack>
      <PageHeader title="Novo produto" description="Crie um produto sob demanda pra sua loja." />

      <Stepper steps={STEP_LABELS} current={wizard.step} label="Etapas do novo produto" />

      <Card>
        {wizard.step === 0 && (
          <div className="tn-form">
            {!wizard.tipos ? (
              <p className="pc-nota">Carregando tipos de produto…</p>
            ) : (
              <div className="pn-tipos-grid">
                {wizard.tipos.map((t) => {
                  const thumb = t.printable_areas?.[0]?.mockup_url;
                  const selecionado = wizard.productType?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={'pn-tipo-card' + (selecionado ? ' pn-tipo-card--selecionado' : '')}
                      onClick={() => update({ productType: t, areasSelecionadas: {} })}
                    >
                      {thumb ? (
                        <img className="pn-tipo-card__img" src={thumb} alt="" />
                      ) : (
                        <div className="pn-tipo-card__img pn-tipo-card__img--placeholder" />
                      )}
                      <span className="pn-tipo-card__nome">{t.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {wizard.step === 1 && (
          <div className="tn-form">
            <Field label="Nome do produto">
              <Input value={wizard.name} onChange={(e) => update({ name: e.target.value })} />
            </Field>
            <Field label="Descrição">
              <textarea className="ds-textarea" value={wizard.description} onChange={(e) => update({ description: e.target.value })} />
            </Field>
            <Field label="Preço">
              <Input placeholder="Ex: 129.90" value={wizard.price} onChange={(e) => update({ price: e.target.value })} />
            </Field>
            <Field label="Tags (separadas por vírgula)">
              <Input value={wizard.tagsTexto} onChange={(e) => update({ tagsTexto: e.target.value })} />
            </Field>
            <label className="ds-check-row">
              <input type="checkbox" checked={wizard.visibleInStore} onChange={(e) => update({ visibleInStore: e.target.checked })} />
              {' '}Visível na loja assim que aprovado
            </label>
            <label className="ds-check-row">
              <input
                type="checkbox"
                checked={wizard.customizableByBuyer}
                onChange={(e) => update({ customizableByBuyer: e.target.checked })}
              />
              {' '}Personalizável pelo comprador
            </label>
          </div>
        )}

        {wizard.step === 2 &&
          (() => {
            const areas = wizard.productType?.printable_areas || [];
            if (!areas.length) return <EmptyState title="Esse tipo não tem áreas de impressão configuradas" />;
            return (
              <PassoArte
                areas={areas}
                areasSelecionadas={wizard.areasSelecionadas}
                onChange={(areasSelecionadas) => update({ areasSelecionadas })}
              />
            );
          })()}

        {wizard.step === 3 &&
          (() => {
            const opcaoTamanho = wizard.productType ? acharOpcaoTamanho(wizard.productType) : null;
            const areas = Object.values(wizard.areasSelecionadas);
            if (!areas.length) return <EmptyState title="Volte e selecione ao menos 1 arte" />;
            return (
              <div>
                <p className="pc-nota">
                  Prévia — a Reserva Ink cria essas variantes automaticamente a partir da arte enviada. Não é possível escolher tamanhos
                  manualmente aqui.
                </p>
                <ul className="pn-variantes-preview">
                  {areas.flatMap((a, i) => {
                    const base = [a.meta.model, a.meta.color?.name].filter(Boolean).join(' · ');
                    if (opcaoTamanho?.values?.length) {
                      return opcaoTamanho.values.map((tamanho) => (
                        <li key={`${i}-${tamanho}`}>
                          {base} · {tamanho}
                        </li>
                      ));
                    }
                    return [<li key={i}>{base}</li>];
                  })}
                </ul>
              </div>
            );
          })()}

        {wizard.step === 4 && (
          <div className="tn-form pn-categorias">
            {(wizard.categorias || []).map((c) => (
              <label key={c.id} className="pn-categoria-row">
                <input
                  type="checkbox"
                  checked={!!wizard.categoriasSelecionadas[c.id]}
                  onChange={(e) => {
                    const next = { ...wizard.categoriasSelecionadas };
                    if (e.target.checked) next[c.id] = true;
                    else delete next[c.id];
                    update({ categoriasSelecionadas: next });
                  }}
                />
                {c.name}
              </label>
            ))}
            <Field label="Adicionar categoria nova">
              <Input
                placeholder="Nome da categoria"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const valor = (e.target as HTMLInputElement).value.trim();
                  if (!valor) return;
                  update({ novasCategorias: [...wizard.novasCategorias, valor] });
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            </Field>
            <div className="ds-button-row">
              {wizard.novasCategorias.map((nome, i) => (
                <button
                  type="button"
                  key={i}
                  className="pn-chip-remover"
                  aria-label={`Remover categoria nova ${nome}`}
                  onClick={() => update({ novasCategorias: wizard.novasCategorias.filter((_, idx) => idx !== i) })}
                >
                  <StatusBadge tone="info" label={nome} />
                  <Icon name="close" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}

        {wizard.step === 5 &&
          (() => {
            function row(label: string, value: string | number | null | undefined) {
              return (
                <div className="pc-kv__row" key={label}>
                  <span className="pc-kv__label">{label}</span>
                  <span className="pc-kv__value">{value == null || value === '' ? '—' : String(value)}</span>
                </div>
              );
            }
            return (
              <div className="tn-form">
                <div className="pc-kv">
                  {row('Loja', adminStores.name(wizard.loja))}
                  {row('Tipo', wizard.productType?.name)}
                  {row('Nome', wizard.name)}
                  {row('Preço', wizard.price)}
                  {row('Áreas de arte selecionadas', Object.keys(wizard.areasSelecionadas).length)}
                  {row('Categorias existentes', Object.keys(wizard.categoriasSelecionadas).length)}
                  {row('Categorias novas', wizard.novasCategorias.join(', ') || null)}
                </div>
                {wizard.criarErro && <p className="ds-form-error">{wizard.criarErro}</p>}
                <Button variant="primary" disabled={wizard.criando} onClick={criar}>
                  {wizard.criando ? 'Enviando…' : 'Criar produto'}
                </Button>
              </div>
            );
          })()}
      </Card>

      <FormActions
        start={
          <Button variant="secondary" disabled={wizard.step === 0} onClick={() => update({ step: wizard.step - 1 })}>
            Voltar
          </Button>
        }
      >
        {wizard.step < STEP_LABELS.length - 1 && (
          <Button variant="primary" disabled={!podeAvancar()} onClick={() => update({ step: wizard.step + 1 })}>
            Continuar
          </Button>
        )}
      </FormActions>
    </PageStack>
  );
}
