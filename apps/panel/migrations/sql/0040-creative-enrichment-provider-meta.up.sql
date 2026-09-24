-- Fase F.2.A · Product Enrichment — custo/observabilidade do provider (§4 da direção).
--
-- Coluna aditiva em creative_enrichment_proposals (0036): modelo pedido/servido, versão do
-- prompt/schema, uso reportado (tokens — nunca texto), tentativas, latência, contagem de referências
-- usadas. NUNCA a resposta bruta do provider, NUNCA bytes de imagem, NUNCA uma credencial — ver
-- creative_core/enrichment.py::_OpenAIProvider.propose para exatamente o que preenche isto.
--
-- Sempre NULL para provider = 'fake' (o provider fake não tem custo) e para toda proposta desta ou de
-- fases anteriores que nunca chamou o provider real — nesta rodada (F.2.A) isso é TODA proposta, já
-- que nenhuma chamada real à OpenAI é feita (ver docs/features/creative-generator-fase-f2a.md).
--
-- Aditiva e reversível: uma coluna nova, nullable, sem default além de NULL; nada existente muda.

ALTER TABLE creative_enrichment_proposals
  ADD COLUMN provider_meta JSONB CHECK (provider_meta IS NULL OR jsonb_typeof(provider_meta) = 'object');
