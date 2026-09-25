import type { Engine, FunnelStage, RemarketingIntent } from '../../api/criativos';

// Fase G.1 — rótulos e descrições dos 3 motores, extraídos de GerarTab.tsx (V1) para um único lugar:
// GerarTabV2.tsx (Remarketing/Funil) usa exatamente os mesmos textos, nunca uma segunda versão que
// pode divergir da V1 com o tempo. V1 continua se comportando de forma idêntica — só o IMPORTA daqui.
// A lógica de montagem de request (testável, sem JSX) mora em `criativosMotorInput.mjs`, não aqui.

export const ENGINE_LABEL: Record<Engine, { title: string; description: string }> = {
  CLEAN_ANGLES: { title: 'Ângulos Limpos', description: 'Imagem pura: produto + contexto + ângulo. O funil fica na copy do anúncio.' },
  REMARKETING: { title: 'Remarketing', description: 'Para quem já conhece a marca: mensagem pela intenção, com headline e CTA na arte.' },
  FUNNEL_VISUAL: { title: 'Funil por Criativo', description: 'TOFU, MOFU ou BOFU na arte: headline, CTA, selos e benefícios por etapa.' },
};

export const INTENT_LABEL: Record<RemarketingIntent, string> = {
  site_visitor: 'Visitante do site',
  product_view: 'Produto visto',
  collection_discovery: 'Coleção',
  cart: 'Carrinho',
  checkout: 'Checkout',
  social_proof: 'Prova social',
  objection: 'Objeção',
};

// Descrição curta por intent — a "proposta clara de objetivo/abordagem" que o passo Objetivo mostra
// (brief G.1 §2). Nunca inventa dado do produto: é só o rótulo da estratégia de comunicação.
export const INTENT_DESCRICAO: Record<RemarketingIntent, string> = {
  site_visitor: 'quem visitou o site mas ainda não olhou um produto específico',
  product_view: 'quem já viu ESTE produto e ainda não decidiu',
  collection_discovery: 'apresentar a coleção para quem já conhece a marca',
  cart: 'quem deixou produtos no carrinho sem finalizar',
  checkout: 'quem chegou perto de comprar e parou no checkout',
  social_proof: 'reforçar confiança com prova social antes da decisão',
  objection: 'responder a uma hesitação comum antes da compra',
};

export const FUNNEL_STAGE_LABEL: Record<FunnelStage, { title: string; description: string }> = {
  TOFU: { title: 'TOFU', description: 'descoberta' },
  MOFU: { title: 'MOFU', description: 'consideração' },
  BOFU: { title: 'BOFU', description: 'decisão' },
};

// Forma do estado de texto comum a Remarketing/Funil — o VALOR padrão (`TEXTO_MOTOR_VAZIO`) e a lógica
// que lê/escreve estes campos moram em `criativosMotorInput.mjs` (testável); este é só o tipo, para o
// componente anotar `useState<TextoMotor>`.
export interface TextoMotor {
  headline: string;
  subheadline: string;
  cta: string;
  benefits: string;
  badges: string;
  chips: string;
  search: string;
  density: string;
  emphasis: string;
  cleanMode: string;
}
