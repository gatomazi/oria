import { useMemo, useState } from 'react';
import { Field, Input, Modal, StatusBadge, type Tone } from '../../components/ds';
import {
  bulkCreateCategorias,
  bulkPreviewCategorias,
  type ItemPreviewLote,
  type ResultadoItemLote,
  type StatusItemLote,
} from '../../api/categorias';

const STATUS_LABEL: Record<StatusItemLote, string> = {
  pronta: 'Pronta',
  ja_existe: 'Já existe',
  nome_invalido: 'Nome inválido',
  duplicada_na_lista: 'Duplicada na lista',
};

const STATUS_TONE: Record<StatusItemLote, Tone> = {
  pronta: 'success',
  ja_existe: 'warning',
  nome_invalido: 'danger',
  duplicada_na_lista: 'danger',
};

function parseLinhas(texto: string): string[] {
  return texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function ModalCriarCategoriasEmLote({
  open,
  onClose,
  onCriadas,
}: {
  open: boolean;
  onClose: () => void;
  onCriadas: () => void;
}) {
  const [texto, setTexto] = useState('');
  const [disponivel, setDisponivel] = useState(false);
  const [descricaoPadrao, setDescricaoPadrao] = useState('');
  const [itens, setItens] = useState<ItemPreviewLote[] | null>(null);
  const [analisando, setAnalisando] = useState(false);
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState<{ resultados: ResultadoItemLote[]; resumo: { criadas: number; existentes: number; falharam: number } } | null>(null);

  const linhas = useMemo(() => parseLinhas(texto), [texto]);

  function fechar() {
    setTexto('');
    setDisponivel(false);
    setDescricaoPadrao('');
    setItens(null);
    setErro('');
    setResultado(null);
    setAnalisando(false);
    setCriando(false);
    onClose();
  }

  function analisar() {
    if (!linhas.length) {
      setErro('Cole ao menos uma categoria (1 por linha).');
      return;
    }
    setErro('');
    setAnalisando(true);
    bulkPreviewCategorias(linhas)
      .then((data) => {
        setItens(data.itens);
        setAnalisando(false);
      })
      .catch((err: Error) => {
        setAnalisando(false);
        setErro(err.message);
      });
  }

  function editarNome(index: number, novoNome: string) {
    setItens((atual) => {
      if (!atual) return atual;
      const copia = atual.slice();
      const nomesVistos = new Map<string, number>();
      const proximo = copia.map((item, i) => (i === index ? { ...item, nome: novoNome } : item));
      return proximo.map((item, i) => {
        const chave = item.nome.trim().toLowerCase().replace(/\s+/g, ' ');
        let status: StatusItemLote = item.status;
        if (item.status === 'nome_invalido' || item.status === 'duplicada_na_lista' || i === index) {
          if (item.nome.length > 20) status = 'nome_invalido';
          else if (nomesVistos.has(chave)) status = 'duplicada_na_lista';
          else if (item.status === 'ja_existe') status = 'ja_existe';
          else status = 'pronta';
        }
        nomesVistos.set(chave, i);
        return { ...item, status };
      });
    });
  }

  function criar() {
    if (!itens) return;
    const prontos = itens.filter((i) => i.status === 'pronta').map((i) => i.nome);
    if (!prontos.length) return;
    setCriando(true);
    setErro('');
    bulkCreateCategorias({ nomes: prontos, isAvailable: disponivel, descricaoPadrao: descricaoPadrao.trim() || undefined })
      .then((data) => {
        setCriando(false);
        setResultado({ resultados: data.resultados, resumo: data.resumo });
        onCriadas();
      })
      .catch((err: Error) => {
        setCriando(false);
        setErro(err.message);
      });
  }

  const prontas = itens ? itens.filter((i) => i.status === 'pronta').length : 0;
  const jaExistem = itens ? itens.filter((i) => i.status === 'ja_existe').length : 0;
  const invalidas = itens ? itens.filter((i) => i.status === 'nome_invalido').length : 0;
  const duplicadas = itens ? itens.filter((i) => i.status === 'duplicada_na_lista').length : 0;

  return (
    <Modal
      open={open}
      onClose={fechar}
      title="Criar categorias em lote"
      confirmLabel={resultado ? undefined : itens ? 'Criar categorias' : 'Analisar'}
      confirmDisabled={resultado ? undefined : itens ? criando || prontas === 0 : analisando || linhas.length === 0}
      onConfirm={resultado ? undefined : itens ? criar : analisar}
    >
      {resultado ? (
        <div className="ds-lote-resultado">
          <p>
            Criadas: <strong>{resultado.resumo.criadas}</strong> · Existentes: <strong>{resultado.resumo.existentes}</strong> · Falharam:{' '}
            <strong>{resultado.resumo.falharam}</strong>
          </p>
          <ul className="ds-lote-lista">
            {resultado.resultados.map((r) => (
              <li key={r.nome}>
                {r.nome} —{' '}
                <StatusBadge
                  tone={r.status === 'criada' ? 'success' : r.status === 'ja_existia' ? 'warning' : 'danger'}
                  label={r.status === 'criada' ? 'Criada' : r.status === 'ja_existia' ? 'Já existia' : r.error || 'Falhou'}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : !itens ? (
        <>
          <Field label="Categorias (1 por linha)" hint={`${linhas.length === 1 ? '1 linha detectada' : `${linhas.length} linhas detectadas`}.`}>
            <textarea
              className="ds-input"
              rows={10}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder={'LEGADO - MT\nPONTO ORIGEM - MT\nCOORDENADAS - MT'}
            />
          </Field>
          <label className="ds-check-row">
            <input type="checkbox" checked={disponivel} onChange={(e) => setDisponivel(e.target.checked)} />
            {' '}Disponível na loja
          </label>
          <Field label="Descrição padrão (opcional)">
            <Input value={descricaoPadrao} onChange={(e) => setDescricaoPadrao(e.target.value)} />
          </Field>
        </>
      ) : (
        <div className="ds-lote-preview">
          <p>
            {itens.length === 1 ? '1 categoria detectada' : `${itens.length} categorias detectadas`} — {prontas} {prontas === 1 ? 'válida' : 'válidas'}, {jaExistem} {jaExistem === 1 ? 'já existe' : 'já existem'}, {invalidas} {invalidas === 1 ? 'inválida' : 'inválidas'}, {duplicadas} {duplicadas === 1 ? 'duplicada' : 'duplicadas'}.
          </p>
          <ul className="ds-lote-lista">
            {itens.map((item, i) => (
              <li key={i}>
                {item.status === 'nome_invalido' || item.status === 'duplicada_na_lista' ? (
                  <input
                    className="ds-input ds-lote-input-inline"
                    aria-label={`Nome da categoria ${i + 1}`}
                    value={item.nome}
                    onChange={(e) => editarNome(i, e.target.value)}
                  />
                ) : (
                  <span>{item.nome}</span>
                )}
                {' '}
                <StatusBadge tone={STATUS_TONE[item.status]} label={STATUS_LABEL[item.status]} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}
