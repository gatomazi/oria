import { Button, Callout, Disclosure } from '../../components/ds';
import { toast } from '../../lib/toast';
import { copiar, plural } from '../../lib/format';
import { urlReferenciaProduto, type PromptPrevia } from '../../api/criativos';

// Prompt de cada ângulo × formato da prévia, para o lojista colar no ChatGPT com as mesmas fotos e ver um
// esboço da arte antes de pagar o lote. A cena e a persona são sorteadas por criativo, então o lote pode
// usar outras: o texto aqui é uma amostra fiel da estrutura, não uma cópia do que cada imagem vai receber.

export function PromptsPrevia({ prompts, omitidos }: { prompts: PromptPrevia[]; omitidos: number }) {
  if (prompts.length === 0) return null;

  return (
    <section className="criativos-prompts" aria-label="Testar no ChatGPT">
      <Callout tone="info" title="Testar no ChatGPT antes de gerar">
        Abra uma conversa nova no ChatGPT, anexe as fotos na ordem mostrada e cole o prompt. Serve de esboço: cena e persona
        são sorteadas por criativo e podem mudar no lote.
      </Callout>

      {prompts.map((p, i) => (
        <Disclosure
          key={`${p.angle?.id}-${p.placement}`}
          defaultOpen={prompts.length === 1}
          summary={`${p.angle?.label ?? 'Ângulo'} · ${p.placement}${i === 0 && prompts.length > 1 ? ' (primeiro do lote)' : ''}`}
        >
          <p className="criativos-item__meta">Anexe {plural(p.references.length, 'foto', 'fotos')} nesta ordem:</p>
          <ol className="criativos-prompts__refs">
            {p.references.map((r) => (
              <li key={r.order} className="criativos-prompts__ref">
                <a href={urlReferenciaProduto(r.product_id, r.photo)} target="_blank" rel="noreferrer" title="Abrir a foto para salvar ou arrastar">
                  <img src={urlReferenciaProduto(r.product_id, r.photo)} alt={`Imagem ${r.order}: ${r.product_name}, foto ${r.photo}`} loading="lazy" />
                </a>
                <span>Imagem {r.order} · {r.product_name}{p.references.filter((x) => x.product_id === r.product_id).length > 1 ? `, foto ${r.photo}` : ''}</span>
              </li>
            ))}
          </ol>
          <div className="criativos-prompts__acoes">
            <Button size="sm" variant="secondary" onClick={() => copiar(p.text, () => toast('Prompt copiado.', 'sucesso'))}>Copiar prompt</Button>
            {p.size && <span className="criativos-item__meta">Peça a imagem em {p.size.replace('x', ' × ')} px.</span>}
          </div>
          <pre className="ds-code-block criativos-prompts__texto">{p.text}</pre>
        </Disclosure>
      ))}

      {omitidos > 0 && (
        <p className="criativos-item__meta">
          {plural(omitidos, 'combinação não aparece', 'combinações não aparecem')} aqui para a prévia não ficar lenta; o lote gera todas.
        </p>
      )}
    </section>
  );
}
