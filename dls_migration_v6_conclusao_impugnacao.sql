-- ============================================================
-- DLS — Migração v6: conclusão classificada da demanda,
-- histórico versionado e comparações de impugnação.
--
-- CARACTERÍSTICAS
--   * Aditiva e idempotente: pode ser executada mais de uma vez.
--   * Não remove, renomeia, trunca ou apaga dados existentes.
--   * Reutiliza dls_demandas.concluida_em e não cria armazenamento
--     paralelo para a data oficial de entrega.
--   * Mantém o modelo v5 (reclamantes, cálculos, equipe e crédito).
--   * RPCs transacionais SECURITY INVOKER e triggers de proteção.
--   * RLS no mesmo modelo da v5 (limitação de identidade documentada).
--
-- PRÉ-REQUISITOS
--   * dls_migration_v5_demandas_coletivas.sql aplicada.
--   * Coluna dls_demandas.concluida_em criada por
--     dls_calculistas_metricas.sql ou pela v5.
--
-- Execute em homologação primeiro. Não execute em produção sem
-- backup e autorização expressa.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Normalização dos tipos de cálculo
-- ------------------------------------------------------------
-- Corrige apenas valores equivalentes. Tipos personalizados e
-- origem_calculo (ente) não são alterados.
do $$
declare
  v_count integer;
begin
  update public.dls_demandas
     set tipo = 'Cálculo Cível'
   where translate(lower(btrim(tipo)), 'áàâãéêíóôõúüç', 'aaaaeeiooouuc')
         in ('calculo civil', 'calculo civel');
  get diagnostics v_count = row_count;
  raise notice '[DLS v6] dls_demandas: % linha(s) normalizada(s) para Cálculo Cível.', v_count;
end $$;

do $$
declare
  v_count integer;
begin
  update public.dls_demandas
     set tipo = 'E-Social'
   where translate(lower(btrim(tipo)), 'áàâãéêíóôõúüç', 'aaaaeeiooouuc')
         in ('e-social', 'e social', 'esocial', 'e_social');
  get diagnostics v_count = row_count;
  raise notice '[DLS v6] dls_demandas: % linha(s) normalizada(s) para E-Social.', v_count;
end $$;

do $$
declare
  v_count integer;
begin
  update public.dls_demanda_calculos
     set tipo = 'Cálculo Cível'
   where translate(lower(btrim(tipo)), 'áàâãéêíóôõúüç', 'aaaaeeiooouuc')
         in ('calculo civil', 'calculo civel');
  get diagnostics v_count = row_count;
  raise notice '[DLS v6] dls_demanda_calculos: % linha(s) normalizada(s) para Cálculo Cível.', v_count;
end $$;

do $$
declare
  v_count integer;
begin
  update public.dls_demanda_calculos
     set tipo = 'E-Social'
   where translate(lower(btrim(tipo)), 'áàâãéêíóôõúüç', 'aaaaeeiooouuc')
         in ('e-social', 'e social', 'esocial', 'e_social');
  get diagnostics v_count = row_count;
  raise notice '[DLS v6] dls_demanda_calculos: % linha(s) normalizada(s) para E-Social.', v_count;
end $$;

create or replace function public.dls_normalizar_tipo_calculo()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key text;
begin
  v_key := translate(lower(btrim(coalesce(new.tipo, ''))), 'áàâãéêíóôõúüç', 'aaaaeeiooouuc');
  if v_key in ('calculo civil', 'calculo civel') then
    new.tipo := 'Cálculo Cível';
  elsif v_key in ('e-social', 'e social', 'esocial', 'e_social') then
    new.tipo := 'E-Social';
  end if;
  return new;
end;
$$;

drop trigger if exists dls_demandas_normalizar_tipo on public.dls_demandas;
create trigger dls_demandas_normalizar_tipo
before insert or update of tipo on public.dls_demandas
for each row execute function public.dls_normalizar_tipo_calculo();

drop trigger if exists dls_calculos_normalizar_tipo on public.dls_demanda_calculos;
create trigger dls_calculos_normalizar_tipo
before insert or update of tipo on public.dls_demanda_calculos
for each row execute function public.dls_normalizar_tipo_calculo();

-- ------------------------------------------------------------
-- 2. Índices/constraints necessários para FKs compostas
-- ------------------------------------------------------------
create unique index if not exists uq_dls_calculos_id_demanda
  on public.dls_demanda_calculos (id, demanda_id);

-- ------------------------------------------------------------
-- 3. Conclusões versionadas da demanda
-- ------------------------------------------------------------
create table if not exists public.dls_demanda_conclusoes (
  id text primary key,
  demanda_id text not null references public.dls_demandas(id) on delete cascade,
  tipo_conclusao text not null,
  situacao text not null default 'vigente',
  versao integer not null,
  concluida_em timestamptz not null,
  registrado_por text not null,
  observacao text,
  demanda_numero_snapshot text,
  cliente_nome_snapshot text,
  modalidade_snapshot text,
  reaberta_em timestamptz,
  reaberta_por text,
  motivo_reabertura text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dls_conclusoes_tipo_chk
    check (tipo_conclusao in ('impugnacao', 'concordancia', 'atualizacao', 'apresentacao')),
  constraint dls_conclusoes_situacao_chk
    check (situacao in ('vigente', 'substituida', 'reaberta')),
  constraint dls_conclusoes_versao_chk check (versao > 0),
  constraint dls_conclusoes_modalidade_chk
    check (modalidade_snapshot is null or modalidade_snapshot in ('individual', 'coletiva')),
  constraint dls_conclusoes_id_demanda_uq unique (id, demanda_id),
  constraint dls_conclusoes_demanda_versao_uq unique (demanda_id, versao)
);

create index if not exists idx_dls_conclusoes_demanda
  on public.dls_demanda_conclusoes (demanda_id, versao desc);
create index if not exists idx_dls_conclusoes_data
  on public.dls_demanda_conclusoes (concluida_em, tipo_conclusao);
create unique index if not exists uq_dls_conclusoes_vigente
  on public.dls_demanda_conclusoes (demanda_id)
  where situacao = 'vigente';

comment on table public.dls_demanda_conclusoes is
  'Versões históricas da conclusão da demanda. No máximo uma vigente por demanda.';
comment on column public.dls_demanda_conclusoes.situacao is
  'vigente: classificação atual; substituida: versão anterior; reaberta: versão cuja entrega foi reaberta.';
comment on column public.dls_demanda_conclusoes.concluida_em is
  'Data/hora histórica da entrega naquela versão. Não substitui dls_demandas.concluida_em da versão atual.';

-- ------------------------------------------------------------
-- 4. Itens de comparação da impugnação
-- ------------------------------------------------------------
create table if not exists public.dls_demanda_impugnacao_itens (
  id text primary key,
  conclusao_id text not null,
  demanda_id text not null,
  calculo_id text,
  reclamante_id text,
  escopo text not null default 'calculo_individual',
  descricao text,
  tipo_calculo_snapshot text,
  reclamante_nome_snapshot text,
  calculo_status_snapshot text,
  valor_dls numeric(15, 2) not null,
  valor_outra_parte numeric(15, 2) not null,
  diferenca_assinada numeric(16, 2)
    generated always as (round(valor_dls - valor_outra_parte, 2)) stored,
  diferenca_absoluta numeric(16, 2)
    generated always as (abs(round(valor_dls - valor_outra_parte, 2))) stored,
  direcao text
    generated always as (
      case
        when round(valor_dls - valor_outra_parte, 2) > 0 then 'DLS maior'
        when round(valor_dls - valor_outra_parte, 2) < 0 then 'Outra parte maior'
        else 'Valores iguais'
      end
    ) stored,
  observacao text,
  created_at timestamptz not null default now(),
  constraint dls_impugnacoes_valor_dls_chk
    check (valor_dls between -9999999999999.99 and 9999999999999.99),
  constraint dls_impugnacoes_valor_outra_chk
    check (valor_outra_parte between -9999999999999.99 and 9999999999999.99),
  constraint dls_impugnacoes_escopo_chk
    check (escopo in ('calculo_individual', 'coletivo_geral')),
  constraint dls_impugnacoes_vinculo_chk
    check (
      (escopo = 'calculo_individual' and calculo_id is not null)
      or
      (escopo = 'coletivo_geral' and calculo_id is null and reclamante_id is null)
    ),
  constraint dls_impugnacoes_descricao_chk
    check (descricao is null or length(descricao) <= 500),
  constraint dls_impugnacoes_observacao_chk
    check (observacao is null or length(observacao) <= 1000),
  constraint dls_impugnacoes_conclusao_fk
    foreign key (conclusao_id, demanda_id)
    references public.dls_demanda_conclusoes (id, demanda_id)
    on delete cascade,
  constraint dls_impugnacoes_calculo_fk
    foreign key (calculo_id, demanda_id)
    references public.dls_demanda_calculos (id, demanda_id)
    on delete restrict,
  constraint dls_impugnacoes_reclamante_fk
    foreign key (reclamante_id, demanda_id)
    references public.dls_demanda_reclamantes (id, demanda_id)
    on delete restrict
);

create index if not exists idx_dls_impugnacoes_conclusao
  on public.dls_demanda_impugnacao_itens (conclusao_id, created_at, id);
create index if not exists idx_dls_impugnacoes_demanda
  on public.dls_demanda_impugnacao_itens (demanda_id, created_at);
create index if not exists idx_dls_impugnacoes_calculo
  on public.dls_demanda_impugnacao_itens (calculo_id);

comment on table public.dls_demanda_impugnacao_itens is
  'Comparações financeiras congeladas de uma versão de conclusão por impugnação.';
comment on column public.dls_demanda_impugnacao_itens.diferenca_assinada is
  'Diferença calculada pelo banco (DLS - outra parte). Não é aceita do cliente.';
comment on column public.dls_demanda_impugnacao_itens.tipo_calculo_snapshot is
  'Tipo do cálculo no momento da conclusão; preservado mesmo se o cálculo mudar depois.';

-- ------------------------------------------------------------
-- 5. Proteção de histórico e consistência
-- ------------------------------------------------------------
create or replace function public.dls_validar_transicao_demanda_conclusao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('dls.conclusao_auditada', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- O RPC dls_salvar_demanda_coletiva usa INSERT ... ON CONFLICT DO UPDATE.
    -- O gatilho BEFORE INSERT também roda nesse upsert, antes da resolução do
    -- conflito. Permitir a entrega aqui somente quando a demanda já existe;
    -- a atualização seguinte continua validada pelo gatilho BEFORE UPDATE.
    -- Inserir uma demanda nova já entregue permanece proibido.
    if new.status = 'entregue'
       and not exists (
         select 1 from public.dls_demandas d where d.id = new.id
       ) then
      raise exception 'Entrega de demanda exige a RPC de conclusão classificada.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and (new.status = 'entregue' or old.status = 'entregue') then
    raise exception 'Transição de/para entregue exige as RPCs auditadas de conclusão/reabertura.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dls_demandas_validar_transicao_conclusao on public.dls_demandas;
create trigger dls_demandas_validar_transicao_conclusao
before insert or update of status on public.dls_demandas
for each row execute function public.dls_validar_transicao_demanda_conclusao();

create or replace function public.dls_proteger_conclusao()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('dls.conclusao_auditada', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'Conclusão histórica só pode ser criada pelas RPCs auditadas.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'Conclusão histórica é imutável. Use as RPCs auditadas.' using errcode = '42501';
  end if;

  -- Exclusão direta é bloqueada enquanto a demanda ainda existe. A exclusão
  -- da demanda inteira continua permitida e remove o histórico em cascata.
  if exists (select 1 from public.dls_demandas d where d.id = old.demanda_id) then
    raise exception 'Conclusão histórica não pode ser excluída diretamente.' using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists dls_conclusoes_proteger on public.dls_demanda_conclusoes;
create trigger dls_conclusoes_proteger
before insert or update or delete on public.dls_demanda_conclusoes
for each row execute function public.dls_proteger_conclusao();

create or replace function public.dls_proteger_impugnacao_item()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('dls.conclusao_auditada', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Comparação de impugnação só pode ser criada pelas RPCs auditadas.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Comparação de impugnação é imutável. Use a restauração auditada.' using errcode = '42501';
  end if;
  if exists (select 1 from public.dls_demanda_conclusoes c where c.id = old.conclusao_id) then
    raise exception 'Comparação de impugnação não pode ser excluída diretamente.' using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists dls_impugnacoes_proteger on public.dls_demanda_impugnacao_itens;
create trigger dls_impugnacoes_proteger
before insert or update or delete on public.dls_demanda_impugnacao_itens
for each row execute function public.dls_proteger_impugnacao_item();

create or replace function public.dls_validar_impugnacao_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conclusao_demanda text;
  v_calc public.dls_demanda_calculos%rowtype;
  v_reclamante_nome text;
begin
  select c.demanda_id into v_conclusao_demanda
    from public.dls_demanda_conclusoes c
   where c.id = new.conclusao_id;

  if v_conclusao_demanda is null then
    raise exception 'Conclusão vinculada à comparação não existe.' using errcode = '23503';
  end if;

  if new.demanda_id is null then
    new.demanda_id := v_conclusao_demanda;
  elsif new.demanda_id is distinct from v_conclusao_demanda then
    raise exception 'Comparação deve pertencer à mesma demanda da conclusão.' using errcode = '23514';
  end if;

  new.escopo := lower(btrim(coalesce(new.escopo, 'calculo_individual')));
  if new.escopo in ('coletivo', 'geral', 'coletivo_geral') then
    new.escopo := 'coletivo_geral';
  elsif new.escopo not in ('calculo_individual', 'coletivo_geral') then
    raise exception 'Escopo de comparação inválido.' using errcode = '23514';
  end if;

  if new.valor_dls is null or new.valor_outra_parte is null then
    raise exception 'Comparação exige valor da DLS e valor da outra parte.' using errcode = '23514';
  end if;
  new.valor_dls := round(new.valor_dls, 2);
  new.valor_outra_parte := round(new.valor_outra_parte, 2);

  if new.escopo = 'calculo_individual' then
    if new.calculo_id is null then
      raise exception 'Comparação de cálculo individual exige cálculo vinculado.' using errcode = '23514';
    end if;

    select * into v_calc
      from public.dls_demanda_calculos c
     where c.id = new.calculo_id
       and c.demanda_id = new.demanda_id;
    if not found then
      raise exception 'Cálculo da comparação não pertence a esta demanda.' using errcode = '23503';
    end if;

    if v_calc.reclamante_id is not null then
      if new.reclamante_id is not null
         and new.reclamante_id is distinct from v_calc.reclamante_id then
        raise exception 'Reclamante da comparação não corresponde ao cálculo.' using errcode = '23514';
      end if;
      new.reclamante_id := v_calc.reclamante_id;
      select r.nome into v_reclamante_nome
        from public.dls_demanda_reclamantes r
       where r.id = new.reclamante_id
         and r.demanda_id = new.demanda_id;
    else
      if new.reclamante_id is not null then
        raise exception 'Cálculo coletivo não pode ser vinculado a reclamante individual.' using errcode = '23514';
      end if;
      v_reclamante_nome := null;
    end if;

    new.tipo_calculo_snapshot := coalesce(
      nullif(btrim(coalesce(new.tipo_calculo_snapshot, '')), ''),
      v_calc.tipo
    );
    new.calculo_status_snapshot := coalesce(
      nullif(btrim(coalesce(new.calculo_status_snapshot, '')), ''),
      v_calc.status
    );
    new.reclamante_nome_snapshot := coalesce(
      nullif(btrim(coalesce(new.reclamante_nome_snapshot, '')), ''),
      v_reclamante_nome
    );
    if nullif(btrim(coalesce(new.descricao, '')), '') is null then
      new.descricao := v_calc.tipo
        || case when v_reclamante_nome is not null then ' — ' || v_reclamante_nome
                else ' — escopo coletivo' end;
    end if;
  else
    if new.calculo_id is not null or new.reclamante_id is not null then
      raise exception 'Comparação coletiva geral não aceita cálculo/reclamante individual.' using errcode = '23514';
    end if;
    new.tipo_calculo_snapshot := null;
    new.reclamante_nome_snapshot := null;
    new.calculo_status_snapshot := null;
    if nullif(btrim(coalesce(new.descricao, '')), '') is null then
      new.descricao := 'Comparação coletiva geral';
    end if;
  end if;

  new.descricao := btrim(coalesce(new.descricao, ''));
  new.observacao := nullif(btrim(coalesce(new.observacao, '')), '');
  return new;
end;
$$;

drop trigger if exists dls_impugnacoes_validar on public.dls_demanda_impugnacao_itens;
create trigger dls_impugnacoes_validar
before insert or update on public.dls_demanda_impugnacao_itens
for each row execute function public.dls_validar_impugnacao_item();

drop trigger if exists dls_conclusoes_set_updated_at on public.dls_demanda_conclusoes;
create trigger dls_conclusoes_set_updated_at
before update on public.dls_demanda_conclusoes
for each row execute function public.dls_set_updated_at();

-- ------------------------------------------------------------
-- 6. RPC: concluir demanda com classificação
-- ------------------------------------------------------------
create or replace function public.dls_concluir_demanda(
  p_demanda_id text,
  p_tipo_conclusao text,
  p_impugnacoes jsonb default '[]'::jsonb,
  p_observacao text default '',
  p_usuario text default 'sistema'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_demanda record;
  v_tipo text;
  v_tipo_key text;
  v_tipo_label text;
  v_itens jsonb := coalesce(p_impugnacoes, '[]'::jsonb);
  v_item jsonb;
  v_versao integer;
  v_conclusao_id text;
  v_concluida_em timestamptz;
  v_usuario text;
  v_observacao text;
  v_escopo text;
  v_calculo_id text;
  v_reclamante_id text;
  v_descricao text;
  v_obs_item text;
  v_valor_dls numeric;
  v_valor_outra numeric;
  v_calc public.dls_demanda_calculos%rowtype;
  v_reclamante_nome text;
  v_tipo_snapshot text;
  v_status_snapshot text;
  v_abertos integer;
begin
  if nullif(btrim(coalesce(p_demanda_id, '')), '') is null then
    raise exception 'Demanda não informada.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_itens) <> 'array' then
    raise exception 'Comparações de impugnação devem ser uma lista.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_itens) > 200 then
    raise exception 'Limite de 200 comparações por conclusão excedido.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('dls_demanda:' || p_demanda_id));

  select d.*, c.nome as cliente_nome
    into v_demanda
    from public.dls_demandas d
    left join public.dls_clientes c on c.id = d.cliente_id
   where d.id = p_demanda_id
   for update of d;

  if not found then
    raise exception 'Demanda não encontrada.' using errcode = 'P0002';
  end if;
  if v_demanda.status = 'entregue' then
    raise exception 'Demanda já entregue. Reabra o status antes de registrar nova conclusão.' using errcode = '23514';
  end if;
  if v_demanda.status = 'cancelada' then
    raise exception 'Demanda cancelada não pode ser concluída.' using errcode = '23514';
  end if;

  select count(*) into v_abertos
    from public.dls_demanda_calculos c
   where c.demanda_id = p_demanda_id
     and c.ativo
     and c.status not in ('entregue', 'cancelada');
  if v_abertos > 0 then
    raise exception 'Existem % cálculo(s) em aberto. Conclua-os antes da entrega.', v_abertos using errcode = '23514';
  end if;

  v_tipo_key := translate(
    lower(btrim(coalesce(p_tipo_conclusao, ''))),
    'áàâãéêíóôõúüç',
    'aaaaeeiooouuc'
  );
  v_tipo := case v_tipo_key
    when 'impugnacao' then 'impugnacao'
    when 'concordancia' then 'concordancia'
    when 'atualizacao' then 'atualizacao'
    when 'apresentacao' then 'apresentacao'
    else null
  end;
  if v_tipo is null then
    raise exception 'Classificação de conclusão inválida.' using errcode = '22023';
  end if;
  v_tipo_label := case v_tipo
    when 'impugnacao' then 'Impugnação'
    when 'concordancia' then 'Concordância'
    when 'atualizacao' then 'Atualização'
    else 'Apresentação'
  end;

  if v_tipo = 'impugnacao' then
    if jsonb_array_length(v_itens) = 0 then
      raise exception 'Conclusão por Impugnação exige ao menos uma comparação financeira.' using errcode = '23514';
    end if;
  elsif jsonb_array_length(v_itens) > 0 then
    raise exception 'Comparações financeiras só são permitidas em conclusão por Impugnação.' using errcode = '23514';
  end if;

  v_usuario := coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'sistema');
  v_observacao := nullif(btrim(coalesce(p_observacao, '')), '');
  if v_observacao is not null and length(v_observacao) > 4000 then
    raise exception 'Observação da conclusão excede 4.000 caracteres.' using errcode = '22001';
  end if;

  -- Autoriza as alterações históricas somente dentro desta transação.
  perform set_config('dls.conclusao_auditada', 'on', true);

  update public.dls_demanda_conclusoes
     set situacao = 'substituida',
         updated_at = now()
   where demanda_id = p_demanda_id
     and situacao = 'vigente';

  select coalesce(max(versao), 0) + 1 into v_versao
    from public.dls_demanda_conclusoes
   where demanda_id = p_demanda_id;

  update public.dls_demandas
     set status = 'entregue',
         concluida_em = now(),
         historico = jsonb_build_array(jsonb_build_object(
           'data', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
           'texto', format(
             'Demanda concluída como %s%s',
             v_tipo_label,
             case when v_tipo = 'impugnacao'
                  then format(' com %s comparação(ões)', jsonb_array_length(v_itens))
                  else '' end
           ),
           'autor', v_usuario
         )) || coalesce(historico, '[]'::jsonb),
         updated_at = now()
   where id = p_demanda_id;

  select d.concluida_em into v_concluida_em
    from public.dls_demandas d
   where d.id = p_demanda_id;

  v_conclusao_id := 'CONC-' || replace(gen_random_uuid()::text, '-', '');

  insert into public.dls_demanda_conclusoes (
    id, demanda_id, tipo_conclusao, situacao, versao, concluida_em,
    registrado_por, observacao, demanda_numero_snapshot,
    cliente_nome_snapshot, modalidade_snapshot
  ) values (
    v_conclusao_id, p_demanda_id, v_tipo, 'vigente', v_versao,
    coalesce(v_concluida_em, now()), v_usuario, v_observacao,
    v_demanda.numero, v_demanda.cliente_nome, v_demanda.modalidade_demanda
  );

  if v_tipo = 'impugnacao' then
    for v_item in select value from jsonb_array_elements(v_itens)
    loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'Cada comparação de impugnação deve ser um objeto.' using errcode = '22023';
      end if;
      v_escopo := lower(btrim(coalesce(v_item->>'escopo', 'calculo_individual')));
      if v_escopo in ('coletivo', 'geral', 'coletivo_geral') then
        v_escopo := 'coletivo_geral';
      elsif v_escopo not in ('calculo_individual', 'coletivo_geral') then
        raise exception 'Escopo de comparação inválido.' using errcode = '23514';
      end if;
      v_calculo_id := nullif(btrim(coalesce(v_item->>'calculo_id', '')), '');
      v_reclamante_id := nullif(btrim(coalesce(v_item->>'reclamante_id', '')), '');
      v_descricao := btrim(coalesce(v_item->>'descricao', ''));
      v_obs_item := btrim(coalesce(v_item->>'observacao', ''));
      if length(v_descricao) > 500 then
        raise exception 'Descrição da comparação excede 500 caracteres.' using errcode = '22001';
      end if;
      if length(v_obs_item) > 1000 then
        raise exception 'Observação da comparação excede 1.000 caracteres.' using errcode = '22001';
      end if;
      if v_escopo = 'calculo_individual' and v_calculo_id is null then
        raise exception 'Comparação individual exige cálculo vinculado.' using errcode = '23514';
      end if;
      if v_escopo = 'coletivo_geral'
         and (v_calculo_id is not null or v_reclamante_id is not null) then
        raise exception 'Comparação coletiva geral não aceita cálculo/reclamante.' using errcode = '23514';
      end if;

      begin
        v_valor_dls := nullif(btrim(coalesce(v_item->>'valor_dls', '')), '')::numeric;
        v_valor_outra := nullif(btrim(coalesce(v_item->>'valor_outra_parte', '')), '')::numeric;
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'Valores da comparação não são numéricos válidos.' using errcode = '22023';
      end;
      if v_valor_dls is null or v_valor_outra is null then
        raise exception 'Comparação exige valor da DLS e valor da outra parte.' using errcode = '23514';
      end if;
      if abs(v_valor_dls) > 9999999999999.99 or abs(v_valor_outra) > 9999999999999.99 then
        raise exception 'Valor da comparação excede o limite permitido.' using errcode = '22003';
      end if;

      v_tipo_snapshot := null;
      v_status_snapshot := null;
      v_reclamante_nome := null;

      if v_escopo = 'calculo_individual' then
        select * into v_calc
          from public.dls_demanda_calculos c
         where c.id = v_calculo_id
           and c.demanda_id = p_demanda_id;
        if not found then
          raise exception 'Cálculo da comparação não pertence a esta demanda.' using errcode = '23503';
        end if;

        if v_calc.reclamante_id is not null then
          if v_reclamante_id is not null
             and v_reclamante_id is distinct from v_calc.reclamante_id then
            raise exception 'Reclamante da comparação não corresponde ao cálculo.' using errcode = '23514';
          end if;
          v_reclamante_id := v_calc.reclamante_id;
          select r.nome into v_reclamante_nome
            from public.dls_demanda_reclamantes r
           where r.id = v_reclamante_id
             and r.demanda_id = p_demanda_id;
          if v_reclamante_nome is null then
            raise exception 'Reclamante da comparação não pertence a esta demanda.' using errcode = '23503';
          end if;
        elsif v_reclamante_id is not null then
          raise exception 'Cálculo coletivo não pode ser vinculado a reclamante individual.' using errcode = '23514';
        end if;

        v_tipo_snapshot := v_calc.tipo;
        v_status_snapshot := v_calc.status;
        if v_descricao = '' then
          v_descricao := v_calc.tipo
            || case when v_reclamante_nome is not null then ' — ' || v_reclamante_nome
                    else ' — escopo coletivo' end;
        end if;
      else
        v_descricao := coalesce(nullif(v_descricao, ''), 'Comparação coletiva geral');
      end if;

      insert into public.dls_demanda_impugnacao_itens (
        id, conclusao_id, demanda_id, calculo_id, reclamante_id, escopo,
        descricao, tipo_calculo_snapshot, reclamante_nome_snapshot,
        calculo_status_snapshot, valor_dls, valor_outra_parte, observacao
      ) values (
        'IMP-' || replace(gen_random_uuid()::text, '-', ''),
        v_conclusao_id, p_demanda_id, v_calculo_id, v_reclamante_id, v_escopo,
        v_descricao, v_tipo_snapshot, v_reclamante_nome,
        v_status_snapshot, round(v_valor_dls, 2), round(v_valor_outra, 2),
        nullif(v_obs_item, '')
      );
    end loop;
  end if;

  return jsonb_build_object(
    'demanda_id', p_demanda_id,
    'demanda', (select to_jsonb(d) from public.dls_demandas d where d.id = p_demanda_id),
    'conclusao', (
      select to_jsonb(c) from public.dls_demanda_conclusoes c where c.id = v_conclusao_id
    ),
    'itens', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
        from public.dls_demanda_impugnacao_itens i
       where i.conclusao_id = v_conclusao_id
    ), '[]'::jsonb),
    'idempotente', false
  );
end;
$$;

comment on function public.dls_concluir_demanda(text, text, jsonb, text, text) is
  'Conclui a demanda com classificação, congela valores de impugnação e atualiza o status para entregue.';

-- ------------------------------------------------------------
-- 7. RPC: alterar status (reabertura preserva a classificação)
-- ------------------------------------------------------------
create or replace function public.dls_alterar_status_demanda(
  p_demanda_id text,
  p_novo_status text,
  p_motivo text default '',
  p_usuario text default 'sistema'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_demanda record;
  v_status text;
  v_status_anterior text;
  v_usuario text;
  v_motivo text;
  v_label text;
begin
  v_status := lower(btrim(coalesce(p_novo_status, '')));
  if v_status not in ('triagem', 'pendente', 'andamento', 'revisao', 'aguardando', 'atrasada', 'cancelada') then
    if v_status = 'entregue' then
      raise exception 'Use a RPC de conclusão classificada para entregar a demanda.' using errcode = '42501';
    end if;
    raise exception 'Status de demanda inválido.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_demanda_id, '')), '') is null then
    raise exception 'Demanda não informada.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('dls_demanda:' || p_demanda_id));

  select * into v_demanda
    from public.dls_demandas d
   where d.id = p_demanda_id
   for update;
  if not found then
    raise exception 'Demanda não encontrada.' using errcode = 'P0002';
  end if;

  v_status_anterior := v_demanda.status;
  if v_status_anterior = v_status then
    return jsonb_build_object(
      'demanda_id', p_demanda_id,
      'status', v_status,
      'status_anterior', v_status_anterior,
      'idempotente', true
    );
  end if;

  v_usuario := coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'sistema');
  v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');
  if v_motivo is not null and length(v_motivo) > 1000 then
    raise exception 'Motivo da alteração excede 1.000 caracteres.' using errcode = '22001';
  end if;
  v_label := case v_status
    when 'triagem' then 'Triagem'
    when 'pendente' then 'Pendente'
    when 'andamento' then 'Em Andamento'
    when 'revisao' then 'Em Revisão'
    when 'aguardando' then 'Aguardando Cliente'
    when 'atrasada' then 'Atrasada'
    else 'Cancelada'
  end;

  perform set_config('dls.conclusao_auditada', 'on', true);

  update public.dls_demandas
     set status = v_status,
         concluida_em = null,
         historico = jsonb_build_array(jsonb_build_object(
           'data', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
           'texto', format(
             'Status alterado de %s para %s%s',
             coalesce(v_status_anterior, '—'),
             v_label,
             case when v_motivo is not null then ' — motivo: ' || v_motivo else '' end
           ),
           'autor', v_usuario
         )) || coalesce(historico, '[]'::jsonb),
         updated_at = now()
   where id = p_demanda_id;

  if v_status_anterior = 'entregue' then
    update public.dls_demanda_conclusoes
       set situacao = 'reaberta',
           reaberta_em = now(),
           reaberta_por = v_usuario,
           motivo_reabertura = coalesce(v_motivo, 'Reabertura de status da demanda'),
           updated_at = now()
     where demanda_id = p_demanda_id
       and situacao = 'vigente';
  end if;

  return jsonb_build_object(
    'demanda_id', p_demanda_id,
    'status', v_status,
    'status_anterior', v_status_anterior,
    'idempotente', false,
    'demanda', (select to_jsonb(d) from public.dls_demandas d where d.id = p_demanda_id)
  );
end;
$$;

comment on function public.dls_alterar_status_demanda(text, text, text, text) is
  'Altera status com histórico e marca a conclusão vigente como reaberta ao sair de entregue.';

-- ------------------------------------------------------------
-- 8. RPC: restauração de conclusões pelo backup
-- ------------------------------------------------------------
create or replace function public.dls_restaurar_conclusoes_demanda(
  p_demanda_id text,
  p_conclusoes jsonb default '[]'::jsonb,
  p_itens jsonb default '[]'::jsonb,
  p_status_original text default null,
  p_usuario text default 'restauracao',
  p_concluida_em timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_demanda public.dls_demandas%rowtype;
  v_conclusao jsonb;
  v_item jsonb;
  v_conclusao_ids text[] := array[]::text[];
  v_conclusao_id text;
  v_tipo_key text;
  v_tipo text;
  v_situacao text;
  v_versao integer;
  v_concluida_em timestamptz;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_usuario text;
  v_status text;
  v_tem_vigente boolean;
  v_calc public.dls_demanda_calculos%rowtype;
  v_conclusao_ref text;
  v_concluida_em_atual timestamptz;
  v_data_entrega timestamptz;
begin
  if (p_conclusoes is not null and jsonb_typeof(p_conclusoes) <> 'array')
     or (p_itens is not null and jsonb_typeof(p_itens) <> 'array') then
    raise exception 'Conclusões e itens devem ser listas ou nulos.' using errcode = '22023';
  end if;
  if p_conclusoes is null and p_itens is not null then
    raise exception 'Itens não podem ser restaurados sem a lista de conclusões.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('dls_demanda:' || p_demanda_id));

  select * into v_demanda
    from public.dls_demandas d
   where d.id = p_demanda_id
   for update;
  if not found then
    raise exception 'Demanda não encontrada para restauração.' using errcode = 'P0002';
  end if;

  v_usuario := coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'restauracao');
  if p_status_original is not null then
    v_status := lower(btrim(p_status_original));
    if v_status not in ('triagem', 'pendente', 'andamento', 'revisao', 'aguardando', 'atrasada', 'entregue', 'cancelada') then
      raise exception 'Status original do backup inválido.' using errcode = '22023';
    end if;
  else
    v_status := v_demanda.status;
  end if;

  perform set_config('dls.conclusao_auditada', 'on', true);

  -- p_conclusoes nulo significa "backup anterior à v6": apenas restaura o
  -- status/data, sem apagar conclusões que já existam no banco.
  if p_conclusoes is not null then
    delete from public.dls_demanda_conclusoes
     where demanda_id = p_demanda_id;
  end if;

  for v_conclusao in select value from jsonb_array_elements(coalesce(p_conclusoes, '[]'::jsonb))
  loop
    if jsonb_typeof(v_conclusao) <> 'object' then
      raise exception 'Conclusão do backup inválida.' using errcode = '22023';
    end if;
    v_conclusao_id := nullif(btrim(coalesce(v_conclusao->>'id', '')), '');
    if v_conclusao_id is null then
      raise exception 'Conclusão do backup sem ID.' using errcode = '22023';
    end if;

    v_tipo_key := translate(
      lower(btrim(coalesce(v_conclusao->>'tipo_conclusao', v_conclusao->>'tipo', ''))),
      'áàâãéêíóôõúüç',
      'aaaaeeiooouuc'
    );
    v_tipo := case v_tipo_key
      when 'impugnacao' then 'impugnacao'
      when 'concordancia' then 'concordancia'
      when 'atualizacao' then 'atualizacao'
      when 'apresentacao' then 'apresentacao'
      else null
    end;
    if v_tipo is null then
      raise exception 'Tipo de conclusão inválido no backup: %', v_conclusao->>'tipo_conclusao' using errcode = '22023';
    end if;

    v_situacao := lower(btrim(coalesce(v_conclusao->>'situacao', 'vigente')));
    if v_situacao in ('substituido', 'substituída') then
      v_situacao := 'substituida';
    elsif v_situacao in ('reaberto', 'reaberta') then
      v_situacao := 'reaberta';
    end if;
    if v_situacao not in ('vigente', 'substituida', 'reaberta') then
      raise exception 'Situação de conclusão inválida no backup.' using errcode = '22023';
    end if;

    begin
      v_versao := coalesce(nullif(v_conclusao->>'versao', '')::integer, 1);
      v_concluida_em := coalesce(nullif(v_conclusao->>'concluida_em', '')::timestamptz, now());
      v_created_at := coalesce(nullif(v_conclusao->>'created_at', '')::timestamptz, now());
      v_updated_at := coalesce(nullif(v_conclusao->>'updated_at', '')::timestamptz, v_created_at);
    exception
      when invalid_text_representation or datetime_field_overflow then
        raise exception 'Datas/versão inválidas na conclusão do backup.' using errcode = '22023';
    end;

    insert into public.dls_demanda_conclusoes (
      id, demanda_id, tipo_conclusao, situacao, versao, concluida_em,
      registrado_por, observacao, demanda_numero_snapshot,
      cliente_nome_snapshot, modalidade_snapshot, reaberta_em,
      reaberta_por, motivo_reabertura, created_at, updated_at
    ) values (
      v_conclusao_id, p_demanda_id, v_tipo, v_situacao, v_versao,
      v_concluida_em,
      coalesce(nullif(btrim(coalesce(v_conclusao->>'registrado_por', '')), ''), v_usuario),
      nullif(btrim(coalesce(v_conclusao->>'observacao', '')), ''),
      nullif(btrim(coalesce(v_conclusao->>'demanda_numero_snapshot', '')), ''),
      nullif(btrim(coalesce(v_conclusao->>'cliente_nome_snapshot', '')), ''),
      nullif(btrim(coalesce(v_conclusao->>'modalidade_snapshot', '')), ''),
      nullif(v_conclusao->>'reaberta_em', '')::timestamptz,
      nullif(btrim(coalesce(v_conclusao->>'reaberta_por', '')), ''),
      nullif(btrim(coalesce(v_conclusao->>'motivo_reabertura', '')), ''),
      v_created_at, v_updated_at
    );
    v_conclusao_ids := array_append(v_conclusao_ids, v_conclusao_id);
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb))
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Item de impugnação do backup inválido.' using errcode = '22023';
    end if;
    v_conclusao_ref := nullif(btrim(coalesce(v_item->>'conclusao_id', '')), '');
    if v_conclusao_ref is null or not (v_conclusao_ref = any(v_conclusao_ids)) then
      raise exception 'Item de impugnação referencia conclusão ausente no backup.' using errcode = '23503';
    end if;
    v_conclusao_id := nullif(btrim(coalesce(v_item->>'id', '')), '');
    if v_conclusao_id is null then
      raise exception 'Item de impugnação do backup sem ID.' using errcode = '22023';
    end if;

    select * into v_calc
      from public.dls_demanda_calculos c
     where c.id = nullif(btrim(coalesce(v_item->>'calculo_id', '')), '')
       and c.demanda_id = p_demanda_id;
    if v_item->>'calculo_id' is not null and nullif(btrim(v_item->>'calculo_id'), '') is not null and not found then
      raise exception 'Cálculo do item de impugnação não pertence à demanda restaurada.' using errcode = '23503';
    end if;

    begin
      v_created_at := coalesce(nullif(v_item->>'created_at', '')::timestamptz, now());
    exception
      when invalid_text_representation or datetime_field_overflow then
        v_created_at := now();
    end;

    insert into public.dls_demanda_impugnacao_itens (
      id, conclusao_id, demanda_id, calculo_id, reclamante_id, escopo,
      descricao, tipo_calculo_snapshot, reclamante_nome_snapshot,
      calculo_status_snapshot, valor_dls, valor_outra_parte, observacao,
      created_at
    ) values (
      v_conclusao_id,
      v_conclusao_ref,
      p_demanda_id,
      nullif(btrim(coalesce(v_item->>'calculo_id', '')), ''),
      nullif(btrim(coalesce(v_item->>'reclamante_id', '')), ''),
      lower(btrim(coalesce(v_item->>'escopo', 'calculo_individual'))),
      nullif(btrim(coalesce(v_item->>'descricao', '')), ''),
      nullif(btrim(coalesce(v_item->>'tipo_calculo_snapshot', '')), ''),
      nullif(btrim(coalesce(v_item->>'reclamante_nome_snapshot', '')), ''),
      nullif(btrim(coalesce(v_item->>'calculo_status_snapshot', '')), ''),
      (v_item->>'valor_dls')::numeric,
      (v_item->>'valor_outra_parte')::numeric,
      nullif(btrim(coalesce(v_item->>'observacao', '')), ''),
      v_created_at
    );
  end loop;

  -- Backup v5 (sem lista de conclusões) importado em banco v6: se a demanda
  -- voltou a um status aberto, preserva a classificação existente como
  -- histórica em vez de deixar uma conclusão vigente inconsistente.
  if p_conclusoes is null and v_status <> 'entregue' then
    update public.dls_demanda_conclusoes
       set situacao = 'reaberta',
           reaberta_em = now(),
           reaberta_por = v_usuario,
           motivo_reabertura = 'Restauração de backup anterior à v6',
           updated_at = now()
     where demanda_id = p_demanda_id
       and situacao = 'vigente';
  end if;

  select exists (
    select 1 from public.dls_demanda_conclusoes c
     where c.demanda_id = p_demanda_id
       and c.situacao = 'vigente'
  ) into v_tem_vigente;

  if v_tem_vigente and v_status <> 'entregue' then
    raise exception 'Backup inconsistente: conclusão vigente com demanda não entregue.' using errcode = '23514';
  end if;

  select d.concluida_em into v_concluida_em_atual
    from public.dls_demandas d
   where d.id = p_demanda_id;

  v_data_entrega := p_concluida_em;
  if v_data_entrega is null and p_conclusoes is not null then
    select c.concluida_em into v_data_entrega
      from public.dls_demanda_conclusoes c
     where c.demanda_id = p_demanda_id
       and c.situacao = 'vigente'
     limit 1;
  end if;

  if v_status = 'entregue' then
    -- Passa por um estado aberto antes de reentregar para que o trigger
    -- aceite a data histórica exata do backup, e não apenas a data antiga.
    update public.dls_demandas
       set status = 'andamento',
           concluida_em = null,
           updated_at = now()
     where id = p_demanda_id;
    update public.dls_demandas
       set status = 'entregue',
           concluida_em = coalesce(
             v_data_entrega,
             v_concluida_em_atual,
             (select c.concluida_em
                from public.dls_demanda_conclusoes c
               where c.demanda_id = p_demanda_id
                 and c.situacao = 'vigente'
               limit 1),
             now()
           ),
           updated_at = now()
     where id = p_demanda_id;
  else
    update public.dls_demandas
       set status = v_status,
           concluida_em = null,
           updated_at = now()
     where id = p_demanda_id;
  end if;

  return jsonb_build_object(
    'demanda_id', p_demanda_id,
    'conclusoes', jsonb_array_length(coalesce(p_conclusoes, '[]'::jsonb)),
    'itens', jsonb_array_length(coalesce(p_itens, '[]'::jsonb)),
    'status', v_status,
    'idempotente', false
  );
end;
$$;

comment on function public.dls_restaurar_conclusoes_demanda(text, jsonb, jsonb, text, text, timestamptz) is
  'Restaura conclusões/itens de backup por demanda, preservando IDs, snapshots e datas. p_conclusoes nulo preserva as conclusões atuais.';

-- ------------------------------------------------------------
-- 9. Exclusão completa: mantém o contrato v5 e remove primeiro as
--    estruturas históricas da v6 dentro da transação auditada.
-- ------------------------------------------------------------
create or replace function public.dls_excluir_demanda_completa(p_demanda_id text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id text := btrim(coalesce(p_demanda_id, ''));
  v_numero text;
begin
  if v_id = '' then
    raise exception 'id da demanda é obrigatório.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('dls_demanda:' || v_id));
  select numero into v_numero
    from public.dls_demandas
   where id = v_id
   for update;
  if not found then
    return jsonb_build_object('demanda_id', v_id, 'excluida', false);
  end if;

  perform set_config('dls.conclusao_auditada', 'on', true);

  delete from public.dls_demanda_impugnacao_itens where demanda_id = v_id;
  delete from public.dls_demanda_conclusoes where demanda_id = v_id;
  delete from public.dls_demanda_calculos where demanda_id = v_id;
  delete from public.dls_demanda_reclamantes where demanda_id = v_id;
  delete from public.dls_demanda_responsaveis where demanda_id = v_id;
  delete from public.dls_demandas where id = v_id;

  return jsonb_build_object(
    'demanda_id', v_id,
    'numero', v_numero,
    'excluida', true
  );
end;
$$;

comment on function public.dls_excluir_demanda_completa(text) is
  'Exclui a demanda e todos os filhos v5/v6 em uma única transação, removendo o histórico de conclusão junto.';

-- ------------------------------------------------------------
-- 10. RLS e permissões (mesmo modelo da v5)
-- ------------------------------------------------------------
alter table public.dls_demanda_conclusoes enable row level security;
alter table public.dls_demanda_impugnacao_itens enable row level security;

drop policy if exists dls_conclusoes_browser_all on public.dls_demanda_conclusoes;
create policy dls_conclusoes_browser_all on public.dls_demanda_conclusoes
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_impugnacoes_browser_all on public.dls_demanda_impugnacao_itens;
create policy dls_impugnacoes_browser_all on public.dls_demanda_impugnacao_itens
for all to anon, authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.dls_demanda_conclusoes,
  public.dls_demanda_impugnacao_itens
to anon, authenticated;

grant execute on function public.dls_concluir_demanda(text, text, jsonb, text, text) to anon, authenticated;
grant execute on function public.dls_alterar_status_demanda(text, text, text, text) to anon, authenticated;
grant execute on function public.dls_restaurar_conclusoes_demanda(text, jsonb, jsonb, text, text, timestamptz) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
