import { useEffect, useState } from 'react';
import { Button, Callout, Checkbox, FormActions, Modal } from '../../components/ds';
import { toast } from '../../lib/toast';
import {
  decideEnrichment,
  proposeEnrichment,
  type EnrichmentAcceptableField,
  type EnrichmentProposal,
  type Product,
} from '../../api/criativos';

// Fase F.1 — Product Enrichment: revisão em poucos segundos (§5). "Sugestão para esta estampa" + Aprovar
// sugestão / Ajustar / Descartar.
//
// Fase F.2.A: `proposta.provider` pode ser "fake" (heurística de texto, sem custo) ou "openai" (visão real —
// ainda sem uso pago nesta rodada, ver docs/features/creative-generator-fase-f2a.md). A tela NUNCA apresenta
// uma sugestão fake como se fosse visão real (exigência explícita da fase): o rótulo muda de fato conforme a
// origem, nunca um texto genérico que esconda a diferença. Confiança baixa também aparece — uma sugestão sem
// certeza não deve parecer tão firme quanto uma com evidência clara.

const CAMPO_LABEL: Record<EnrichmentAcceptableField, string> = {
  wearer_roles: 'Quem veste', relationship_themes: 'Tema da relação', recommended_supporting_roles: 'Quem mais aparece',
  incompatible_auto_supporting_roles: 'Papéis a evitar', scene_intents: 'O que fazem', visible_text: 'Texto visível na peça',
};
const VALOR_LABEL: Record<string, string> = {
  adult: 'adulto', child: 'criança', father: 'pai', mother: 'mãe', son: 'filho', daughter: 'filha',
  grandparent: 'avô/avó', sibling: 'irmão/irmã', friend: 'amigo(a)', partner: 'parceiro(a)',
  family: 'família', friendship: 'amizade', romantic: 'romance',
  playing: 'brincando', gifting: 'presenteando', reading_together: 'lendo juntos', cooking: 'cozinhando',
  talking: 'conversando', walking: 'caminhando', hugging: 'abraçando',
};
const valores = (lista?: string[]) => (lista && lista.length ? lista.map((v) => VALOR_LABEL[v] || v).join(', ') : null);

// Rótulo NUNCA genérico o bastante para confundir as duas origens — a diferença precisa ser visível de
// relance, sem o lojista precisar saber o que "provider" significa.
function origemLabel(provider: EnrichmentProposal['provider']): string {
  return provider === 'openai' ? 'Sugestão por IA com visão da imagem' : 'Sugestão automática (a partir do texto do produto)';
}

function confiancaBaixa(confidence: number | null | undefined): boolean {
  return typeof confidence === 'number' && confidence < 0.5;
}

function camposNaoVazios(proposed: EnrichmentProposal['proposed']): EnrichmentAcceptableField[] {
  return (Object.keys(CAMPO_LABEL) as EnrichmentAcceptableField[]).filter((c) => Array.isArray(proposed[c]) && (proposed[c] as string[]).length > 0);
}

export function EnrichmentReviewModal({ product, onClose, onDecided }: { product: Product; onClose: () => void; onDecided: () => void }) {
  const [proposta, setProposta] = useState<EnrichmentProposal | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [ajustando, setAjustando] = useState(false);
  const [aceitos, setAceitos] = useState<Set<EnrichmentAcceptableField>>(new Set());
  const [decidindo, setDecidindo] = useState(false);

  useEffect(() => {
    setCarregando(true);
    setErro('');
    proposeEnrichment(product.id)
      .then((p) => { setProposta(p); setAceitos(new Set(camposNaoVazios(p.proposed))); })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [product.id]);

  function decidir(decision: 'approved' | 'adjusted' | 'rejected', campos: EnrichmentAcceptableField[]) {
    if (!proposta) return;
    setDecidindo(true);
    decideEnrichment(product.id, proposta.id, decision, campos)
      .then(() => {
        toast(decision === 'rejected' ? 'Sugestão descartada.' : 'Sugestão aplicada ao produto.', 'sucesso');
        onDecided();
        onClose();
      })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setDecidindo(false));
  }

  const camposComValor = proposta ? camposNaoVazios(proposta.proposed) : [];
  const resumo = proposta && [
    valores(proposta.proposed.relationship_themes) || valores(proposta.proposed.recommended_supporting_roles),
    valores(proposta.proposed.scene_intents),
  ].filter(Boolean).join(' · ');

  return (
    <Modal
      open
      onClose={onClose}
      title={`Sugestão para "${product.name}"`}
      cancelLabel="Fechar"
    >
      {carregando && <p>Calculando a sugestão…</p>}
      {erro && <Callout tone="danger" title="Não foi possível calcular a sugestão">{erro}</Callout>}
      {proposta && !camposComValor.length && (
        <Callout tone="info" title="Sem evidência suficiente">Nada no texto do produto sugeriu quem aparece ou o que acontece — descrever melhor o produto ajuda.</Callout>
      )}
      {proposta && camposComValor.length > 0 && !ajustando && (
        <>
          <p className="criativos-v2__sugestao">{resumo || 'Sugestão calculada'}</p>
          <p className="criativos-v2__sugestao-nota">
            {origemLabel(proposta.provider)} — nada foi aplicado ao produto ainda.
          </p>
          {confiancaBaixa(proposta.proposed.confidence) && (
            <Callout tone="warning" title="Confiança baixa">Pouca evidência no produto — revise com atenção antes de aprovar.</Callout>
          )}
          <FormActions>
            <Button disabled={decidindo} onClick={() => decidir('approved', camposComValor)}>Aprovar sugestão</Button>
            <Button variant="secondary" disabled={decidindo} onClick={() => setAjustando(true)}>Ajustar</Button>
            <Button variant="ghost" disabled={decidindo} onClick={() => decidir('rejected', [])}>Descartar</Button>
          </FormActions>
        </>
      )}
      {proposta && ajustando && (
        <>
          <div role="group" aria-label="Campos a aplicar" className="criativos-lista-check">
            {camposComValor.map((campo) => (
              <Checkbox
                key={campo}
                label={CAMPO_LABEL[campo]}
                description={valores(proposta.proposed[campo] as string[]) || undefined}
                checked={aceitos.has(campo)}
                onChange={() => setAceitos((s) => { const next = new Set(s); if (next.has(campo)) next.delete(campo); else next.add(campo); return next; })}
              />
            ))}
          </div>
          <FormActions>
            <Button disabled={decidindo} onClick={() => decidir('adjusted', [...aceitos])}>Aprovar seleção</Button>
            <Button variant="secondary" disabled={decidindo} onClick={() => setAjustando(false)}>Voltar</Button>
          </FormActions>
        </>
      )}
    </Modal>
  );
}
