'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'dls_migration_v6_conclusao_impugnacao.sql'),
  'utf8'
);

function functionBody(name) {
  const re = new RegExp(
    `create or replace function public\\.${name}[\\s\\S]*?\\$\\$;`,
    'i'
  );
  const match = sql.match(re);
  assert.ok(match, `função ${name} deve existir`);
  return match[0];
}

test('migração v6 é transacional, aditiva e idempotente', () => {
  assert.match(sql, /^\s*begin;/im);
  assert.match(sql, /\bcommit;/im);
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\s+column\b/i);
  assert.equal((sql.match(/create table if not exists/gi) || []).length, 2);
  assert.match(sql, /create unique index if not exists uq_dls_calculos_id_demanda/i);
  assert.match(sql, /create unique index if not exists uq_dls_conclusoes_vigente/i);
});

test('normalização de tipos corrige Cálculo Civil e E-Social no banco', () => {
  assert.match(sql, /set tipo = 'Cálculo Cível'[\s\S]*?calculo civil[\s\S]*?calculo civel/i);
  assert.match(sql, /set tipo = 'E-Social'[\s\S]*?e-social[\s\S]*?esocial/i);
  assert.match(sql, /create or replace function public\.dls_normalizar_tipo_calculo/i);
  assert.match(sql, /before insert or update of tipo on public\.dls_demandas/i);
  assert.match(sql, /before insert or update of tipo on public\.dls_demanda_calculos/i);
  assert.match(sql, /get diagnostics v_count = row_count/i);
  assert.match(sql, /raise notice '\[DLS v6\] dls_demandas: % linha\(s\) normalizada\(s\) para Cálculo Cível\.'/i);
  assert.match(sql, /raise notice '\[DLS v6\] dls_demandas: % linha\(s\) normalizada\(s\) para E-Social\.'/i);
  assert.match(sql, /raise notice '\[DLS v6\] dls_demanda_calculos: % linha\(s\) normalizada\(s\) para Cálculo Cível\.'/i);
  assert.match(sql, /raise notice '\[DLS v6\] dls_demanda_calculos: % linha\(s\) normalizada\(s\) para E-Social\.'/i);
  assert.doesNotMatch(sql, /set tipo = 'Cálculo Civil'/i);
});

test('conclusões versionadas têm uma única vigente e histórico protegido', () => {
  assert.match(sql, /create table if not exists public\.dls_demanda_conclusoes/i);
  for (const column of [
    'id', 'demanda_id', 'tipo_conclusao', 'situacao', 'versao', 'concluida_em',
    'registrado_por', 'observacao', 'demanda_numero_snapshot',
    'cliente_nome_snapshot', 'modalidade_snapshot', 'reaberta_em',
    'reaberta_por', 'motivo_reabertura', 'created_at', 'updated_at'
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(sql, /check \(tipo_conclusao in \('impugnacao', 'concordancia', 'atualizacao', 'apresentacao'\)\)/i);
  assert.match(sql, /check \(situacao in \('vigente', 'substituida', 'reaberta'\)\)/i);
  assert.match(sql, /unique \(demanda_id, versao\)/i);
  assert.match(sql, /unique index if not exists uq_dls_conclusoes_vigente[\s\S]*?where situacao = 'vigente'/i);
  assert.match(sql, /references public\.dls_demandas\(id\) on delete cascade/i);
});

test('itens de impugnação congelam valores e calculam diferenças no banco', () => {
  assert.match(sql, /create table if not exists public\.dls_demanda_impugnacao_itens/i);
  assert.match(sql, /valor_dls numeric\(15, 2\) not null/i);
  assert.match(sql, /valor_outra_parte numeric\(15, 2\) not null/i);
  assert.match(sql, /diferenca_assinada numeric\(16, 2\)[\s\S]*?generated always as \(round\(valor_dls - valor_outra_parte, 2\)\) stored/i);
  assert.match(sql, /diferenca_absoluta numeric\(16, 2\)[\s\S]*?generated always as \(abs\(round\(valor_dls - valor_outra_parte, 2\)\)\) stored/i);
  assert.match(sql, /direcao text[\s\S]*?DLS maior[\s\S]*?Outra parte maior[\s\S]*?Valores iguais/i);
  assert.match(sql, /foreign key \(conclusao_id, demanda_id\)[\s\S]*?references public\.dls_demanda_conclusoes \(id, demanda_id\)[\s\S]*?on delete cascade/i);
  assert.match(sql, /foreign key \(calculo_id, demanda_id\)[\s\S]*?references public\.dls_demanda_calculos \(id, demanda_id\)[\s\S]*?on delete restrict/i);
  assert.match(sql, /foreign key \(reclamante_id, demanda_id\)[\s\S]*?references public\.dls_demanda_reclamantes \(id, demanda_id\)[\s\S]*?on delete restrict/i);
  assert.doesNotMatch(sql, /\bvalor_total\b/i);
  assert.doesNotMatch(sql, /\btotal_impugnacao\b/i);
});

test('histórico e conclusão não podem ser alterados fora das RPCs auditadas', () => {
  assert.match(sql, /dls\.conclusao_auditada/i);
  assert.match(sql, /Conclusão histórica só pode ser criada pelas RPCs auditadas/i);
  assert.match(sql, /Conclusão histórica é imutável\. Use as RPCs auditadas/i);
  assert.match(sql, /Conclusão histórica não pode ser excluída diretamente/i);
  assert.match(sql, /Comparação de impugnação só pode ser criada pelas RPCs auditadas/i);
  assert.match(sql, /Comparação de impugnação é imutável/i);
  assert.match(sql, /Comparação de impugnação não pode ser excluída diretamente/i);
  assert.match(sql, /before insert or update or delete on public\.dls_demanda_conclusoes/i);
  assert.match(sql, /before insert or update or delete on public\.dls_demanda_impugnacao_itens/i);
  assert.match(sql, /before insert or update of status on public\.dls_demandas/i);
  assert.match(sql, /Transição de\/para entregue exige as RPCs auditadas/i);
  assert.match(sql, /if tg_op = 'INSERT'[\s\S]*?new\.status = 'entregue'[\s\S]*?raise exception/i);
  assert.match(sql, /new\.status = 'entregue'\s*and not exists \(\s*select 1 from public\.dls_demandas/i);
  assert.match(sql, /Inserir uma demanda nova já entregue permanece proibido/i);
});

test('RPC de conclusão valida cálculos, classificação e snapshots e grava a data oficial', () => {
  const fn = functionBody('dls_concluir_demanda');
  assert.match(fn, /p_demanda_id text[\s\S]*?p_tipo_conclusao text[\s\S]*?p_impugnacoes jsonb[\s\S]*?p_observacao text[\s\S]*?p_usuario text/i);
  assert.match(fn, /pg_advisory_xact_lock\(hashtext\('dls_demanda:' \|\| p_demanda_id\)\)/i);
  assert.match(fn, /for update/i);
  assert.match(fn, /count\(\*\)[\s\S]*?status not in \('entregue', 'cancelada'\)/i);
  assert.match(fn, /when 'impugnacao' then 'impugnacao'[\s\S]*?when 'concordancia'[\s\S]*?when 'atualizacao'[\s\S]*?when 'apresentacao'/i);
  assert.match(fn, /Conclusão por Impugnação exige ao menos uma comparação financeira/i);
  assert.match(fn, /Comparações financeiras só são permitidas em conclusão por Impugnação/i);
  assert.match(fn, /set status = 'entregue',\s*concluida_em = now\(\)/i);
  assert.match(fn, /set situacao = 'substituida'/i);
  assert.match(fn, /coalesce\(max\(versao\), 0\) \+ 1/i);
  assert.match(fn, /tipo_calculo_snapshot/i);
  assert.match(fn, /reclamante_nome_snapshot/i);
  assert.match(fn, /calculo_status_snapshot/i);
  assert.match(fn, /round\(v_valor_dls, 2\)/i);
  assert.doesNotMatch(fn, /v_total/i);
});

test('RPC de status reabre conclusão e limpa a data oficial', () => {
  const fn = functionBody('dls_alterar_status_demanda');
  assert.match(fn, /p_demanda_id text[\s\S]*?p_novo_status text[\s\S]*?p_motivo text[\s\S]*?p_usuario text/i);
  assert.match(fn, /v_status not in \('triagem', 'pendente', 'andamento', 'revisao', 'aguardando', 'atrasada', 'cancelada'\)/i);
  assert.match(fn, /v_status = 'entregue'[\s\S]*?Use a RPC de conclusão classificada/i);
  assert.match(fn, /set status = v_status,\s*concluida_em = null/i);
  assert.match(fn, /if v_status_anterior = 'entregue'[\s\S]*?set situacao = 'reaberta'[\s\S]*?reaberta_em = now\(\)/i);
  assert.match(fn, /motivo_reabertura/i);
});

test('RPC de restauração distingue backup v5 de v6 e preserva data exata', () => {
  const fn = functionBody('dls_restaurar_conclusoes_demanda');
  assert.match(fn, /p_conclusoes jsonb[\s\S]*?p_itens jsonb[\s\S]*?p_status_original text[\s\S]*?p_usuario text[\s\S]*?p_concluida_em timestamptz/i);
  assert.match(fn, /p_conclusoes is null and p_itens is not null[\s\S]*?raise exception/i);
  assert.match(fn, /if p_conclusoes is not null then\s*delete from public\.dls_demanda_conclusoes/i);
  assert.match(fn, /p_conclusoes nulo significa/i);
  assert.match(fn, /situacao = 'reaberta'[\s\S]*?Restauração de backup anterior à v6/i);
  assert.match(fn, /set status = 'andamento',\s*concluida_em = null/i);
  assert.match(fn, /set status = 'entregue',\s*concluida_em = coalesce\(/i);
  assert.match(fn, /v_data_entrega/i);
  assert.match(fn, /situacao = 'vigente'[\s\S]*?limit 1/i);
  assert.match(fn, /v_conclusao_ref[\s\S]*?not \(v_conclusao_ref = any\(v_conclusao_ids\)\)/i);
});

test('exclusão completa remove v6 antes das tabelas v5 e usa transação/lock', () => {
  const fn = functionBody('dls_excluir_demanda_completa');
  assert.match(fn, /pg_advisory_xact_lock/i);
  assert.match(fn, /for update/i);
  assert.match(fn, /perform set_config\('dls\.conclusao_auditada', 'on', true\)/i);
  const itens = fn.indexOf('delete from public.dls_demanda_impugnacao_itens');
  const conclusoes = fn.indexOf('delete from public.dls_demanda_conclusoes');
  const calculos = fn.indexOf('delete from public.dls_demanda_calculos');
  const reclamantes = fn.indexOf('delete from public.dls_demanda_reclamantes');
  const equipe = fn.indexOf('delete from public.dls_demanda_responsaveis');
  const demandas = fn.indexOf('delete from public.dls_demandas');
  assert.ok(itens >= 0 && conclusoes > itens && calculos > conclusoes && reclamantes > calculos && equipe > reclamantes && demandas > equipe);
  const deleteDemandas = sql.match(/delete\s+from\s+public\.dls_demandas\b/gi) || [];
  assert.equal(deleteDemandas.length, 1, 'nenhuma exclusão de demanda fora da RPC');
});

test('RLS, grants e RPCs SECURITY INVOKER mantêm o modelo de acesso da v5', () => {
  assert.match(sql, /alter table public\.dls_demanda_conclusoes enable row level security/i);
  assert.match(sql, /alter table public\.dls_demanda_impugnacao_itens enable row level security/i);
  assert.match(sql, /create policy dls_conclusoes_browser_all[\s\S]*?to anon, authenticated using \(true\) with check \(true\)/i);
  assert.match(sql, /create policy dls_impugnacoes_browser_all[\s\S]*?to anon, authenticated using \(true\) with check \(true\)/i);
  assert.match(sql, /grant select, insert, update, delete on[\s\S]*?public\.dls_demanda_conclusoes,[\s\S]*?public\.dls_demanda_impugnacao_itens[\s\S]*?to anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.dls_concluir_demanda\(text, text, jsonb, text, text\) to anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.dls_alterar_status_demanda\(text, text, text, text\) to anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.dls_restaurar_conclusoes_demanda\(text, jsonb, jsonb, text, text, timestamptz\) to anon, authenticated/i);
  const invoker = (sql.match(/security invoker/gi) || []).length;
  assert.ok(invoker >= 4, 'RPCs de conclusão, status, restauração e exclusão devem usar SECURITY INVOKER');
  assert.doesNotMatch(sql, /security definer/i);
});
