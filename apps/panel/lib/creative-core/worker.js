'use strict';

// Worker em processo do Gerador de Criativos (mesmo padrão dos jobs existentes do painel: 1 instância, setInterval).
// Um item por vez: queued → planning → generating → processing → completed | failed.
// Falha de infraestrutura (serviço do core fora do ar) volta o item pra fila com espera; erro de negócio/provedor
// falha o item com a mensagem segura do contrato. A OpenAI key é decifrada só aqui, na hora da chamada, e não é
// gravada em lugar nenhum.

const crypto = require('crypto');
const { CoreUnavailableError, CoreRequestError } = require('./client');
const { planSummary } = require('./requests');

const INFRA_RETRY_DELAY_MS = 60_000;
const MAX_INFRA_RETRIES = 3;

function erroSeguro(code, message, retryable = false) {
  return { code, message, retryable };
}

// Consumo cobrado pela OpenAI nesta geração, no formato das colunas da tabela.
//
// Quando o provedor não reporta `usage`, devolve objeto vazio — e as colunas ficam NULL. NULL aqui
// quer dizer "não medido"; gravar 0 faria a soma da tela de custos parecer menor que a fatura real.
// O modelo é registrado junto porque o preço é por modelo: sem ele, trocar de modelo reprecificaria
// retroativamente tudo que já foi gerado.
function consumoDoResultado(result, plan) {
  const usage = result && result.metadata && result.metadata.usage;
  const modeloImagem = (plan && plan.model && plan.model.model) || null;
  if (!usage || typeof usage !== 'object') return modeloImagem ? { modeloImagem } : {};
  const inteiro = (v) => (Number.isInteger(v) ? v : null);
  return {
    modeloImagem,
    tokensEntrada: inteiro(usage.input_tokens),
    tokensSaida: inteiro(usage.output_tokens),
    tokensEntradaCache: inteiro(usage.cached_input_tokens),
    tokensEntradaTexto: inteiro(usage.text_input_tokens),
    tokensEntradaImagem: inteiro(usage.image_input_tokens),
  };
}

// Trace da chamada ao provedor (Fase A1), no formato das colunas da tabela. Só observação: um trace ausente,
// malformado ou grande demais é descartado — nunca derruba nem altera a geração.
//
// `generation_trace` guarda um trace POR TENTATIVA (chave = nº da tentativa): um retry não apaga a evidência
// da tentativa anterior. As colunas escalares refletem a tentativa mais recente.
const MAX_TRACE_BYTES = 16 * 1024;

function traceDoResultado(result, item) {
  const trace = result && result.metadata && result.metadata.trace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return {};
  let tamanho = 0;
  try { tamanho = JSON.stringify(trace).length; } catch { return {}; }
  if (tamanho > MAX_TRACE_BYTES) return {};
  const anteriores = item && item.generationTrace && typeof item.generationTrace === 'object' && !Array.isArray(item.generationTrace)
    ? item.generationTrace : {};
  const tentativa = String(Number.isInteger(trace.attempt) && trace.attempt > 0 ? trace.attempt : (item && item.generationAttempt) || 1);
  const texto = (v, max) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
  return {
    generationTrace: { ...anteriores, [tentativa]: trace },
    modelServed: texto(trace.model_served, 80),
    durationMs: Number.isInteger(trace.duration_ms) && trace.duration_ms >= 0 && trace.duration_ms < 2 ** 31 ? trace.duration_ms : null,
    providerRequestId: texto(trace.provider_request_id, 120),
  };
}

// Multi-tenant (Fase 3 · INV-22): `paraCadaTenant(fn)` chama fn(tenantId) uma vez por Organization, já dentro
// do contexto dela; `byokDe`/`storageDe` dão a chave e o storage DAQUELE tenant. Não existe tenant de processo.
function createWorker({ store, core, byokDe, storageDe, paraCadaTenant, flagsProvider, logger = console, intervalMs = 5_000 }) {
  if (typeof paraCadaTenant !== 'function' || typeof byokDe !== 'function' || typeof storageDe !== 'function') {
    throw new Error('worker de criativos exige paraCadaTenant, byokDe e storageDe');
  }
  let rodando = false;
  let timer = null;

  // `consumo` vem preenchido quando a chamada ao provedor chegou a acontecer: falhar depois de
  // gastar ainda é gasto, e não registrar isso faria a tela de custos mostrar menos do que a fatura.
  async function falhar(tenantId, item, error, consumo) {
    await store.updateItem(tenantId, item.creativeId, {
      status: 'failed', error, finishedAt: new Date().toISOString(), ...(consumo || {}),
    });
  }

  async function processarItem(tenantId, item) {
    const byok = byokDe(tenantId);
    const storage = storageDe(tenantId);
    let plan = item.plan;
    try {
      if (!plan) {
        plan = await core.plan(item.request);
        await store.updateItem(tenantId, item.creativeId, {
          plan,
          planSummary: planSummary(plan),
          contextId: plan.context.context_id,
          persona: plan.persona ? plan.persona.label : null,
          brandKitVersion: plan.brand_kit.version,
          nicheKitVersion: plan.niche_kit.version,
          promptVersion: plan.prompt.prompt_version,
          funnelStage: plan.funnel_stage,
          remarketingIntent: plan.remarketing_intent,
        });
      }
      await store.updateItem(tenantId, item.creativeId, { status: 'generating' });

      const apiKey = await byok.resolve();
      if (!apiKey) {
        await falhar(tenantId, item, erroSeguro('BYOK_MISSING', 'Cadastre (ou reconecte) a OpenAI API Key em Configurações.', true));
        return;
      }
      const references = plan.references.map((r) => ({
        ref: r.ref,
        data_base64: storage.readProductReference(r.ref).toString('base64'),
      }));
      const result = await core.generate({ plan, references, apiKey, attempt: item.generationAttempt });
      const consumo = { ...consumoDoResultado(result, plan), ...traceDoResultado(result, item) };

      await store.updateItem(tenantId, item.creativeId, { status: 'processing' });
      if (result.status !== 'completed' || !result.asset) {
        await falhar(tenantId, item, result.error || erroSeguro('GENERATION_FAILED', 'Falha ao gerar o criativo.', true), consumo);
        return;
      }
      const salvo = storage.saveCreativeAsset(item.creativeId, result.asset);
      const assetId = crypto.randomUUID();
      await store.insertAsset(tenantId, { id: assetId, creativeId: item.creativeId, ...salvo });
      await store.updateItem(tenantId, item.creativeId, {
        status: 'completed',
        assetId,
        error: null,
        finishedAt: new Date().toISOString(),
        ...consumo,
        record: {
          creative_id: item.creativeId,
          tenant_id: tenantId,
          brand_id: item.brandId,
          engine: plan.strategy,
          product_mode: plan.product_mode,
          product_ids: plan.products.map((p) => p.id),
          angle: plan.angle.id,
          context_id: plan.context.context_id,
          persona: plan.persona ? plan.persona.label : null,
          placement: plan.placement.id,
          funnel_stage: plan.funnel_stage,
          remarketing_intent: plan.remarketing_intent,
          brand_kit_version: plan.brand_kit.version,
          niche_kit_version: plan.niche_kit.version,
          prompt_version: plan.prompt.prompt_version,
          quality: plan.model.quality,
          asset: salvo.storageKey,
          generation_attempt: item.generationAttempt,
          core_version: plan.versions && plan.versions.core_version,
          created_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof CoreUnavailableError) {
        if (item.infraRetries + 1 >= MAX_INFRA_RETRIES) {
          await falhar(tenantId, item, erroSeguro('CORE_UNAVAILABLE', 'Serviço do gerador indisponível. Tente novamente mais tarde.', true));
        } else {
          await store.updateItem(tenantId, item.creativeId, {
            status: 'queued', infraRetries: item.infraRetries + 1, nextAttemptAt: Date.now() + INFRA_RETRY_DELAY_MS,
          });
        }
      } else if (err instanceof CoreRequestError) {
        await falhar(tenantId, item, erroSeguro(err.code, err.message, err.retryable));
      } else {
        // Nunca repassa err.message (pode conter caminho de arquivo ou dado interno).
        logger.error(`[CRIATIVOS] falha inesperada no item ${item.creativeId}: ${err && err.name}`);
        await falhar(tenantId, item, erroSeguro('INTERNAL_ERROR', 'Erro interno ao processar o criativo.', true));
      }
    } finally {
      await store.refreshJobStatus(tenantId, item.jobId);
    }
  }

  // Um item por Organization por tick; devolve true se algum foi processado.
  async function tick() {
    if (rodando || !core.configured) return false;
    rodando = true;
    let processou = false;
    try {
      await paraCadaTenant(async (tenantId) => {
        const flags = await flagsProvider();
        if (!flags.creative_generator) return;
        const item = await store.claimNextItem(tenantId);
        if (!item) return;
        await store.refreshJobStatus(tenantId, item.jobId);
        await processarItem(tenantId, item);
        processou = true;
      });
      return processou;
    } catch (err) {
      logger.error(`[CRIATIVOS] worker: ${err && err.name}`);
      return false;
    } finally {
      rodando = false;
    }
  }

  return {
    tick,
    async start() {
      try {
        await paraCadaTenant(async (tenantId) => {
          const n = await store.requeueStuck(tenantId);
          if (n) logger.log(`[CRIATIVOS] ${n} item(ns) interrompido(s) voltaram pra fila`);
        });
      } catch (err) {
        logger.error(`[CRIATIVOS] requeue na inicialização falhou: ${err && err.name}`);
      }
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Encadeia ticks logo após criar um lote, sem esperar o intervalo.
    kick() {
      setImmediate(async () => {
        while (await tick()) { /* processa até esvaziar a fila */ }
      });
    },
  };
}

module.exports = { createWorker, traceDoResultado, INFRA_RETRY_DELAY_MS, MAX_INFRA_RETRIES };
