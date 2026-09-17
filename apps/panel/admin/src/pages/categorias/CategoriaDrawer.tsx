import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, Input, Skeleton } from '../../components/ds';
import { Tabs } from '../../components/Tabs';
import {
  adicionarProduto,
  deleteCategoria,
  getCategoria,
  getNomesProdutosCategoria,
  getVitrine,
  putVitrine,
  updateCategoria,
  type Categoria,
  type VitrineItem,
} from '../../api/categorias';

// Porte de abrirDrawer()/renderInformacoesTab()/renderProdutosTab()/renderOrdenacaoTab() em
// src/categorias.js.

function TabInformacoes({ categoria, onSaved }: { categoria: Categoria; onSaved: () => void }) {
  const [nome, setNome] = useState(categoria.name);
  const [descricao, setDescricao] = useState(categoria.description || '');
  const [disponivel, setDisponivel] = useState(!!categoria.is_available);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function salvar() {
    setSalvando(true);
    updateCategoria(categoria.id, { name: nome.trim(), description: descricao.trim(), isAvailable: disponivel })
      .then(() => {
        setSalvando(false);
        onSaved();
      })
      .catch((err: Error) => {
        setSalvando(false);
        setErro(err.message);
      });
  }

  return (
    <div className="tn-form">
      <Field label="Nome">
        <Input value={nome} onChange={(e) => setNome(e.target.value)} />
      </Field>
      <Field label="Descrição">
        <Input value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </Field>
      <label className="ds-check-row">
        <input type="checkbox" checked={disponivel} onChange={(e) => setDisponivel(e.target.checked)} />
        {' '}Disponível na loja
      </label>
      {erro && <p className="ds-form-error">{erro}</p>}
      <Button variant="primary" disabled={salvando} onClick={salvar}>
        Salvar
      </Button>
    </div>
  );
}

function TabProdutos({ categoria, onChanged }: { categoria: Categoria; onChanged: () => void }) {
  const [novoId, setNovoId] = useState('');
  const ids = categoria.product_ids || [];

  function remover(pid: number) {
    const novosIds = ids.filter((id) => id !== pid);
    updateCategoria(categoria.id, { productIds: novosIds }).then(onChanged);
  }

  function adicionar() {
    const pid = Number(novoId);
    if (!Number.isInteger(pid)) return;
    adicionarProduto(categoria.id, pid).then(onChanged);
  }

  return (
    <div>
      {!ids.length ? (
        <EmptyState title="Nenhum produto nesta categoria" />
      ) : (
        <ul className="pr-variantes">
          {ids.map((pid) => (
            <li key={pid}>
              <span>Produto #{pid}</span>
              <Button variant="ghost" onClick={() => remover(pid)}>
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="ds-button-row ds-bloco-seguinte">
        <Input type="number" placeholder="ID do produto" value={novoId} onChange={(e) => setNovoId(e.target.value)} />
        <Button variant="secondary" onClick={adicionar}>
          Adicionar
        </Button>
      </div>
      <p className="pc-nota">IDs de produto — veja detalhes em Catálogo &gt; Produtos.</p>
    </div>
  );
}

function TabOrdenacao({ loja, categoria, onChanged }: { loja: string; categoria: Categoria; onChanged: () => void }) {
  const [itens, setItens] = useState<VitrineItem[] | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getVitrine(categoria.id)
      .then((data) => setItens((data.vitrine.product_items || []).slice().sort((a, b) => a.position - b.position)))
      .catch((err: Error) => setErro(err.message));
  }, [loja, categoria.id]);

  function salvar(next: VitrineItem[]) {
    putVitrine(categoria.id, next.map((i) => ({ productId: i.product_id }))).then(onChanged);
  }

  function mover(i: number, delta: number) {
    if (!itens) return;
    const next = itens.slice();
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item);
    setItens(next);
    salvar(next);
  }

  if (erro) return <ErrorState description={erro} />;
  if (!itens) return <Skeleton rows={3} />;
  if (!itens.length) {
    return <EmptyState title="Sem itens pra ordenar" description="Adicione produtos na aba Produtos primeiro." />;
  }

  return (
    <div>
      <p className="pc-nota">Ordem personalizada da vitrine desta categoria.</p>
      <ul className="cat-ordenacao">
        {itens.map((item, i) => (
          <li key={item.product_id}>
            <span>Produto #{item.product_id}</span>
            <button type="button" disabled={i === 0} onClick={() => mover(i, -1)}>
              ↑
            </button>
            <button type="button" disabled={i === itens.length - 1} onClick={() => mover(i, 1)}>
              ↓
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CategoriaDrawer({
  loja,
  id,
  onClose,
  onChanged,
}: {
  loja: string;
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [categoria, setCategoria] = useState<Categoria | null>(null);
  const [erro, setErro] = useState('');
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const [copiandoNomes, setCopiandoNomes] = useState(false);
  const [avisoNomes, setAvisoNomes] = useState('');

  // Pedido do usuário (2026-09-11): lista de nomes separados por vírgula pra colar num filtro de
  // conjunto de produtos no Gerenciador de Anúncios da Meta — a categoria só expõe product_ids,
  // então o backend busca cada nome individualmente (pode demorar em categorias grandes).
  async function copiarNomes() {
    if (!categoria) return;
    setCopiandoNomes(true);
    setAvisoNomes('');
    try {
      const data = await getNomesProdutosCategoria(categoria.id);
      await navigator.clipboard.writeText(data.csv);
      setAvisoNomes(`${data.encontrados}/${data.total} nomes copiados pra área de transferência.`);
    } catch (err) {
      setAvisoNomes((err as Error).message);
    } finally {
      setCopiandoNomes(false);
    }
  }

  function carregar() {
    setErro('');
    getCategoria(id)
      .then((data) => setCategoria(data.categoria))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, id]);

  async function excluir() {
    await deleteCategoria(id);
    onClose();
    onChanged();
  }

  return (
    <Drawer open onClose={onClose} title="Categoria">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !categoria && <Skeleton rows={4} />}
      {!erro && categoria && (
        <>
          <h2 className="ds-card__title">{categoria.name}</h2>
          <div className="ds-button-row">
            <Button variant="secondary" disabled={copiandoNomes} onClick={copiarNomes}>
              {copiandoNomes ? 'Buscando nomes...' : 'Copiar nomes (CSV)'}
            </Button>
            <Button variant="danger" onClick={() => setConfirmandoExclusao(true)}>
              Excluir categoria
            </Button>
          </div>
          {avisoNomes && <p className="pc-nota">{avisoNomes}</p>}
          <ConfirmDialog
            open={confirmandoExclusao}
            onClose={() => setConfirmandoExclusao(false)}
            title={`Excluir a categoria "${categoria.name}"?`}
            description="Os produtos ficam desassociados."
            onConfirm={excluir}
          />
          <Tabs
            tabs={[
              {
                label: 'Informações',
                render: () => (
                  <TabInformacoes
                    categoria={categoria}
                    onSaved={() => {
                      carregar();
                      onChanged();
                    }}
                  />
                ),
              },
              {
                label: 'Produtos',
                render: () => (
                  <TabProdutos
                    categoria={categoria}
                    onChanged={() => {
                      carregar();
                      onChanged();
                    }}
                  />
                ),
              },
              {
                label: 'Ordenação',
                render: () => <TabOrdenacao loja={loja} categoria={categoria} onChanged={carregar} />,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  );
}
