-- ── Composição do plano `internal` e vocabulário de features ─────────────────────────────────
--
-- Esta migration é ADITIVA. Faz duas coisas, e nenhuma delas tira acesso de ninguém:
--   1. o domain `platform_feature` passa a aceitar `meta_ads`, `google_ads` e `analytics_ga4`;
--   2. o plano `internal` passa a conter essas três.
--
-- Nada é apagado. Isso é deliberado, e o motivo é a ordem em que um deploy acontece.
--
-- ── Por que ela NÃO apaga catalog, exchanges e refunds ───────────────────────────────────────
-- A primeira versão desta migration apagava sete chaves de `plan_features`, com a premissa de que
-- o painel lia `app_config.entitlements` e portanto o DELETE não afetava runtime. Essa premissa
-- morreu na 0023: `plan_features` virou a FONTE CANÔNICA lida pelo painel.
--
-- `requireEntitlement` ainda confere essas três chaves (lib/platform/feature-routes.js → ROTAS),
-- porque o guard de capability existe mas não está ligado em server.js. Apagá-las hoje seria 403
-- em Catálogo, Trocas e Reembolsos — telas que funcionam. Elas saem depois que o consumidor
-- runtime migrar, nunca antes.
--
-- ── Por que ela também NÃO apaga os quatro modos de criativos ────────────────────────────────
-- Aqui a auditoria do código NOVO é limpa: `resolveFlags` (lib/creative-core/flags.js) deriva os
-- quatro motores de `creative_generator` e não lê mais `creative_clean_angles`,
-- `creative_remarketing`, `creative_funnel_visual` nem `creative_multi_product`. Mas o código de
-- PRODUÇÃO ATUAL ainda as lê do plano (`entitlements[flag] === true`), e o pre-deploy roda esta
-- migration enquanto a release antiga continua atendendo:
--
--   · na janela entre o migrate e a troca de release, os quatro motores do Gerador cairiam para
--     quem depende deles;
--   · se a release nova falhar DEPOIS de migrar, a antiga segue no ar e os motores continuam
--     desligados até alguém corrigir — sem nada no deploy que avise.
--
-- "Consumidor convertido" quer dizer convertido em produção, não na branch. Por isso a remoção
-- física é uma migration de limpeza SEPARADA, a rodar quando a release nova já estiver no ar e
-- verificada. Até lá as quatro linhas são ruído inofensivo: `FEATURES_DEPRECIADAS` as declara,
-- `resolverAcessoEfetivo` só itera sobre `FEATURES`, `planoEfetivo` do painel as descarta, e a
-- tela de planos do Oria Admin só renderiza features do vocabulário. O plano de retirada, com o
-- SQL da limpeza, está em docs/architecture/features-vs-connectors.md.
--
-- ── Por que o domain só CRESCE ───────────────────────────────────────────────────────────────
-- Estreitar o domain é a última fase da depreciação, e só faz sentido quando não houver mais
-- linha nem ambiente carregando as chaves antigas. Aqui ele apenas passa a aceitar as três novas.
-- É superconjunto do anterior: nenhuma linha existente pode violá-lo, e código antigo continua
-- gravando só o que já gravava.

ALTER DOMAIN platform_feature DROP CONSTRAINT platform_feature_check;
ALTER DOMAIN platform_feature ADD CONSTRAINT platform_feature_check
  CHECK (VALUE IN (
    'whatsapp',
    'instagram',
    'advancedAutomations',
    'catalog',
    'exchanges',
    'refunds',
    'financial',
    'creative_generator',
    'meta_ads',
    'google_ads',
    'analytics_ga4',
    'creative_clean_angles',
    'creative_remarketing',
    'creative_funnel_visual',
    'creative_multi_product'
  ));

-- As três áreas que já existem no produto e faltavam no vocabulário comercial.
INSERT INTO plan_features (plan_id, feature, habilitada)
SELECT p.id, f, true FROM plans p, unnest(ARRAY[
  'meta_ads',
  'google_ads',
  'analytics_ga4'
]::platform_feature[]) AS f
WHERE p.chave = 'internal'
ON CONFLICT DO NOTHING;
