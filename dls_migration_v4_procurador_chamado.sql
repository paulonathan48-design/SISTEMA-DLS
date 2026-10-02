-- ============================================================
-- DLS · Nova demanda: procurador responsável + chamado (opcional)
-- Arquivo: dls_migration_v4_procurador_chamado.sql
-- EXECUÇÃO MANUAL no Supabase SQL Editor (não é aplicado pelo frontend).
-- Idempotente: pode ser executado mais de uma vez sem efeitos colaterais.
-- Não apaga dados. Não remove a coluna legada "natureza".
-- O frontend detecta as colunas automaticamente; sem esta migração,
-- procurador/chamado funcionam só em memória (não persistem).
-- ============================================================

ALTER TABLE public.dls_demandas
ADD COLUMN IF NOT EXISTS procurador text;

ALTER TABLE public.dls_demandas
ADD COLUMN IF NOT EXISTS chamado text;

-- Leitura/escrita seguem as permissões já existentes da tabela
-- (políticas browser_all para anon/authenticated). Nada a alterar.
