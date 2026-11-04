'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sqlPath = path.join(__dirname, '..', 'dls_migration_v5_demandas_coletivas.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

test('migração é transacional, aditiva e idempotente', () => {
  assert.match(sql, /^\s*begin;/im);
  assert.match(sql, /\bcommit;/im);
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
  // A única exclusão de demandas é a RPC explícita de exclusão do agregado.
  const deleteDemandas = sql.match(/delete\s+from\s+public\.dls_demandas\b/gi) || [];
  assert.equal(deleteDemandas.length, 1);
  const deleteRpc = sql.match(/create or replace function public\.dls_excluir_demanda_completa[\s\S]*?\$\$;/i);
  assert.ok(deleteRpc, 'RPC de exclusão completa deve existir');
  assert.match(deleteRpc[0], /delete\s+from\s+public\.dls_demandas\b/i);
  assert.ok((sql.match(/add column if not exists/gi) || []).length >= 2);
  assert.ok((sql.match(/create table if not exists/gi) || []).length >= 3);
});

test('cria as três tabelas filhas e a coluna de modalidade', () => {
  assert.match(sql, /add column if not exists modalidade_demanda text/i);
  assert.match(sql, /add column if not exists valor_estimado numeric/i);
  assert.match(sql, /create table if not exists public\.dls_demanda_reclamantes/i);
  assert.match(sql, /create table if not exists public\.dls_demanda_calculos/i);
  assert.match(sql, /create table if not exists public\.dls_demanda_responsaveis/i);
  assert.match(sql, /uq_dls_reclamantes_legado_principal/i);
  assert.match(sql, /uq_dls_calculos_legado_principal/i);
  assert.match(sql, /uq_dls_responsaveis_par_ativo/i);
  assert.match(sql, /uq_dls_responsaveis_principal_ativo/i);
});

test('calculos têm escopo, executor, crédito congelado e vínculo composto com reclamante', () => {
  assert.match(sql, /dls_calculos_escopo_chk/i);
  assert.match(sql, /dls_calculos_status_chk/i);
  assert.match(sql, /dls_calculos_reclamante_mesma_demanda_fk/i);
  assert.match(sql, /calculista_executor_id text references public\.dls_calculistas/i);
  assert.match(sql, /concluido_por_calculista_id text references public\.dls_calculistas/i);
  assert.match(sql, /credito_legado_presumido boolean/i);
  assert.match(sql, /concluido_em timestamptz/i);
});

test('RPC de gravação é transacional, com advisory lock e valida vínculos', () => {
  assert.match(sql, /create or replace function public\.dls_salvar_demanda_coletiva/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('dls_demanda:' \|\| v_id\)\)/i);
  assert.match(sql, /Executor do cálculo em aberto precisa fazer parte da equipe ativa/i);
  assert.match(sql, /not in \('entregue', 'cancelada'\)[\s\S]*?calculista_executor_id/i);
  assert.match(sql, /Demanda coletiva exige pelo menos um reclamante ativo/i);
  assert.match(sql, /Reclamante de cálculo deve estar no payload ativo/i);
  assert.match(sql, /Cálculo concluído não pode ser removido/i);
  assert.match(sql, /v_team_id/i);
  assert.match(sql, /uq_dls_responsaveis_par_ativo/i);
  assert.ok((sql.match(/security invoker/gi) || []).length >= 4);
});

test('conclusão, reabertura e correção de crédito são auditadas', () => {
  assert.match(sql, /create or replace function public\.dls_concluir_calculo/i);
  assert.match(sql, /create or replace function public\.dls_reabrir_calculo/i);
  assert.match(sql, /create or replace function public\.dls_corrigir_credito_calculo/i);
  assert.match(sql, /Reabertura de cálculo exige motivo auditável/i);
  assert.match(sql, /Correção de crédito exige motivo auditável/i);
  assert.match(sql, /novo calculista creditado precisa fazer parte da equipe ativa/i);
  assert.match(sql, /Crédito do cálculo %s corrigido de %s para %s/i);
  assert.match(sql, /Cálculo %s reaberto \(crédito anterior: %s\)/i);
  assert.match(sql, /Cálculo inativo\/cancelado não pode ser concluído/i);
  assert.ok((sql.match(/credito_legado_presumido\s*=\s*false/gi) || []).length >= 3);
});

test('backfill do legado só ocorre quando não há nenhum filho e preserva a premissa documentada', () => {
  assert.match(sql, /Premissa documentada: a produtividade legada/i);
  assert.match(sql, /credito_legado_presumido=true/);
  assert.match(sql, /and not exists \(\s*select 1 from public\.dls_demanda_reclamantes r\s+where r\.demanda_id = d\.id\s*\)/is);
  assert.match(sql, /(?:where|and) not exists \(\s*select 1 from public\.dls_demanda_calculos c\s+where c\.demanda_id = d\.id\s*\)/is);
  assert.match(sql, /on conflict \(id\) do update set/i);
  assert.doesNotMatch(sql, /and r\.legado_principal\s*\)/i);
  assert.doesNotMatch(sql, /and c\.legado_principal\s*\)/i);
});

test('view, relatório de migração e RLS/grants estão presentes', () => {
  assert.match(sql, /create or replace view public\.vw_dls_calculos_produtividade/i);
  assert.match(sql, /security_invoker = true/i);
  assert.match(sql, /create or replace function public\.dls_relatorio_migracao_v5/i);
  assert.match(sql, /calculos_legado_entregues_sem_credito/i);
  assert.match(sql, /alter table public\.dls_demanda_reclamantes enable row level security/i);
  assert.match(sql, /alter table public\.dls_demanda_calculos enable row level security/i);
  assert.match(sql, /alter table public\.dls_demanda_responsaveis enable row level security/i);
  assert.match(sql, /grant execute on function public\.dls_salvar_demanda_coletiva/i);
  assert.match(sql, /grant execute on function public\.dls_concluir_calculo/i);
  assert.match(sql, /grant execute on function public\.dls_reabrir_calculo/i);
  assert.match(sql, /grant execute on function public\.dls_corrigir_credito_calculo/i);
});

test('a RPC de agregado não bloqueia a restauração de crédito congelado de backup', () => {
  assert.doesNotMatch(sql, /Conclua o cálculo pela ação específica de conclusão/i);
  assert.match(sql, /Cálculo concluído não pode ser removido/i);
  assert.match(sql, /Demanda coletiva entregue exige todos os cálculos concluídos ou cancelados/i);
  assert.match(sql, /when excluded\.status = 'entregue'/i);
  assert.match(sql, /then c\.concluido_por_calculista_id/i);
  assert.match(sql, /then c\.concluido_em else excluded\.concluido_em/i);
});

test('payload rejeita IDs duplicados, vazios e de outra demanda', () => {
  assert.match(sql, /Reclamante sem ID no payload/i);
  assert.match(sql, /Cálculo sem ID no payload/i);
  assert.match(sql, /Vínculo de equipe sem ID no payload/i);
  assert.match(sql, /Há cálculos com ID duplicado no payload/i);
  assert.match(sql, /Há vínculos de equipe com ID duplicado no payload/i);
  assert.match(sql, /group by btrim\(r->>'id'\)/i);
  assert.match(sql, /group by btrim\(c->>'id'\)/i);
  assert.match(sql, /r\.id in \(select btrim\(x->>'id'\)/i);
  assert.match(sql, /c\.id in \(select btrim\(x->>'id'\)/i);
});

test('histórico de equipe e crédito impede exclusão destrutiva de calculista', () => {
  assert.match(sql, /dls_calculos_executor_fk[\s\S]*?on delete restrict/i);
  assert.match(sql, /dls_calculos_credito_fk[\s\S]*?on delete restrict/i);
  assert.match(sql, /dls_responsaveis_calculista_fk[\s\S]*?on delete restrict/i);
  assert.match(sql, /drop constraint if exists dls_demanda_calculos_concluido_por_calculista_id_fkey/i);
});

test('exclusão do agregado preserva filhos e usa transação/lock', () => {
  assert.match(sql, /create or replace function public\.dls_excluir_demanda_completa/i);
  const fn = sql.match(/create or replace function public\.dls_excluir_demanda_completa[\s\S]*?\$\$;/i)[0];
  assert.match(fn, /pg_advisory_xact_lock/i);
  assert.match(fn, /for update/i);
  assert.match(fn, /delete from public\.dls_demanda_calculos[\s\S]*delete from public\.dls_demanda_reclamantes[\s\S]*delete from public\.dls_demanda_responsaveis[\s\S]*delete from public\.dls_demandas/i);
  assert.match(sql, /grant execute on function public\.dls_excluir_demanda_completa\(text\) to anon, authenticated/i);
});

test('reclamante com cálculo não é apagado em cascata', () => {
  assert.match(sql, /dls_calculos_reclamante_mesma_demanda_fk[\s\S]*?on delete restrict/i);
  assert.match(sql, /drop constraint if exists dls_calculos_reclamante_mesma_demanda_fk/i);
});

test('restauração preserva a data global de conclusão', () => {
  assert.match(sql, /add column if not exists concluida_em timestamptz/i);
  assert.match(sql, /valor_estimado, concluida_em/i);
  assert.match(sql, /p_demanda->>'concluida_em'[\s\S]*?::timestamptz/i);
  assert.match(sql, /concluida_em = case[\s\S]*?coalesce\(excluded\.concluida_em, dls_demandas\.concluida_em\)/i);
});

test('crédito concluído é protegido contra PATCH direto fora das RPCs auditadas', () => {
  assert.match(sql, /dls\.calculo_auditado/i);
  assert.match(sql, /Cálculo concluído só pode ser alterado pelas RPCs auditadas/i);
  assert.match(sql, /perform set_config\('dls\.calculo_auditado', 'on', true\)/i);
  const auditConfigs = sql.match(/set_config\('dls\.calculo_auditado', 'on', true\)/gi) || [];
  assert.ok(auditConfigs.length >= 2, 'reabertura e correção precisam autorizar a alteração auditada');
});

test('migração v5 fornece sequência de demandas com piso atômico e grant', () => {
  const fn = sql.match(/create or replace function public\.dls_next_demand_sequence[\s\S]*?\$\$;/i);
  assert.ok(fn, 'RPC dls_next_demand_sequence deve existir');
  assert.match(fn[0], /p_last_used integer/i);
  assert.match(fn[0], /greatest\(coalesce\(p_last_used, 100\), 100\)/i);
  assert.match(fn[0], /from public\.dls_demandas/i);
  assert.match(fn[0], /max\(\(regexp_replace\(id/i);
  assert.match(fn[0], /greatest\(public\.dls_sequences\.current_value, excluded\.current_value\)/i);
  assert.match(fn[0], /current_value = current_value \+ 1/i);
  assert.match(sql, /grant execute on function public\.dls_next_demand_sequence\(integer\) to anon, authenticated/i);
});

test('sequência genérica também eleva a linha existente ao piso informado', () => {
  const fn = sql.match(/create or replace function public\.dls_next_sequence[\s\S]*?\$\$;/i);
  assert.ok(fn, 'RPC dls_next_sequence deve ser redefinida');
  assert.match(fn[0], /floor_value integer := greatest\(coalesce\(default_value, 100\), 100\)/i);
  assert.match(fn[0], /greatest\(public\.dls_sequences\.current_value, excluded\.current_value\)/i);
  assert.match(fn[0], /current_value = current_value \+ 1/i);
  assert.match(sql, /grant execute on function public\.dls_next_sequence\(text, integer\) to anon, authenticated/i);
});
