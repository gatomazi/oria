-- Clientes · segmentos de campanha que nascem da RFM ou de filtros da tela de Clientes.
--
-- `segments` guardava só a definição de filtro (dinâmica). Para o segmento salvo a partir de Clientes ser
-- auditável e reproduzível, ele passa a registrar de onde veio e com qual regra:
--
--   origem          'filtros' (construtor de Campanhas, o que já existia), 'rfm' (segmento da matriz) ou
--                   'clientes' (filtros combinados da lista de Clientes)
--   politica        'dinamico': a audiência é reavaliada a cada uso; nenhuma lista fixa de pessoas é gravada
--   predicado       predicado numérico da RFM (recência em dias, frequência, valor) no momento em que foi salvo
--   rfm_versao      versão do algoritmo (`rfm-v1`); classificado_em = data de referência (`as_of`) da RFM
--   rfm_segmento    id do segmento RFM de origem (informativo; a seleção real é o predicado, não o rótulo)
--
-- Aditiva e com DEFAULT: linhas existentes viram origem 'filtros', dinâmicas. Nada é reescrito nem removido.

ALTER TABLE segments ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'filtros';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS politica TEXT NOT NULL DEFAULT 'dinamico';
ALTER TABLE segments ADD COLUMN IF NOT EXISTS predicado JSONB;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS rfm_versao TEXT;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS classificado_em TIMESTAMPTZ;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS rfm_segmento TEXT;

ALTER TABLE segments ADD CONSTRAINT ck_segments_origem CHECK (origem IN ('filtros', 'rfm', 'clientes'));
ALTER TABLE segments ADD CONSTRAINT ck_segments_politica CHECK (politica IN ('dinamico'));
