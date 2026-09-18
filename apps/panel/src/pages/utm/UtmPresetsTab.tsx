import { useState } from 'react';
import { Button, Card, ConfirmDialog, EmptyState, Field, FormActions, FormGrid, FormStack, Input, RowActionsMenu } from '../../components/ds';
import { UTM_PRESET_SUGESTOES } from '../../lib/utm';
import { criarUtmPreset, excluirUtmPreset, type UtmPreset } from '../../api/utm';

// Presets (spec, Parte 4) — combinações nomeadas de source+medium reutilizáveis no Construtor.
// As sugestões prontas (Instagram Story, Meta Ads, WhatsApp) só aparecem enquanto ainda não
// existir um preset com aquele nome — depois de criado, some da lista de sugestões sozinho.
export function UtmPresetsTab({ presets, recarregar }: { presets: UtmPreset[]; recarregar: () => void }) {
  const [nome, setNome] = useState('');
  const [source, setSource] = useState('');
  const [medium, setMedium] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [excluindo, setExcluindo] = useState<UtmPreset | null>(null);

  const nomesExistentes = new Set(presets.map((p) => p.nome.toLowerCase()));
  const sugestoes = UTM_PRESET_SUGESTOES.filter((s) => !nomesExistentes.has(s.nome.toLowerCase()));

  function criar(dados: { nome: string; source: string; medium: string }) {
    setErro('');
    if (!dados.nome.trim() || !dados.source.trim() || !dados.medium.trim()) {
      setErro('Preencha nome, source e medium.');
      return;
    }
    setSalvando(true);
    criarUtmPreset(dados)
      .then(() => {
        setNome('');
        setSource('');
        setMedium('');
        recarregar();
      })
      .catch((err: Error) => setErro(err.message))
      .finally(() => setSalvando(false));
  }

  async function confirmarExclusao() {
    if (!excluindo) return;
    await excluirUtmPreset(excluindo.id);
    setExcluindo(null);
    recarregar();
  }

  return (
    <div className="ds-stack">
      <Card title="Novo preset">
        <FormStack
          wide
          onSubmit={(e) => {
            e.preventDefault();
            criar({ nome, source, medium });
          }}
        >
          <FormGrid min={160}>
            <Field label="Nome">
              <Input type="text" placeholder="ex: Instagram Story" value={nome} onChange={(e) => setNome(e.target.value)} />
            </Field>
            <Field label="utm_source">
              <Input type="text" placeholder="instagram" value={source} onChange={(e) => setSource(e.target.value)} />
            </Field>
            <Field label="utm_medium">
              <Input type="text" placeholder="story" value={medium} onChange={(e) => setMedium(e.target.value)} />
            </Field>
          </FormGrid>
          {erro && (
            <p className="ds-form-error" role="alert">
              {erro}
            </p>
          )}
          <FormActions>
            <Button type="submit" disabled={salvando}>
              {salvando ? 'Salvando…' : 'Criar preset'}
            </Button>
          </FormActions>
        </FormStack>

        {sugestoes.length > 0 && (
          <div className="ds-bloco-seguinte">
            <p className="pc-nota">Sugestões prontas:</p>
            <div className="utm-chip-row">
              {sugestoes.map((s) => (
                <button key={s.nome} type="button" className="utm-chip" disabled={salvando} onClick={() => criar(s)}>
                  + {s.nome}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Presets salvos">
        {presets.length === 0 ? (
          <EmptyState title="Nenhum preset ainda" description="Crie um preset ou use uma das sugestões acima pra padronizar source e medium." />
        ) : (
          <div className="utm-preset-lista">
            {presets.map((p) => (
              <div className="utm-preset-row" key={p.id}>
                <span className="utm-preset-row__nome">{p.nome}</span>
                <span className="utm-preset-row__combo">
                  <code>{p.source}</code>
                  <code>{p.medium}</code>
                </span>
                <RowActionsMenu items={[{ label: 'Excluir', variant: 'danger', onSelect: () => setExcluindo(p) }]} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!excluindo}
        onClose={() => setExcluindo(null)}
        title={`Excluir o preset "${excluindo?.nome}"?`}
        description="Campanhas que já usam esse source/medium não são alteradas."
        onConfirm={confirmarExclusao}
      />
    </div>
  );
}
