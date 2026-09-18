import { useEffect, useState } from 'react';
import { Callout, PageHeader, PageStack, TabList } from '../../components/ds';
import { useLojaAtiva } from '../../auth/AuthContext';
import { criarUtmCampaign, listUtmPresets, type UtmCampaignInput, type UtmPreset } from '../../api/utm';
import { UtmBuilderForm } from './UtmBuilderForm';
import { UtmCampanhasTab } from './UtmCampanhasTab';
import { UtmPerformanceTab } from './UtmPerformanceTab';
import { UtmPresetsTab } from './UtmPresetsTab';
import { UtmVisaoGeralTab } from './UtmVisaoGeralTab';

import '../../pedidos-central.css';
import '../../campanhas.css';
import '../../utm.css';

// UTM Tracker (docs/claude-utm-tracker-ga4.md) — Builder + campanhas salvas + presets + performance
// real por GA4. Regra central da spec: o Builder nunca depende do Google Analytics — continua
// funcionando 100% sem conexão nenhuma; a aba Performance é que exige loja conectada com
// propriedade escolhida (ver Integrações).
type Aba = 'visao-geral' | 'campanhas' | 'construtor' | 'performance' | 'presets';

export function UtmTrackerPage() {
  const escopo = useLojaAtiva() ?? '';
  const [aba, setAba] = useState<Aba>('visao-geral');
  const [presets, setPresets] = useState<UtmPreset[]>([]);
  const [presetsErro, setPresetsErro] = useState('');
  const [salvandoConstrutor, setSalvandoConstrutor] = useState(false);
  const [construtorMsg, setConstrutorMsg] = useState<{ texto: string; erro: boolean } | null>(null);

  function recarregarPresets() {
    listUtmPresets()
      .then((data) => setPresets(data.presets))
      .catch((err: Error) => setPresetsErro(err.message));
  }

  useEffect(recarregarPresets, []);

  const lojaAtual = escopo;

  function salvarDoConstrutor(input: UtmCampaignInput) {
    setSalvandoConstrutor(true);
    setConstrutorMsg(null);
    criarUtmCampaign(input)
      .then(() => setConstrutorMsg({ texto: `Campanha "${input.nome}" salva — confira na aba Campanhas.`, erro: false }))
      .catch((err: Error) => setConstrutorMsg({ texto: err.message, erro: true }))
      .finally(() => setSalvandoConstrutor(false));
  }

  return (
    <PageStack>
      <PageHeader title="UTM Tracker" description="Crie, padronize e reaproveite links com UTM — e acompanhe a performance real por GA4." />

      <TabList
        label="Seções do UTM Tracker"
        value={aba}
        onChange={setAba}
        items={[
          { value: 'visao-geral', label: 'Visão geral' },
          { value: 'campanhas', label: 'Campanhas' },
          { value: 'construtor', label: 'Construtor' },
          { value: 'performance', label: 'Performance' },
          { value: 'presets', label: 'Presets', count: presets.length || null },
        ]}
      />

      {presetsErro && <p className="ds-form-error" role="alert">{presetsErro}</p>}

      {aba === 'visao-geral' && (
        <UtmVisaoGeralTab
          onIrParaCampanhas={() => setAba('campanhas')}
          onIrParaConstrutor={() => setAba('construtor')}
          onIrParaPerformance={() => setAba('performance')}
        />
      )}

      {aba === 'campanhas' && <UtmCampanhasTab presets={presets} />}

      {aba === 'construtor' && (
        <div className="ds-stack">
          {construtorMsg && (
            <Callout tone={construtorMsg.erro ? 'danger' : 'success'} title={construtorMsg.erro ? 'Não foi possível salvar' : 'Campanha salva'}>
              {construtorMsg.texto}
            </Callout>
          )}
          <UtmBuilderForm presets={presets} salvando={salvandoConstrutor} onSalvar={salvarDoConstrutor} />
        </div>
      )}

      {aba === 'performance' && <UtmPerformanceTab lojaAtual={lojaAtual} />}

      {aba === 'presets' && <UtmPresetsTab presets={presets} recarregar={recarregarPresets} />}
    </PageStack>
  );
}
