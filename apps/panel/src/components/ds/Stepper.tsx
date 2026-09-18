import { Icon } from './Icon';

// Etapas de assistente (DESIGN.md › Stepper): número em círculo + rótulo, concluída com check,
// atual destacada (aria-current="step"), futura discreta. Clicável só quando a página permite.
interface StepperProps {
  steps: string[];
  current: number;
  isCompleted?: (index: number) => boolean;
  onSelect?: (index: number) => void;
  canSelect?: boolean;
  disabledHint?: string;
  label?: string;
}

export function Stepper({ steps, current, isCompleted, onSelect, canSelect = false, disabledHint, label = 'Etapas' }: StepperProps) {
  return (
    <ol className="ds-stepper" aria-label={label}>
      {steps.map((step, i) => {
        const atual = i === current;
        const feito = !atual && (isCompleted ? isCompleted(i) : i < current);
        const estado = atual ? 'ds-stepper__item--atual' : feito ? 'ds-stepper__item--feito' : '';
        const conteudo = (
          <>
            <span className="ds-stepper__marker" aria-hidden="true">
              {feito ? <Icon name="check-mark" size={12} /> : i + 1}
            </span>
            <span className="ds-stepper__label">{step}</span>
            {feito && <span className="ds-sr-only"> (concluída)</span>}
          </>
        );
        return (
          <li key={step} className={['ds-stepper__item', estado].filter(Boolean).join(' ')} aria-current={atual ? 'step' : undefined}>
            {onSelect ? (
              <button
                type="button"
                className="ds-stepper__button"
                disabled={!canSelect}
                title={!canSelect ? disabledHint : undefined}
                onClick={() => onSelect(i)}
              >
                {conteudo}
              </button>
            ) : (
              <span className="ds-stepper__button">{conteudo}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
