-- ============================================================
-- DLS · Gestão de Calculistas — métricas reais e dinâmicas
-- Arquivo: dls_calculistas_metricas.sql
-- Schema ativo: dls_* (dls_calculistas / dls_demandas)
-- EXECUÇÃO MANUAL no Supabase SQL Editor (não é aplicado pelo frontend).
-- Idempotente: pode ser executado mais de uma vez sem duplicar efeitos.
-- Não apaga dados. Não renomeia tabelas. Não remove colunas legadas.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) Coluna técnica de data real de entrega (somente se não existir)
-- NÃO usar updated_at/touched_at como data de entrega.
-- ------------------------------------------------------------
ALTER TABLE public.dls_demandas
ADD COLUMN IF NOT EXISTS concluida_em timestamptz;

-- Índice de apoio (leitura de SLA por responsável)
CREATE INDEX IF NOT EXISTS idx_dls_demandas_concluida_em
  ON public.dls_demandas (concluida_em);
CREATE INDEX IF NOT EXISTS idx_dls_demandas_resp_status
  ON public.dls_demandas (responsavel_id, status);

-- ------------------------------------------------------------
-- 2) Trigger: registra automaticamente o momento do "entregue"
-- INSERT como entregue            -> concluida_em = now()
-- UPDATE neutro -> entregue        -> concluida_em = now()
-- UPDATE já entregue (só edição)   -> preserva concluida_em original
-- Reabertura (entregue -> outro)   -> concluida_em = NULL
-- Nova entrega após reabertura     -> concluida_em = now()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dls_set_concluida_em()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'entregue' THEN
        IF TG_OP = 'INSERT' THEN
            NEW.concluida_em = COALESCE(NEW.concluida_em, NOW());
        ELSIF OLD.status IS DISTINCT FROM 'entregue' THEN
            NEW.concluida_em = COALESCE(NEW.concluida_em, NOW());
        ELSE
            NEW.concluida_em = OLD.concluida_em;
        END IF;
    ELSIF TG_OP = 'UPDATE'
      AND OLD.status = 'entregue'
      AND NEW.status IS DISTINCT FROM 'entregue' THEN
        NEW.concluida_em = NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dls_demandas_set_concluida_em
ON public.dls_demandas;

CREATE TRIGGER dls_demandas_set_concluida_em
BEFORE INSERT OR UPDATE
ON public.dls_demandas
FOR EACH ROW
EXECUTE FUNCTION public.dls_set_concluida_em();

-- ------------------------------------------------------------
-- 3) Backfill best-effort (OPCIONAL, seguro):
-- Preenche concluida_em SOMENTE onde status='entregue' AND concluida_em IS NULL
-- usando o evento "entregue" mais recente do historico jsonb
-- (ex.: {"data":"28/06/2026, 22:45:33","texto":"Status alterado para \"Entregue\""}).
-- Se o parse falhar, mantém NULL (demanda excluída do SLA até ter timestamp
-- confiável — preferível a inventar SLA falso).
-- Pode ser pulado sem prejuízo: novas entregas passam a registrar via trigger.
-- ------------------------------------------------------------
DO $$
DECLARE
  r    RECORD;
  h    JSONB;
  txt  TEXT;
  dtxt TEXT;
  ts   TIMESTAMPTZ;
BEGIN
  FOR r IN
    SELECT id, historico
    FROM public.dls_demandas
    WHERE status = 'entregue'
      AND concluida_em IS NULL
  LOOP
    ts := NULL;
    IF r.historico IS NOT NULL AND jsonb_typeof(r.historico) = 'array' THEN
      FOR h IN SELECT * FROM jsonb_array_elements(r.historico)
      LOOP
        txt := COALESCE(h ->> 'texto', '');
        IF txt ILIKE '%entreg%' THEN
          dtxt := COALESCE(NULLIF(TRIM(h ->> 'data'), ''), '');
          BEGIN
            IF dtxt ~ '^\d{2}/\d{2}/\d{4}, \d{2}:\d{2}(:\d{2})?$' THEN
              BEGIN
                ts := to_timestamp(dtxt, 'DD/MM/YYYY, HH24:MI:SS');
              EXCEPTION WHEN OTHERS THEN
                BEGIN ts := to_timestamp(dtxt, 'DD/MM/YYYY, HH24:MI');
                EXCEPTION WHEN OTHERS THEN ts := NULL; END;
              END;
            ELSIF dtxt ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2}(:\d{2})?$' THEN
              BEGIN
                ts := to_timestamp(dtxt, 'DD/MM/YYYY HH24:MI:SS');
              EXCEPTION WHEN OTHERS THEN
                BEGIN ts := to_timestamp(dtxt, 'DD/MM/YYYY HH24:MI');
                EXCEPTION WHEN OTHERS THEN ts := NULL; END;
              END;
            ELSE
              BEGIN ts := dtxt::timestamptz;
              EXCEPTION WHEN OTHERS THEN ts := NULL; END;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            ts := NULL;
          END;
          -- historico[0] é o mais recente (unshift no frontend): primeiro válido vence
          IF ts IS NOT NULL THEN EXIT; END IF;
        END IF;
      END LOOP;
    END IF;
    IF ts IS NOT NULL THEN
      UPDATE public.dls_demandas SET concluida_em = ts WHERE id = r.id;
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 4) VIEW de gestão: cadastro de dls_calculistas + métricas reais
-- concluidas = COUNT(status='entregue')
-- ativas     = COUNT(status NOT IN ('entregue','cancelada')) — inclui atrasada
-- sla        = 100 * entregues_no_prazo / entregues_elegíveis
--   elegível: entregue + prazo NOT NULL + concluida_em NOT NULL
--   no prazo: concluida_em::date <= prazo
--   sem elegível -> NULL (frontend exibe "—", nunca 95 mockado)
-- Mesmo formato de objeto esperado pelo frontend (mesmos nomes).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_dls_calculistas_gestao AS
SELECT
    c.id,
    c.nome,
    c.cargo,
    c.email,
    c.tel,
    c.espec,
    c.status,
    c.meta,

    COUNT(d.id) FILTER (
        WHERE d.status = 'entregue'
    )::integer AS concluidas,

    COUNT(d.id) FILTER (
        WHERE d.status NOT IN ('entregue', 'cancelada')
    )::integer AS ativas,

    ROUND(
        100.0 *
        COUNT(d.id) FILTER (
            WHERE
                d.status = 'entregue'
                AND d.prazo IS NOT NULL
                AND d.concluida_em IS NOT NULL
                AND d.concluida_em::date <= d.prazo
        )
        /
        NULLIF(
            COUNT(d.id) FILTER (
                WHERE
                    d.status = 'entregue'
                    AND d.prazo IS NOT NULL
                    AND d.concluida_em IS NOT NULL
            ),
            0
        ),
        2
    ) AS sla,

    c.tempo_medio,
    c.obs,
    c.created_at,
    c.updated_at

FROM public.dls_calculistas c

LEFT JOIN public.dls_demandas d
    ON d.responsavel_id = c.id

GROUP BY
    c.id,
    c.nome,
    c.cargo,
    c.email,
    c.tel,
    c.espec,
    c.status,
    c.meta,
    c.tempo_medio,
    c.obs,
    c.created_at,
    c.updated_at;

-- Leitura browser-only (anon key) — mesmo padrão das tabelas dls_*
GRANT SELECT ON public.vw_dls_calculistas_gestao
TO anon, authenticated;

COMMIT;

-- ------------------------------------------------------------
-- 5) VERIFICAÇÃO (somente leitura, execute após o COMMIT):
--
-- -- Consistência por responsável (deve bater com a Gestão após refresh):
-- SELECT
--     responsavel_id,
--     COUNT(*) FILTER (WHERE status = 'entregue') AS concluidas,
--     COUNT(*) FILTER (WHERE status NOT IN ('entregue','cancelada')) AS ativas
-- FROM public.dls_demandas
-- GROUP BY responsavel_id
-- ORDER BY responsavel_id;
--
-- -- Visão da Gestão:
-- SELECT id, nome, concluidas, ativas, sla
-- FROM public.vw_dls_calculistas_gestao
-- ORDER BY nome;
--
-- -- SLA detalhado (elegíveis vs no prazo):
-- SELECT
--   c.nome,
--   COUNT(d.id) FILTER (
--     WHERE d.status='entregue' AND d.prazo IS NOT NULL AND d.concluida_em IS NOT NULL
--   ) AS elegiveis,
--   COUNT(d.id) FILTER (
--     WHERE d.status='entregue' AND d.prazo IS NOT NULL AND d.concluida_em IS NOT NULL
--       AND d.concluida_em::date <= d.prazo
--   ) AS no_prazo
-- FROM public.dls_calculistas c
-- LEFT JOIN public.dls_demandas d ON d.responsavel_id = c.id
-- GROUP BY c.nome ORDER BY c.nome;
-- ------------------------------------------------------------
