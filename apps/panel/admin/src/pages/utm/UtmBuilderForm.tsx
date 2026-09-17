import { useId, useMemo, useState } from 'react';
import { Button, Callout, Field, FormActions, FormGrid, FormStack, Icon, Input } from '../../components/ds';
import { copiar } from '../../lib/format';
import { montarUrlUtm, normalizarUtmValor, UTM_MEDIUM_SUGESTOES, UTM_SOURCE_SUGESTOES } from '../../lib/utm';
import type { UtmCampaign, UtmCampaignInput, UtmPreset } from '../../api/utm';

// Construtor de UTM (docs/claude-utm-tracker-ga4.md, Parte 2) — compartilhado entre a aba
// "Construtor" (standalone) e o drawer de editar uma campanha salva. Não depende do GA4: só
// monta a URL, com prévia em tempo real, e — opcionalmente — salva pra reutilizar depois.
interface UtmBuilderFormProps {
  inicial?: UtmCampaign | null;
  presets: UtmPreset[];
  salvando: boolean;
  onSalvar: (input: UtmCampaignInput) => void;
  onCancelar?: () => void;
}

export function UtmBuilderForm({ inicial, presets, salvando, onSalvar, onCancelar }: UtmBuilderFormProps) {
  const [nome, setNome] = useState(inicial?.nome || '');
  const [destino, setDestino] = useState(inicial?.destinationUrl || '');
  const [source, setSource] = useState(inicial?.source || '');
  const [medium, setMedium] = useState(inicial?.medium || '');
  const [campaign, setCampaign] = useState(inicial?.campaign || '');
  const [content, setContent] = useState(inicial?.content || '');
  const [term, setTerm] = useState(inicial?.term || '');
  const [copiado, setCopiado] = useState(false);
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const sourceListId = useId();
  const mediumListId = useId();

  const fullUrl = useMemo(
    () => montarUrlUtm(destino, { source, medium, campaign, content, term }),
    [destino, source, medium, campaign, content, term],
  );

  const camposUtmValidos = !!(normalizarUtmValor(source) && normalizarUtmValor(medium) && normalizarUtmValor(campaign));
  const prontoParaSalvar = !!(nome.trim() && fullUrl && camposUtmValidos);

  function aplicarPreset(p: UtmPreset) {
    setSource(p.source);
    setMedium(p.medium);
  }

  function salvar() {
    setTentouSalvar(true);
    if (!prontoParaSalvar || !fullUrl) return;
    onSalvar({ nome: nome.trim(), destinationUrl: destino.trim(), source, medium, campaign, content: content || undefined, term: term || undefined });
  }

  return (
    <FormStack
      onSubmit={(e) => {
        e.preventDefault();
        salvar();
      }}
    >
      <FormGrid>
        <Field label="Nome da campanha" required hint="Só pra você identificar na lista salva — não entra na URL.">
          <Input type="text" placeholder="ex: Reels setembro" value={nome} onChange={(e) => setNome(e.target.value)} />
        </Field>
      </FormGrid>

      <Field label="URL de destino" required error={tentouSalvar && destino && !fullUrl ? 'URL inválida — use uma URL completa (https://…)' : undefined}>
        <Input type="text" placeholder="https://usesul.com.br/seu-lugar" value={destino} onChange={(e) => setDestino(e.target.value)} />
      </Field>

      {presets.length > 0 && (
        <Field label="Preset (opcional)" hint="Preenche source e medium de uma vez.">
          <div className="utm-chip-row">
            {presets.map((p) => (
              <button key={p.id} type="button" className="utm-chip" onClick={() => aplicarPreset(p)}>
                {p.nome}
              </button>
            ))}
          </div>
        </Field>
      )}

      <FormGrid>
        <Field label="utm_source" required>
          <Input type="text" list={sourceListId} placeholder="instagram" value={source} onChange={(e) => setSource(e.target.value)} />
          <datalist id={sourceListId}>
            {UTM_SOURCE_SUGESTOES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="utm_medium" required>
          <Input type="text" list={mediumListId} placeholder="story" value={medium} onChange={(e) => setMedium(e.target.value)} />
          <datalist id={mediumListId}>
            {UTM_MEDIUM_SUGESTOES.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
      </FormGrid>

      <FormGrid>
        <Field label="utm_campaign" required hint="Combinado com source/medium — pode repetir entre canais sem colidir.">
          <Input type="text" placeholder="seu_lugar" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        </Field>
        <Field label="utm_content" optional>
          <Input type="text" placeholder="banner_busca_v1" value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </FormGrid>

      <Field label="utm_term" optional>
        <Input type="text" placeholder="usado sobretudo em busca paga" value={term} onChange={(e) => setTerm(e.target.value)} />
      </Field>

      <Field label="URL gerada">
        {fullUrl ? (
          <div className="ds-code-block ds-code-block--wrap">{fullUrl}</div>
        ) : (
          <p className="ds-form-note">Preencha URL de destino, source, medium e campaign pra ver a URL completa aqui.</p>
        )}
      </Field>

      {tentouSalvar && !prontoParaSalvar && (
        <p className="ds-form-error" role="alert">
          {!nome.trim() ? 'Dê um nome pra campanha antes de salvar.' : 'Preencha URL de destino, source, medium e campaign.'}
        </p>
      )}

      <FormActions
        start={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={!fullUrl}
              onClick={() => fullUrl && copiar(fullUrl, () => { setCopiado(true); setTimeout(() => setCopiado(false), 1800); })}
            >
              <Icon name="copy" size={14} />
              {copiado ? 'Copiado!' : 'Copiar URL'}
            </Button>
            {fullUrl ? (
              <a className="ds-btn ds-btn--secondary" href={fullUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="external-link" size={14} />
                Abrir URL
              </a>
            ) : (
              <Button type="button" variant="secondary" disabled>
                <Icon name="external-link" size={14} />
                Abrir URL
              </Button>
            )}
            {onCancelar && (
              <Button type="button" variant="ghost" onClick={onCancelar}>
                Cancelar
              </Button>
            )}
          </>
        }
      >
        <Button type="submit" disabled={salvando}>
          {salvando ? 'Salvando…' : inicial ? 'Salvar alterações' : 'Salvar campanha'}
        </Button>
      </FormActions>

      {inicial && (
        <Callout tone="info" title="Reutilizando esta campanha">
          Salvar aqui atualiza a campanha "{inicial.nome}" — pra criar uma nova a partir dela, use "Duplicar" na lista.
        </Callout>
      )}
    </FormStack>
  );
}
