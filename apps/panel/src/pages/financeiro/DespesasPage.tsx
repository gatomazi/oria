import { useEffect, useMemo, useState } from 'react';
import {
  Button, Callout, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, FormActions, FormGrid,
  FormStack, Input, PageHeader, PageStack, Select, Skeleton, StatusBadge, Textarea, type Column,
} from '../../components/ds';
import { formatDiaISO, formatValor, plural } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import {
  CATEGORIA_ROTULO, criarDespesa, excluirDespesa, listarDespesas, atualizarDespesa,
  type Despesa, type DespesaInput,
} from '../../api/despesas';

import '../../pedidos-central.css';

const VAZIO: DespesaInput = { categoria: 'OTHER', descricao: '', valor: '', data: '', recorrencia: 'unica', fim: '', notas: '' };

function hojeISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Despesas operacionais (spec §53X). É o cadastro que fecha o nível 4 do resultado — sem nenhuma
// despesa aqui, o Lucro Operacional do Meta Ads aparece como travessão, porque é desconhecido.
export function DespesasPage() {
  const escopo = useLojaAtiva() ?? '';
  const loja = escopo;

  const [despesas, setDespesas] = useState<Despesa[] | null>(null);
  const [erro, setErro] = useState('');
  const [form, setForm] = useState<DespesaInput>({ ...VAZIO, data: hojeISO() });
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [excluindo, setExcluindo] = useState<Despesa | null>(null);

  function carregar() {
    setErro('');
    setDespesas(null);
    listarDespesas()
      .then((d) => setDespesas(d.despesas))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja]); // eslint-disable-line react-hooks/exhaustive-deps

  function campo<K extends keyof DespesaInput>(k: K, v: DespesaInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function limpar() {
    setForm({ ...VAZIO, data: hojeISO() });
    setEditandoId(null);
    setErroForm('');
  }

  function salvar() {
    setSalvando(true);
    setErroForm('');
    const payload = { ...form, valor: Number(form.valor), fim: form.recorrencia === 'mensal' ? form.fim : '' };
    const req = editandoId ? atualizarDespesa(editandoId, payload) : criarDespesa(payload);
    req
      .then(() => { limpar(); carregar(); })
      .catch((err: Error) => setErroForm(err.message))
      .finally(() => setSalvando(false));
  }

  function editar(d: Despesa) {
    setEditandoId(d.id);
    setErroForm('');
    setForm({
      categoria: d.categoria, descricao: d.descricao, valor: String(d.valor), data: d.data,
      recorrencia: d.recorrencia, fim: d.fim || '', notas: d.notas || '',
    });
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await excluirDespesa(excluindo.id);
    setExcluindo(null);
    if (editandoId === excluindo.id) limpar();
    carregar();
  }

  const recorrentes = useMemo(() => (despesas || []).filter((d) => d.recorrencia === 'mensal').length, [despesas]);

  const colunas: Column<Despesa>[] = [
    { key: 'descricao', label: 'Despesa', truncate: true, width: 240, sortValue: (d) => d.descricao.toLowerCase() },
    {
      key: 'categoria', label: 'Categoria', sortValue: (d) => d.categoria,
      render: (d) => CATEGORIA_ROTULO[d.categoria] || d.categoria,
    },
    {
      key: 'recorrencia', label: 'Recorrência', sortValue: (d) => d.recorrencia,
      // Mensal é informação, não alerta: tom neutro, como qualquer outro atributo da linha.
      render: (d) => (d.recorrencia === 'mensal'
        ? <StatusBadge tone="info" label={d.fim ? `Mensal até ${formatDiaISO(d.fim)}` : 'Mensal'} />
        : <StatusBadge tone="neutral" label="Única" />),
    },
    { key: 'data', label: 'Desde', align: 'right', muted: true, priority: 'low', sortValue: (d) => d.data, render: (d) => formatDiaISO(d.data) },
    { key: 'valor', label: 'Valor', align: 'right', firstSortDirection: 'desc', sortValue: (d) => d.valor, render: (d) => formatValor(d.valor) },
    {
      key: 'acoes', label: 'Ações', align: 'right', hideLabel: true,
      render: (d) => (
        <span className="ga-linha__acao">
          <Button variant="ghost" size="sm" onClick={() => editar(d)}>Editar</Button>
          <Button variant="ghost" size="sm" onClick={() => setExcluindo(d)}>Excluir</Button>
        </span>
      ),
    },
  ];

  return (
    <PageStack>
      <PageHeader
        title="Despesas operacionais"
        description="Taxas, serviços e mensalidades que entram no Lucro Operacional do Resultado."
      />

      {/* Despesa recorrente é UMA linha, expandida na leitura. Dizer isso evita o usuário cadastrar
          doze vezes a mesma mensalidade — que é o que ele faria sem saber. */}
      <Callout tone="info" title="Como a recorrência funciona">
        Uma despesa mensal é cadastrada <strong>uma vez</strong>. O painel conta uma incidência por mês
        dentro do período consultado, a partir da data de início — não é preciso repetir o lançamento
        a cada mês. Deixe “Até” em branco enquanto ela continuar valendo.
      </Callout>

      <FormStack>
        <FormGrid>
          <Field label="Descrição" required>
            <Input value={form.descricao} onChange={(e) => campo('descricao', e.target.value)} placeholder="Ex.: Designer, Shopify, taxa do gateway" />
          </Field>
          <Field label="Categoria" required>
            <Select aria-label="Categoria" value={form.categoria} onChange={(e) => campo('categoria', e.target.value)}>
              {Object.entries(CATEGORIA_ROTULO).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </Select>
          </Field>
          <Field label="Valor (R$)" required>
            <Input type="number" min="0.01" step="0.01" value={form.valor} onChange={(e) => campo('valor', e.target.value)} />
          </Field>
          <Field label="Recorrência">
            <Select aria-label="Recorrência" value={form.recorrencia} onChange={(e) => campo('recorrencia', e.target.value as 'unica' | 'mensal')}>
              <option value="unica">Única</option>
              <option value="mensal">Mensal</option>
            </Select>
          </Field>
          <Field label={form.recorrencia === 'mensal' ? 'Começa em' : 'Data'} required>
            <Input type="date" value={form.data} onChange={(e) => campo('data', e.target.value)} />
          </Field>
          {form.recorrencia === 'mensal' && (
            <Field label="Até (opcional)" hint="deixe em branco se continua valendo">
              <Input type="date" value={form.fim} min={form.data || undefined} onChange={(e) => campo('fim', e.target.value)} />
            </Field>
          )}
        </FormGrid>
        <Field label="Notas (opcional)">
          <Textarea rows={2} value={form.notas} onChange={(e) => campo('notas', e.target.value)} />
        </Field>
        {erroForm && <p className="ds-form-error" role="alert">{erroForm}</p>}
        <FormActions>
          {editandoId && <Button variant="ghost" onClick={limpar}>Cancelar edição</Button>}
          <Button disabled={salvando} onClick={salvar}>
            {salvando ? 'Salvando…' : editandoId ? 'Salvar alterações' : 'Adicionar despesa'}
          </Button>
        </FormActions>
      </FormStack>

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !despesas && <Skeleton variant="table" rows={4} />}
      {!erro && despesas && (
        despesas.length === 0 ? (
          <EmptyState
            title="Nenhuma despesa cadastrada"
            description="Enquanto não houver nenhuma, o Lucro Operacional no Resultado do Meta Ads aparece como “—”, porque é desconhecido — não porque seja zero."
          />
        ) : (
          <>
            <DataTable
              label="Despesas operacionais"
              rows={despesas}
              rowKey={(d) => d.id}
              columns={colunas}
              defaultSort={{ key: 'valor', direction: 'desc' }}
            />
            <p className="pc-nota">
              {plural(despesas.length, 'despesa cadastrada', 'despesas cadastradas')}
              {recorrentes > 0 ? `, ${plural(recorrentes, 'mensal', 'mensais')}` : ''}.
            </p>
          </>
        )
      )}

      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir "${excluindo?.descricao || ''}"?`}
        description="A despesa deixa de entrar no Lucro Operacional, inclusive em períodos passados já consultados."
        onConfirm={confirmarExclusao}
      />
    </PageStack>
  );
}
