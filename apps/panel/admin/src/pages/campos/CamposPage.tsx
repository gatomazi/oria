import { useEffect, useState } from 'react';
import { Card, EmptyState, ErrorState, PageHeader, PageStack, Skeleton } from '../../components/ds';
import { getCamposCustomizados, type CampoCustomizado } from '../../api/campos';
import { NovoCampoCard } from './NovoCampoCard';
import { CampoCard } from './CampoCard';

import '../../../../src/campos.css';

// Porte de src/campos.js.
export function CamposPage() {
  const [campos, setCampos] = useState<Record<string, CampoCustomizado> | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setCampos(null);
    getCamposCustomizados()
      .then((data) => setCampos(data.campos || {}))
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  const chaves = campos ? Object.keys(campos) : [];

  return (
    <PageStack>
      <PageHeader title="Campos personalizados" description="Variáveis próprias pra usar nos templates de WhatsApp, além das do sistema." />

      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !campos && <Skeleton rows={4} />}
      {!erro && campos && (
        <div className="ad-campos-grid">
          <NovoCampoCard recarregar={carregar} />
          <Card title="Campos existentes">
            {!chaves.length ? (
              <EmptyState title="Nenhum campo personalizado ainda" />
            ) : (
              <div className="ad-campos-lista">
                {chaves.map((chave) => (
                  <CampoCard key={chave} chave={chave} campo={campos[chave]} recarregar={carregar} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </PageStack>
  );
}
