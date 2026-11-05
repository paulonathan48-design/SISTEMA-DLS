-- ============================================================
-- DLS — Migração v5: demandas coletivas, múltiplos reclamantes,
-- múltiplos responsáveis e produtividade por cálculo.
--
-- CARACTERÍSTICAS
--   * Aditiva e idempotente: pode ser executada mais de uma vez.
--   * Não remove, renomeia, trunca ou apaga dados existentes.
--   * Backfill determinístico das linhas legadas (marcadas com legado_principal).
--   * Escritas do agregado por RPC transacional (SECURITY INVOKER).
--   * RLS habilitada nas novas tabelas; ver limitação de autenticação no README.
--
-- PRÉ-REQUISITOS CONFIRMADOS NO BANCO REAL
--   * dls_demandas.id e dls_calculistas.id são varchar(30)/text.
--   * dls_demandas já possui natureza, origem_calculo, allowed_user_ids,
--     procurador, chamado e concluida_em (migrações v2/v4 aplicadas).
--   * dls_demandas NÃO possui a coluna "valor"; por isso usamos valor_estimado.
--
-- Execute em ambiente de homologação primeiro. Não execute em produção
-- sem backup e autorização expressa.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Demanda principal: modalidade e honorários
-- ------------------------------------------------------------
alter table public.dls_demandas
  add column if not exists modalidade_demanda text;

alter table public.dls_demandas
  add column if not exists valor_estimado numeric(15, 2);

-- Garante a coluna de conclusão usada pelo restore de backup e pela view.
-- O trigger oficial é criado por dls_calculistas_metricas.sql.
alter table public.dls_demandas
  add column if not exists concluida_em timestamptz;

update public.dls_demandas
   set modalidade_demanda = 'individual'
 where modalidade_demanda is null
    or modalidade_demanda not in ('individual', 'coletiva');

alter table public.dls_demandas
  alter column modalidade_demanda set default 'individual',
  alter column modalidade_demanda set not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.dls_demandas'::regclass
       and conname = 'dls_demandas_modalidade_chk'
  ) then
    alter table public.dls_demandas
      add constraint dls_demandas_modalidade_chk
      check (modalidade_demanda in ('individual', 'coletiva'));
  end if;
end $$;

comment on column public.dls_demandas.modalidade_demanda is
  'Classificação explícita da demanda: individual ou coletiva (migração v5).';
comment on column public.dls_demandas.valor_estimado is
  'Honorários/valor estimado da demanda. Não representa o resultado de cálculo jurídico.';

-- ------------------------------------------------------------
-- 2. Reclamantes/beneficiários
-- ------------------------------------------------------------
create table if not exists public.dls_demanda_reclamantes (
  id text primary key,
  demanda_id text not null references public.dls_demandas(id) on delete cascade,
  nome text not null,
  observacoes text,
  ordem integer not null default 0,
  ativo boolean not null default true,
  legado_principal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dls_reclamantes_nome_chk check (length(btrim(nome)) > 0),
  constraint dls_reclamantes_id_demanda_uq unique (id, demanda_id)
);

create index if not exists idx_dls_reclamantes_demanda
  on public.dls_demanda_reclamantes (demanda_id, ativo, ordem);

create unique index if not exists uq_dls_reclamantes_legado_principal
  on public.dls_demanda_reclamantes (demanda_id)
  where legado_principal and ativo;

comment on table public.dls_demanda_reclamantes is
  'Pessoas/beneficiários vinculados a uma demanda. Inativação preserva histórico.';

-- ------------------------------------------------------------
-- 3. Cálculos jurídicos
-- ------------------------------------------------------------
create table if not exists public.dls_demanda_calculos (
  id text primary key,
  demanda_id text not null references public.dls_demandas(id) on delete cascade,
  reclamante_id text,
  escopo text not null default 'individual',
  tipo text not null,
  origem_calculo text,
  calculista_executor_id text references public.dls_calculistas(id) on delete set null,
  prazo date,
  status text not null default 'pendente',
  valor_resultado numeric(15, 2),
  observacoes text,
  ordem integer not null default 0,
  ativo boolean not null default true,
  legado_principal boolean not null default false,
  legado_sem_reclamante boolean not null default false,
  credito_legado_presumido boolean not null default false,
  concluido_por_calculista_id text references public.dls_calculistas(id) on delete set null,
  concluido_em timestamptz,
  origem_registro text not null default 'novo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dls_calculos_tipo_chk check (length(btrim(tipo)) > 0),
  constraint dls_calculos_escopo_chk check (escopo in ('individual', 'coletivo')),
  constraint dls_calculos_status_chk check (status in ('pendente', 'andamento', 'revisao', 'aguardando', 'entregue', 'cancelada')),
  constraint dls_calculos_origem_chk check (origem_registro in ('legado', 'novo')),
  constraint dls_calculos_escopo_coletivo_chk check (escopo <> 'coletivo' or reclamante_id is null),
  constraint dls_calculos_conclusao_chk check (
    (status = 'entregue' and (concluido_em is not null or origem_registro = 'legado'))
    or
    (status <> 'entregue' and concluido_por_calculista_id is null and concluido_em is null)
  ),
  -- A FK composta garante que o reclamante pertence à MESMA demanda.
  constraint dls_calculos_reclamante_mesma_demanda_fk
    foreign key (reclamante_id, demanda_id)
    references public.dls_demanda_reclamantes (id, demanda_id)
    on delete restrict
);

-- Preservação do histórico: excluir um reclamante não pode apagar em cascata
-- os cálculos já registrados. A inativação é o caminho normal. A remoção da
-- demanda inteira continua permitida pela RPC transacional abaixo.
alter table public.dls_demanda_calculos
  drop constraint if exists dls_calculos_reclamante_mesma_demanda_fk;
alter table public.dls_demanda_calculos
  add constraint dls_calculos_reclamante_mesma_demanda_fk
  foreign key (reclamante_id, demanda_id)
  references public.dls_demanda_reclamantes (id, demanda_id)
  on delete restrict;

create index if not exists idx_dls_calculos_demanda
  on public.dls_demanda_calculos (demanda_id, ativo, ordem);
create index if not exists idx_dls_calculos_reclamante
  on public.dls_demanda_calculos (reclamante_id);
create index if not exists idx_dls_calculos_executor
  on public.dls_demanda_calculos (calculista_executor_id, status);
create index if not exists idx_dls_calculos_credito
  on public.dls_demanda_calculos (concluido_por_calculista_id, concluido_em);

create unique index if not exists uq_dls_calculos_legado_principal
  on public.dls_demanda_calculos (demanda_id)
  where legado_principal and ativo;

comment on table public.dls_demanda_calculos is
  'Unidade de trabalho contável. Cada linha tem um executor e, quando concluída, um crédito congelado.';
comment on column public.dls_demanda_calculos.escopo is
  'individual exige reclamante em demanda coletiva; coletivo exige reclamante nulo.';
comment on column public.dls_demanda_calculos.concluido_por_calculista_id is
  'Crédito oficial de execução. Alterações somente por RPC auditada.';
comment on column public.dls_demanda_calculos.credito_legado_presumido is
  'true quando o crédito histórico foi preenchido a partir de dls_demandas.responsavel_id na migração.';

-- ------------------------------------------------------------
-- 4. Equipe responsável (calculistas)
-- ------------------------------------------------------------
create table if not exists public.dls_demanda_responsaveis (
  id text primary key,
  demanda_id text not null references public.dls_demandas(id) on delete cascade,
  calculista_id text not null references public.dls_calculistas(id) on delete cascade,
  papel text not null default 'co_responsavel',
  ativo boolean not null default true,
  atribuido_por text,
  atribuido_em timestamptz not null default now(),
  removido_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dls_responsaveis_papel_chk check (papel in ('principal', 'co_responsavel'))
);

create index if not exists idx_dls_responsaveis_demanda
  on public.dls_demanda_responsaveis (demanda_id, ativo);
create index if not exists idx_dls_responsaveis_calculista
  on public.dls_demanda_responsaveis (calculista_id, ativo);

create unique index if not exists uq_dls_responsaveis_par_ativo
  on public.dls_demanda_responsaveis (demanda_id, calculista_id)
  where ativo;
create unique index if not exists uq_dls_responsaveis_principal_ativo
  on public.dls_demanda_responsaveis (demanda_id)
  where ativo and papel = 'principal';

comment on table public.dls_demanda_responsaveis is
  'Equipe de calculistas da demanda. Não confundir com allowed_user_ids, que controla acesso de perfis.';

-- Preservação do histórico: calculistas referenciados por equipe, execução ou
-- crédito não podem ser apagados. O cadastro pode ser desativado (status offline).
-- Recria também as FKs de instalações que executaram uma versão anterior desta migração.
alter table public.dls_demanda_calculos
  drop constraint if exists dls_demanda_calculos_calculista_executor_id_fkey,
  drop constraint if exists dls_demanda_calculos_concluido_por_calculista_id_fkey,
  drop constraint if exists dls_calculos_executor_fk,
  drop constraint if exists dls_calculos_credito_fk;
alter table public.dls_demanda_calculos
  add constraint dls_calculos_executor_fk
  foreign key (calculista_executor_id) references public.dls_calculistas(id) on delete restrict;
alter table public.dls_demanda_calculos
  add constraint dls_calculos_credito_fk
  foreign key (concluido_por_calculista_id) references public.dls_calculistas(id) on delete restrict;

alter table public.dls_demanda_responsaveis
  drop constraint if exists dls_demanda_responsaveis_calculista_id_fkey,
  drop constraint if exists dls_responsaveis_calculista_fk;
alter table public.dls_demanda_responsaveis
  add constraint dls_responsaveis_calculista_fk
  foreign key (calculista_id) references public.dls_calculistas(id) on delete restrict;

-- ------------------------------------------------------------
-- 5. Triggers de updated_at e validações
-- ------------------------------------------------------------
create or replace function public.dls_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dls_reclamantes_set_updated_at on public.dls_demanda_reclamantes;
create trigger dls_reclamantes_set_updated_at
before update on public.dls_demanda_reclamantes
for each row execute function public.dls_set_updated_at();

drop trigger if exists dls_calculos_set_updated_at on public.dls_demanda_calculos;
create trigger dls_calculos_set_updated_at
before update on public.dls_demanda_calculos
for each row execute function public.dls_set_updated_at();

drop trigger if exists dls_responsaveis_set_updated_at on public.dls_demanda_responsaveis;
create trigger dls_responsaveis_set_updated_at
before update on public.dls_demanda_responsaveis
for each row execute function public.dls_set_updated_at();

create or replace function public.dls_validar_calculo()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_modalidade text;
begin
  if new.escopo = 'coletivo' and new.reclamante_id is not null then
    raise exception 'Cálculo de escopo coletivo não pode ter reclamante.' using errcode = '23514';
  end if;

  if new.escopo = 'individual' and new.reclamante_id is null then
    select modalidade_demanda into v_modalidade
      from public.dls_demandas
     where id = new.demanda_id;
    if v_modalidade = 'coletiva' and not coalesce(new.legado_sem_reclamante, false) then
      raise exception 'Cálculo individual de demanda coletiva exige reclamante.' using errcode = '23514';
    end if;
  end if;

  if new.ativo
     and new.calculista_executor_id is null
     and coalesce(new.origem_registro, 'novo') <> 'legado' then
    raise exception 'Cálculo novo ativo exige calculista executor.' using errcode = '23514';
  end if;

  if new.status = 'entregue'
     and coalesce(new.origem_registro, 'novo') <> 'legado'
     and (new.concluido_por_calculista_id is null or new.concluido_em is null) then
    raise exception 'Conclusão de cálculo novo exige calculista creditado e data.' using errcode = '23514';
  end if;

  if new.status <> 'entregue'
     and (new.concluido_por_calculista_id is not null or new.concluido_em is not null) then
    raise exception 'Cálculo aberto não pode manter crédito/data de conclusão. Use a RPC de reabertura.' using errcode = '23514';
  end if;

  -- Defesa extra contra PATCH direto na Data API: crédito, data, status e
  -- vínculos de um cálculo concluído só mudam pelas RPCs auditadas. As RPCs
  -- marcam a transação com dls.calculo_auditado=on. A limitação de identidade
  -- do modelo de autenticação atual continua documentada no README.
  if tg_op = 'update'
     and old.status = 'entregue'
     and (
       new.status is distinct from old.status
       or new.concluido_por_calculista_id is distinct from old.concluido_por_calculista_id
       or new.concluido_em is distinct from old.concluido_em
       or new.calculista_executor_id is distinct from old.calculista_executor_id
       or new.reclamante_id is distinct from old.reclamante_id
       or new.escopo is distinct from old.escopo
       or new.ativo is distinct from old.ativo
     )
     and coalesce(current_setting('dls.calculo_auditado', true), '') <> 'on' then
    raise exception 'Cálculo concluído só pode ser alterado pelas RPCs auditadas de reabertura/correção.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists dls_calculos_validar on public.dls_demanda_calculos;
create trigger dls_calculos_validar
before insert or update on public.dls_demanda_calculos
for each row execute function public.dls_validar_calculo();

create or replace function public.dls_sincronizar_responsavel_principal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.ativo and new.papel = 'principal' then
    update public.dls_demandas
       set responsavel_id = new.calculista_id,
           updated_at = now()
     where id = new.demanda_id
       and responsavel_id is distinct from new.calculista_id;
  end if;
  return new;
end;
$$;

drop trigger if exists dls_responsaveis_sync_principal on public.dls_demanda_responsaveis;
create trigger dls_responsaveis_sync_principal
after insert or update on public.dls_demanda_responsaveis
for each row execute function public.dls_sincronizar_responsavel_principal();

-- ------------------------------------------------------------
-- 6. RPC transacional de gravação do agregado
-- ------------------------------------------------------------
create or replace function public.dls_salvar_demanda_coletiva(
  p_demanda jsonb,
  p_reclamantes jsonb default '[]'::jsonb,
  p_calculos jsonb default '[]'::jsonb,
  p_responsaveis jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id text := btrim(coalesce(p_demanda->>'id', ''));
  v_modalidade text := coalesce(nullif(btrim(p_demanda->>'modalidade_demanda'), ''), 'individual');
  v_primary text;
  v_primary_count integer := 0;
  v_active_rec integer := 0;
  v_active_calc integer := 0;
  v_item jsonb;
  v_rec_id text;
  v_team_id text;
begin
  p_reclamantes := coalesce(p_reclamantes, '[]'::jsonb);
  p_calculos := coalesce(p_calculos, '[]'::jsonb);
  p_responsaveis := coalesce(p_responsaveis, '[]'::jsonb);

  if v_id = '' then
    raise exception 'id da demanda é obrigatório.' using errcode = '22023';
  end if;
  -- Serializa gravações concorrentes do mesmo agregado.
  perform pg_advisory_xact_lock(hashtext('dls_demanda:' || v_id));
  if v_modalidade not in ('individual', 'coletiva') then
    raise exception 'modalidade_demanda inválida: %', v_modalidade using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_reclamantes, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_calculos, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_responsaveis, '[]'::jsonb)) <> 'array' then
    raise exception 'reclamantes, cálculos e responsáveis devem ser arrays JSON.' using errcode = '22023';
  end if;

  select count(*) into v_active_rec
    from jsonb_array_elements(p_reclamantes) r
   where coalesce((r->>'ativo')::boolean, true);
  select count(*) into v_active_calc
    from jsonb_array_elements(p_calculos) c
   where coalesce((c->>'ativo')::boolean, true);

  if v_modalidade = 'coletiva' and v_active_rec = 0 then
    raise exception 'Demanda coletiva exige pelo menos um reclamante ativo.' using errcode = '23514';
  end if;
  if v_modalidade = 'coletiva' and v_active_calc = 0 then
    raise exception 'Demanda coletiva exige pelo menos um cálculo ativo.' using errcode = '23514';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_reclamantes) r
     where coalesce((r->>'ativo')::boolean, true)
       and length(btrim(coalesce(r->>'nome', ''))) = 0
  ) then
    raise exception 'Reclamante ativo exige nome.' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_reclamantes) r
     where btrim(coalesce(r->>'id', '')) = ''
  ) then
    raise exception 'Reclamante sem ID no payload.' using errcode = '23514';
  end if;
  if exists (
    select 1 from (
      select btrim(r->>'id') as id
        from jsonb_array_elements(p_reclamantes) r
       group by btrim(r->>'id')
      having count(*) > 1
    ) dup
  ) then
    raise exception 'Há reclamantes com ID duplicado no payload.' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_calculos) c
     where coalesce((c->>'ativo')::boolean, true)
       and length(btrim(coalesce(c->>'tipo', ''))) = 0
  ) then
    raise exception 'Cálculo ativo exige tipo.' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_calculos) c
     where btrim(coalesce(c->>'id', '')) = ''
  ) then
    raise exception 'Cálculo sem ID no payload.' using errcode = '23514';
  end if;
  if exists (
    select 1 from (
      select btrim(c->>'id') as id
        from jsonb_array_elements(p_calculos) c
       group by btrim(c->>'id')
      having count(*) > 1
    ) dup
  ) then
    raise exception 'Há cálculos com ID duplicado no payload.' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_responsaveis) r
     where btrim(coalesce(r->>'id', '')) = ''
  ) then
    raise exception 'Vínculo de equipe sem ID no payload.' using errcode = '23514';
  end if;
  if exists (
    select 1 from (
      select btrim(r->>'id') as id
        from jsonb_array_elements(p_responsaveis) r
       group by btrim(r->>'id')
      having count(*) > 1
    ) dup
  ) then
    raise exception 'Há vínculos de equipe com ID duplicado no payload.' using errcode = '23514';
  end if;

  -- IDs existentes não podem ser “movidos” de outra demanda.
  if exists (
    select 1
      from public.dls_demanda_reclamantes r
     where r.demanda_id <> v_id
       and r.id in (select btrim(x->>'id') from jsonb_array_elements(p_reclamantes) x)
  ) then
    raise exception 'Reclamante informado pertence a outra demanda.' using errcode = '23514';
  end if;
  if exists (
    select 1
      from public.dls_demanda_calculos c
     where c.demanda_id <> v_id
       and c.id in (select btrim(x->>'id') from jsonb_array_elements(p_calculos) x)
  ) then
    raise exception 'Cálculo informado pertence a outra demanda.' using errcode = '23514';
  end if;

  -- Reclamante de cálculo deve estar no payload ativo e na mesma demanda.
  if exists (
    select 1
      from jsonb_array_elements(p_calculos) c
     where coalesce((c->>'ativo')::boolean, true)
       and c->>'escopo' = 'individual'
       and nullif(btrim(coalesce(c->>'reclamante_id', '')), '') is not null
       and not exists (
         select 1
           from jsonb_array_elements(p_reclamantes) r
          where coalesce((r->>'ativo')::boolean, true)
            and btrim(r->>'id') = btrim(c->>'reclamante_id')
       )
  ) then
    raise exception 'Cálculo individual referencia reclamante inexistente/inativo nesta demanda.' using errcode = '23514';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_calculos) c
     where coalesce((c->>'ativo')::boolean, true)
       and (
         c->>'escopo' not in ('individual', 'coletivo')
         or (c->>'escopo' = 'coletivo' and nullif(btrim(coalesce(c->>'reclamante_id', '')), '') is not null)
         or (v_modalidade = 'coletiva' and c->>'escopo' = 'individual'
             and nullif(btrim(coalesce(c->>'reclamante_id', '')), '') is null)
       )
  ) then
    raise exception 'Escopo/vínculo de reclamante inválido em cálculo.' using errcode = '23514';
  end if;

  -- Novo cálculo ativo exige executor; executor ativo precisa estar na equipe.
  if exists (
    select 1
      from jsonb_array_elements(p_calculos) c
     where coalesce((c->>'ativo')::boolean, true)
       and btrim(coalesce(c->>'origem_registro', 'novo')) <> 'legado'
       and nullif(btrim(coalesce(c->>'calculista_executor_id', '')), '') is null
  ) then
    raise exception 'Todo cálculo novo ativo exige calculista executor.' using errcode = '23514';
  end if;
  -- A exigência de vínculo com a equipe vale para cálculos em aberto. Um
  -- cálculo concluído mantém o executor histórico mesmo após a saída dele da
  -- equipe; o crédito congelado continua intacto.
  if exists (
    select 1
      from jsonb_array_elements(p_calculos) c
     where coalesce((c->>'ativo')::boolean, true)
       and btrim(coalesce(c->>'status', 'pendente')) not in ('entregue', 'cancelada')
       and nullif(btrim(coalesce(c->>'calculista_executor_id', '')), '') is not null
       and not exists (
         select 1
           from jsonb_array_elements(p_responsaveis) r
          where coalesce((r->>'ativo')::boolean, true)
            and btrim(r->>'calculista_id') = btrim(c->>'calculista_executor_id')
       )
  ) then
    raise exception 'Executor do cálculo em aberto precisa fazer parte da equipe ativa da demanda.' using errcode = '23514';
  end if;

  -- Cálculos concluídos preservam crédito/data no upsert. O formulário usa a
  -- RPC auditada para concluir; a importação de backup pode restaurar o crédito
  -- congelado desde que data e calculista estejam presentes (validado por trigger).

  -- Cálculo concluído não pode ser removido/desativado pelo agregado.
  if exists (
    select 1 from public.dls_demanda_calculos e
     where e.demanda_id = v_id and e.ativo and e.status = 'entregue'
       and not exists (
         select 1 from jsonb_array_elements(p_calculos) x
          where x->>'id' = e.id
            and coalesce((x->>'ativo')::boolean, true)
       )
  ) then
    raise exception 'Cálculo concluído não pode ser removido. Use a reabertura auditada.' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_calculos) c
     where btrim(coalesce(c->>'status', '')) = 'entregue'
       and not coalesce((c->>'ativo')::boolean, true)
  ) then
    raise exception 'Cálculo concluído não pode ser inativado no agregado.' using errcode = '23514';
  end if;

  -- Demanda coletiva entregue não pode manter cálculo ativo em aberto.
  if v_modalidade = 'coletiva'
     and btrim(coalesce(p_demanda->>'status', '')) = 'entregue'
     and exists (
       select 1 from jsonb_array_elements(p_calculos) c
        where coalesce((c->>'ativo')::boolean, true)
          and btrim(coalesce(c->>'status', 'pendente')) not in ('entregue', 'cancelada')
     ) then
    raise exception 'Demanda coletiva entregue exige todos os cálculos concluídos ou cancelados.' using errcode = '23514';
  end if;

  -- IDs de equipe não podem ser reaproveitados de outra demanda.
  if exists (
    select 1 from public.dls_demanda_responsaveis r
     where r.demanda_id <> v_id
       and r.id in (
         select nullif(btrim(coalesce(x->>'id', '')), '')
           from jsonb_array_elements(p_responsaveis) x
       )
  ) then
    raise exception 'Vínculo de equipe informado pertence a outra demanda.' using errcode = '23514';
  end if;
  -- O mesmo calculista não pode aparecer duas vezes na equipe ativa.
  if exists (
    select 1
      from jsonb_array_elements(p_responsaveis) r
     where coalesce((r->>'ativo')::boolean, true)
       and btrim(coalesce(r->>'calculista_id', '')) = ''
  ) then
    raise exception 'Vínculo ativo de equipe exige calculista.' using errcode = '23514';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_responsaveis) r
     where coalesce((r->>'ativo')::boolean, true)
     group by btrim(r->>'calculista_id')
    having count(*) > 1
  ) then
    raise exception 'Calculista duplicado na equipe ativa.' using errcode = '23514';
  end if;

  select count(*), max(btrim(r->>'calculista_id'))
    into v_primary_count, v_primary
    from jsonb_array_elements(p_responsaveis) r
   where coalesce((r->>'ativo')::boolean, true)
     and r->>'papel' = 'principal';
  if v_primary_count <> 1 then
    raise exception 'A demanda deve ter exatamente um responsável principal ativo.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.dls_calculistas c where c.id = v_primary
  ) then
    raise exception 'Responsável principal não existe no cadastro de calculistas.' using errcode = '23514';
  end if;

  -- Demanda principal (upsert). O responsável legado é sincronizado com o principal.
  insert into public.dls_demandas (
    id, numero, processo, data_requisicao, reclamante, cliente_id, tipo,
    responsavel_id, prazo, prioridade, origem, status, obs, criado_em, updated_at,
    historico, comentarios, natureza, origem_calculo, allowed_user_ids,
    procurador, chamado, modalidade_demanda, valor_estimado, concluida_em
  ) values (
    v_id,
    coalesce(nullif(btrim(coalesce(p_demanda->>'numero', '')), ''), v_id),
    nullif(btrim(coalesce(p_demanda->>'processo', '')), ''),
    nullif(btrim(coalesce(p_demanda->>'data_requisicao', '')), '')::date,
    nullif(btrim(coalesce(p_demanda->>'reclamante', '')), ''),
    nullif(btrim(coalesce(p_demanda->>'cliente_id', '')), ''),
    coalesce(nullif(btrim(coalesce(p_demanda->>'tipo', '')), ''), 'Cálculo'),
    v_primary,
    nullif(btrim(coalesce(p_demanda->>'prazo', '')), '')::date,
    coalesce(nullif(btrim(coalesce(p_demanda->>'prioridade', '')), ''), 'media'),
    nullif(btrim(coalesce(p_demanda->>'origem', '')), ''),
    coalesce(nullif(btrim(coalesce(p_demanda->>'status', '')), ''), 'triagem'),
    nullif(btrim(coalesce(p_demanda->>'obs', '')), ''),
    nullif(btrim(coalesce(p_demanda->>'criado_em', '')), '')::timestamp,
    coalesce(nullif(btrim(coalesce(p_demanda->>'updated_at', '')), '')::timestamp, now()::timestamp),
    coalesce(p_demanda->'historico', '[]'::jsonb),
    coalesce(p_demanda->'comentarios', '[]'::jsonb),
    nullif(btrim(coalesce(p_demanda->>'natureza', '')), ''),
    nullif(btrim(coalesce(p_demanda->>'origem_calculo', '')), ''),
    coalesce(p_demanda->'allowed_user_ids', '[]'::jsonb),
    nullif(btrim(coalesce(p_demanda->>'procurador', '')), ''),
    nullif(btrim(coalesce(p_demanda->>'chamado', '')), ''),
    v_modalidade,
    nullif(btrim(coalesce(p_demanda->>'valor_estimado', '')), '')::numeric,
    nullif(btrim(coalesce(p_demanda->>'concluida_em', '')), '')::timestamptz
  )
  on conflict (id) do update set
    numero = excluded.numero,
    processo = excluded.processo,
    data_requisicao = excluded.data_requisicao,
    reclamante = excluded.reclamante,
    cliente_id = excluded.cliente_id,
    tipo = excluded.tipo,
    responsavel_id = excluded.responsavel_id,
    prazo = excluded.prazo,
    prioridade = excluded.prioridade,
    origem = excluded.origem,
    status = excluded.status,
    obs = excluded.obs,
    updated_at = excluded.updated_at,
    historico = excluded.historico,
    comentarios = excluded.comentarios,
    natureza = excluded.natureza,
    origem_calculo = excluded.origem_calculo,
    allowed_user_ids = excluded.allowed_user_ids,
    procurador = excluded.procurador,
    chamado = excluded.chamado,
    modalidade_demanda = excluded.modalidade_demanda,
    valor_estimado = excluded.valor_estimado,
    -- Em edição comum o frontend não envia a data. Preserva a data de uma
    -- demanda que continua entregue e limpa quando o status deixa de ser
    -- entregue; a restauração explícita pode informar a data histórica.
    concluida_em = case
      when excluded.status = 'entregue'
       and dls_demandas.status = 'entregue'
        then coalesce(excluded.concluida_em, dls_demandas.concluida_em)
      else excluded.concluida_em
    end;

  -- Reclamantes: desativa ausentes e faz upsert dos presentes.
  update public.dls_demanda_reclamantes r
     set ativo = false,
         updated_at = now()
   where r.demanda_id = v_id
     and r.ativo
     and not exists (
       select 1 from jsonb_array_elements(p_reclamantes) x
        where x->>'id' = r.id
     );

  for v_item in select value from jsonb_array_elements(p_reclamantes) loop
    v_rec_id := btrim(coalesce(v_item->>'id', ''));
    if v_rec_id = '' then
      raise exception 'Reclamante sem ID no payload.' using errcode = '23514';
    end if;
    insert into public.dls_demanda_reclamantes (
      id, demanda_id, nome, observacoes, ordem, ativo, legado_principal
    ) values (
      v_rec_id,
      v_id,
      btrim(v_item->>'nome'),
      nullif(btrim(coalesce(v_item->>'observacoes', '')), ''),
      coalesce((v_item->>'ordem')::integer, 0),
      coalesce((v_item->>'ativo')::boolean, true),
      coalesce((v_item->>'legado_principal')::boolean, false)
    )
    on conflict (id) do update set
      demanda_id = excluded.demanda_id,
      nome = excluded.nome,
      observacoes = excluded.observacoes,
      ordem = excluded.ordem,
      ativo = excluded.ativo,
      legado_principal = excluded.legado_principal,
      updated_at = now();
  end loop;

  -- Cálculos: desativa ausentes e faz upsert. Conclusão existente é congelada.
  update public.dls_demanda_calculos c
     set ativo = false,
         updated_at = now()
   where c.demanda_id = v_id
     and c.ativo
     and not exists (
       select 1 from jsonb_array_elements(p_calculos) x
        where x->>'id' = c.id
     );

  for v_item in select value from jsonb_array_elements(p_calculos) loop
    if btrim(coalesce(v_item->>'id', '')) = '' then
      raise exception 'Cálculo sem ID no payload.' using errcode = '23514';
    end if;
    insert into public.dls_demanda_calculos as c (
      id, demanda_id, reclamante_id, escopo, tipo, origem_calculo,
      calculista_executor_id, prazo, status, valor_resultado, observacoes,
      ordem, ativo, legado_principal, legado_sem_reclamante,
      credito_legado_presumido, concluido_por_calculista_id, concluido_em,
      origem_registro
    ) values (
      btrim(v_item->>'id'),
      v_id,
      nullif(btrim(coalesce(v_item->>'reclamante_id', '')), ''),
      coalesce(nullif(btrim(coalesce(v_item->>'escopo', '')), ''), 'individual'),
      btrim(v_item->>'tipo'),
      nullif(btrim(coalesce(v_item->>'origem_calculo', '')), ''),
      nullif(btrim(coalesce(v_item->>'calculista_executor_id', '')), ''),
      nullif(btrim(coalesce(v_item->>'prazo', '')), '')::date,
      coalesce(nullif(btrim(coalesce(v_item->>'status', '')), ''), 'pendente'),
      nullif(btrim(coalesce(v_item->>'valor_resultado', '')), '')::numeric,
      nullif(btrim(coalesce(v_item->>'observacoes', '')), ''),
      coalesce((v_item->>'ordem')::integer, 0),
      coalesce((v_item->>'ativo')::boolean, true),
      coalesce((v_item->>'legado_principal')::boolean, false),
      coalesce((v_item->>'legado_sem_reclamante')::boolean, false),
      coalesce((v_item->>'credito_legado_presumido')::boolean, false),
      nullif(btrim(coalesce(v_item->>'concluido_por_calculista_id', '')), ''),
      nullif(btrim(coalesce(v_item->>'concluido_em', '')), '')::timestamptz,
      coalesce(nullif(btrim(coalesce(v_item->>'origem_registro', '')), ''), 'novo')
    )
    on conflict (id) do update set
      demanda_id = excluded.demanda_id,
      reclamante_id = case when c.status = 'entregue'
                           then c.reclamante_id else excluded.reclamante_id end,
      escopo = case when c.status = 'entregue'
                    then c.escopo else excluded.escopo end,
      tipo = excluded.tipo,
      origem_calculo = excluded.origem_calculo,
      calculista_executor_id = case
        when c.status = 'entregue' then c.calculista_executor_id
        when excluded.status = 'entregue'
          then coalesce(excluded.calculista_executor_id, excluded.concluido_por_calculista_id, c.calculista_executor_id)
        else excluded.calculista_executor_id end,
      prazo = excluded.prazo,
      status = case when c.status = 'entregue'
                    then c.status else excluded.status end,
      valor_resultado = excluded.valor_resultado,
      observacoes = excluded.observacoes,
      ordem = excluded.ordem,
      ativo = excluded.ativo,
      legado_principal = excluded.legado_principal,
      legado_sem_reclamante = excluded.legado_sem_reclamante,
      credito_legado_presumido = case when c.status = 'entregue'
                                      then c.credito_legado_presumido
                                      else excluded.credito_legado_presumido end,
      -- Restauração de backup pode promover um cálculo aberto para concluído
      -- com crédito/data congelados. Cálculos já concluídos nunca são alterados aqui.
      concluido_por_calculista_id = case when c.status = 'entregue'
                                         then c.concluido_por_calculista_id
                                         else excluded.concluido_por_calculista_id end,
      concluido_em = case when c.status = 'entregue'
                          then c.concluido_em else excluded.concluido_em end,
      origem_registro = case when c.status = 'entregue'
                             then c.origem_registro else excluded.origem_registro end,
      updated_at = now();
  end loop;

  -- Equipe: desativa ausentes; principal antigo é desativado antes do upsert.
  update public.dls_demanda_responsaveis r
     set ativo = false,
         removido_em = now(),
         updated_at = now()
   where r.demanda_id = v_id
     and r.ativo
     and not exists (
       select 1 from jsonb_array_elements(p_responsaveis) x
        where x->>'calculista_id' = r.calculista_id
     );

  update public.dls_demanda_responsaveis r
     set ativo = false,
         removido_em = now(),
         updated_at = now()
   where r.demanda_id = v_id
     and r.ativo
     and r.papel = 'principal'
     and r.calculista_id <> v_primary;

  -- Se o payload reutilizar um ID histórico/inativo para o mesmo par, desativa
  -- o vínculo ativo antigo antes do upsert (evita violar o índice único do par).
  update public.dls_demanda_responsaveis r
     set ativo = false,
         removido_em = now(),
         updated_at = now()
   where r.demanda_id = v_id
     and r.ativo
     and exists (
       select 1 from jsonb_array_elements(p_responsaveis) x
        where x->>'calculista_id' = r.calculista_id
          and nullif(btrim(coalesce(x->>'id', '')), '') is not null
          and nullif(btrim(coalesce(x->>'id', '')), '') <> r.id
     );

  for v_item in select value from jsonb_array_elements(p_responsaveis) loop
    if btrim(coalesce(v_item->>'calculista_id', '')) = '' then
      raise exception 'Responsável sem calculista_id no payload.' using errcode = '23514';
    end if;
    if not exists (select 1 from public.dls_calculistas c where c.id = v_item->>'calculista_id') then
      raise exception 'Calculista % não existe.', v_item->>'calculista_id' using errcode = '23503';
    end if;
    -- Reutiliza o ID do vínculo ativo existente do mesmo par (demanda, calculista).
    -- Sem isso, um payload com ID novo colidiria com uq_dls_responsaveis_par_ativo.
    v_team_id := nullif(btrim(coalesce(v_item->>'id', '')), '');
    if v_team_id is null
       or not exists (
         select 1 from public.dls_demanda_responsaveis r
          where r.id = v_team_id and r.demanda_id = v_id
       ) then
      select r.id into v_team_id
        from public.dls_demanda_responsaveis r
       where r.demanda_id = v_id
         and r.calculista_id = v_item->>'calculista_id'
         and r.ativo
       limit 1;
    end if;
    if v_team_id is null then
      v_team_id := 'EQP-' || v_id || '-' || (v_item->>'calculista_id');
    end if;
    insert into public.dls_demanda_responsaveis (
      id, demanda_id, calculista_id, papel, ativo, atribuido_por, atribuido_em
    ) values (
      v_team_id,
      v_id,
      v_item->>'calculista_id',
      case when v_item->>'calculista_id' = v_primary then 'principal' else 'co_responsavel' end,
      coalesce((v_item->>'ativo')::boolean, true),
      nullif(btrim(coalesce(v_item->>'atribuido_por', '')), ''),
      coalesce(nullif(btrim(coalesce(v_item->>'atribuido_em', '')), '')::timestamptz, now())
    )
    on conflict (id) do update set
      demanda_id = excluded.demanda_id,
      calculista_id = excluded.calculista_id,
      papel = excluded.papel,
      ativo = excluded.ativo,
      atribuido_por = excluded.atribuido_por,
      removido_em = case when excluded.ativo then null else now() end,
      updated_at = now();
  end loop;

  -- Garantia final de sincronização principal -> demanda.
  update public.dls_demandas
     set responsavel_id = v_primary,
         updated_at = now()
   where id = v_id
     and responsavel_id is distinct from v_primary;

  return jsonb_build_object(
    'demanda_id', v_id,
    'demanda', (select to_jsonb(d) from public.dls_demandas d where d.id = v_id),
    'reclamantes', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.ordem, r.id)
        from public.dls_demanda_reclamantes r where r.demanda_id = v_id
    ), '[]'::jsonb),
    'calculos', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.ordem, c.id)
        from public.dls_demanda_calculos c where c.demanda_id = v_id
    ), '[]'::jsonb),
    'responsaveis', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.papel, r.id)
        from public.dls_demanda_responsaveis r where r.demanda_id = v_id
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.dls_salvar_demanda_coletiva(jsonb, jsonb, jsonb, jsonb) is
  'Grava demanda, reclamantes, cálculos e equipe na mesma transação, com validação de vínculos e congelamento de conclusão.';

-- ------------------------------------------------------------
-- 7. RPCs de conclusão, reabertura e correção de crédito
-- ------------------------------------------------------------
create or replace function public.dls_concluir_calculo(
  p_calculo_id text,
  p_executor_creditado_id text,
  p_usuario text default 'sistema'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_calc public.dls_demanda_calculos%rowtype;
  v_nome text;
  v_executor_nome text;
begin
  if nullif(btrim(coalesce(p_executor_creditado_id, '')), '') is null then
    raise exception 'Informe o calculista que executou o cálculo.' using errcode = '22023';
  end if;

  select * into v_calc
    from public.dls_demanda_calculos
   where id = p_calculo_id
   for update;
  if not found then
    raise exception 'Cálculo não encontrado.' using errcode = 'P0002';
  end if;
  if v_calc.status = 'cancelada' then
    raise exception 'Cálculo cancelado não pode ser concluído.' using errcode = '23514';
  end if;
  if not v_calc.ativo then
    raise exception 'Cálculo inativo/cancelado não pode ser concluído.' using errcode = '23514';
  end if;

  select c.nome into v_executor_nome
    from public.dls_calculistas c
   where c.id = p_executor_creditado_id;
  if v_executor_nome is null then
    raise exception 'Calculista creditado não existe.' using errcode = '23503';
  end if;

  if not exists (
    select 1 from public.dls_demanda_responsaveis r
     where r.demanda_id = v_calc.demanda_id
       and r.calculista_id = p_executor_creditado_id
       and r.ativo
  ) then
    raise exception 'O calculista creditado precisa fazer parte da equipe ativa da demanda.' using errcode = '23514';
  end if;

  if v_calc.status = 'entregue' then
    if v_calc.concluido_por_calculista_id = p_executor_creditado_id then
      return jsonb_build_object(
        'calculo_id', v_calc.id,
        'demanda_id', v_calc.demanda_id,
        'concluido_em', v_calc.concluido_em,
        'concluido_por_calculista_id', v_calc.concluido_por_calculista_id,
        'idempotente', true
      );
    end if;
    raise exception 'Cálculo já concluído por outro calculista. Use a correção administrativa de crédito.' using errcode = '23514';
  end if;
  if v_calc.status not in ('pendente', 'andamento', 'revisao', 'aguardando') then
    raise exception 'Status atual do cálculo não permite conclusão.' using errcode = '23514';
  end if;

  update public.dls_demanda_calculos
     set status = 'entregue',
         calculista_executor_id = p_executor_creditado_id,
         concluido_por_calculista_id = p_executor_creditado_id,
         concluido_em = now(),
         credito_legado_presumido = false,
         updated_at = now()
   where id = p_calculo_id;

  select d.numero into v_nome from public.dls_demandas d where d.id = v_calc.demanda_id;

  update public.dls_demandas
     set historico = jsonb_build_array(jsonb_build_object(
           'data', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
           'texto', format('Cálculo %s concluído por %s', v_calc.tipo, v_executor_nome),
           'autor', coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'sistema')
         )) || coalesce(historico, '[]'::jsonb),
         updated_at = now()
   where id = v_calc.demanda_id;

  return jsonb_build_object(
    'calculo_id', p_calculo_id,
    'demanda_id', v_calc.demanda_id,
    'demanda_numero', v_nome,
    'concluido_em', now(),
    'concluido_por_calculista_id', p_executor_creditado_id,
    'idempotente', false
  );
end;
$$;

create or replace function public.dls_reabrir_calculo(
  p_calculo_id text,
  p_usuario text default 'sistema',
  p_motivo text default ''
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_calc public.dls_demanda_calculos%rowtype;
  v_antigo text;
begin
  select * into v_calc
    from public.dls_demanda_calculos
   where id = p_calculo_id
   for update;
  if not found then
    raise exception 'Cálculo não encontrado.' using errcode = 'P0002';
  end if;
  if v_calc.status <> 'entregue' then
    raise exception 'Somente cálculos concluídos podem ser reabertos.' using errcode = '23514';
  end if;
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Reabertura de cálculo exige motivo auditável.' using errcode = '22023';
  end if;

  select nome into v_antigo from public.dls_calculistas where id = v_calc.concluido_por_calculista_id;

  -- Autoriza a mudança de campos congelados apenas dentro desta transação/RPC.
  perform set_config('dls.calculo_auditado', 'on', true);
  update public.dls_demanda_calculos
     set status = 'andamento',
         concluido_por_calculista_id = null,
         concluido_em = null,
         credito_legado_presumido = false,
         updated_at = now()
   where id = p_calculo_id;

  update public.dls_demandas
     set historico = jsonb_build_array(jsonb_build_object(
           'data', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
           'texto', format('Cálculo %s reaberto (crédito anterior: %s)%s',
                          v_calc.tipo,
                          coalesce(v_antigo, 'não atribuído'),
                          case when btrim(coalesce(p_motivo, '')) = '' then ''
                               else ' — motivo: ' || btrim(p_motivo) end),
           'autor', coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'sistema')
         )) || coalesce(historico, '[]'::jsonb),
         updated_at = now()
   where id = v_calc.demanda_id;

  return jsonb_build_object(
    'calculo_id', p_calculo_id,
    'demanda_id', v_calc.demanda_id,
    'status', 'andamento',
    'credito_anterior', v_calc.concluido_por_calculista_id
  );
end;
$$;

create or replace function public.dls_corrigir_credito_calculo(
  p_calculo_id text,
  p_novo_calculista_id text,
  p_motivo text,
  p_usuario text default 'sistema'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_calc public.dls_demanda_calculos%rowtype;
  v_antigo text;
  v_novo text;
begin
  if btrim(coalesce(p_motivo, '')) = '' then
    raise exception 'Correção de crédito exige motivo auditável.' using errcode = '22023';
  end if;
  select * into v_calc from public.dls_demanda_calculos where id = p_calculo_id for update;
  if not found then
    raise exception 'Cálculo não encontrado.' using errcode = 'P0002';
  end if;
  if v_calc.status <> 'entregue' then
    raise exception 'Somente cálculo concluído pode ter crédito corrigido.' using errcode = '23514';
  end if;
  select nome into v_antigo from public.dls_calculistas where id = v_calc.concluido_por_calculista_id;
  select nome into v_novo from public.dls_calculistas where id = p_novo_calculista_id;
  if v_novo is null then
    raise exception 'Novo calculista creditado não existe.' using errcode = '23503';
  end if;
  if v_calc.concluido_por_calculista_id = p_novo_calculista_id then
    raise exception 'O novo crédito é igual ao crédito atual.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.dls_demanda_responsaveis r
     where r.demanda_id = v_calc.demanda_id
       and r.calculista_id = p_novo_calculista_id
       and r.ativo
  ) then
    raise exception 'O novo calculista creditado precisa fazer parte da equipe ativa da demanda.' using errcode = '23514';
  end if;

  -- Autoriza a correção de crédito apenas dentro desta transação/RPC auditada.
  perform set_config('dls.calculo_auditado', 'on', true);
  update public.dls_demanda_calculos
     set concluido_por_calculista_id = p_novo_calculista_id,
         credito_legado_presumido = false,
         updated_at = now()
   where id = p_calculo_id;

  update public.dls_demandas
     set historico = jsonb_build_array(jsonb_build_object(
           'data', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS'),
           'texto', format('Crédito do cálculo %s corrigido de %s para %s — motivo: %s',
                          v_calc.tipo, coalesce(v_antigo, 'não atribuído'), v_novo, btrim(p_motivo)),
           'autor', coalesce(nullif(btrim(coalesce(p_usuario, '')), ''), 'sistema')
         )) || coalesce(historico, '[]'::jsonb),
         updated_at = now()
   where id = v_calc.demanda_id;

  return jsonb_build_object(
    'calculo_id', p_calculo_id,
    'demanda_id', v_calc.demanda_id,
    'credito_anterior', v_calc.concluido_por_calculista_id,
    'credito_novo', p_novo_calculista_id
  );
end;
$$;

-- Exclusão da demanda inteira em uma única transação. Os filhos são removidos
-- nesta ordem por causa das FKs de proteção histórica. A exclusão de um
-- reclamante isolado continua proibida quando existirem cálculos vinculados.
create or replace function public.dls_excluir_demanda_completa(
  p_demanda_id text
)
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

-- ------------------------------------------------------------
-- 8. Backfill idempotente do legado
-- ------------------------------------------------------------
-- Premissa documentada: a produtividade legada do sistema sempre creditou
-- dls_demandas.responsavel_id nas demandas entregues. O backfill reproduz
-- essa mesma premissa e marca a linha com credito_legado_presumido=true.

insert into public.dls_demanda_reclamantes (
  id, demanda_id, nome, observacoes, ordem, ativo, legado_principal
)
select
  'REC-LEG-' || d.id,
  d.id,
  btrim(d.reclamante),
  null,
  0,
  true,
  true
from public.dls_demandas d
where btrim(coalesce(d.reclamante, '')) <> ''
  and not exists (
    select 1 from public.dls_demanda_reclamantes r
     where r.demanda_id = d.id
  );

insert into public.dls_demanda_calculos (
  id, demanda_id, reclamante_id, escopo, tipo, origem_calculo,
  calculista_executor_id, prazo, status, valor_resultado, observacoes,
  ordem, ativo, legado_principal, legado_sem_reclamante,
  credito_legado_presumido, concluido_por_calculista_id, concluido_em,
  origem_registro
)
select
  'CLC-LEG-' || d.id,
  d.id,
  r.id,
  'individual',
  d.tipo,
  d.origem_calculo,
  case when exists (select 1 from public.dls_calculistas c where c.id = d.responsavel_id)
       then d.responsavel_id else null end,
  d.prazo,
  case d.status
    when 'entregue' then 'entregue'
    when 'cancelada' then 'cancelada'
    when 'andamento' then 'andamento'
    when 'revisao' then 'revisao'
    when 'aguardando' then 'aguardando'
    else 'pendente'
  end,
  null,
  'Cálculo principal migrado do registro legado.',
  0,
  true,
  true,
  (r.id is null),
  (d.status = 'entregue' and exists (select 1 from public.dls_calculistas c where c.id = d.responsavel_id)),
  case when d.status = 'entregue'
            and exists (select 1 from public.dls_calculistas c where c.id = d.responsavel_id)
       then d.responsavel_id else null end,
  case when d.status = 'entregue' then d.concluida_em else null end,
  'legado'
from public.dls_demandas d
left join lateral (
  select r.*
    from public.dls_demanda_reclamantes r
   where r.demanda_id = d.id and r.ativo
   order by r.legado_principal desc, r.ordem, r.id
   limit 1
) r on true
where not exists (
  select 1 from public.dls_demanda_calculos c
   where c.demanda_id = d.id
);

insert into public.dls_demanda_responsaveis (
  id, demanda_id, calculista_id, papel, ativo, atribuido_por, atribuido_em
)
select
  'EQP-LEG-' || d.id,
  d.id,
  d.responsavel_id,
  'principal',
  true,
  'migracao_v5',
  now()
from public.dls_demandas d
where d.responsavel_id is not null
  and exists (select 1 from public.dls_calculistas c where c.id = d.responsavel_id)
  and not exists (
    select 1 from public.dls_demanda_responsaveis r
     where r.demanda_id = d.id and r.ativo
  )
on conflict (id) do update set
  demanda_id = excluded.demanda_id,
  calculista_id = excluded.calculista_id,
  papel = excluded.papel,
  ativo = true,
  removido_em = null,
  updated_at = now();

update public.dls_demandas
   set modalidade_demanda = 'individual'
 where modalidade_demanda is null;

-- ------------------------------------------------------------
-- 9. View de apoio à produtividade de cálculos
-- ------------------------------------------------------------
create or replace view public.vw_dls_calculos_produtividade
with (security_invoker = true)
as
select
  c.id as calculo_id,
  c.demanda_id,
  d.numero as demanda_numero,
  d.processo,
  d.chamado,
  d.cliente_id,
  c.tipo,
  c.escopo,
  c.reclamante_id,
  r.nome as reclamante_nome,
  c.calculista_executor_id,
  c.status,
  c.prazo as prazo_calculo,
  coalesce(c.prazo, d.prazo) as prazo_efetivo,
  c.concluido_por_calculista_id,
  c.concluido_em,
  (c.concluido_em at time zone 'America/Sao_Paulo')::date as concluido_dia,
  c.legado_principal,
  c.credito_legado_presumido,
  c.origem_registro,
  c.ativo
from public.dls_demanda_calculos c
join public.dls_demandas d on d.id = c.demanda_id
left join public.dls_demanda_reclamantes r on r.id = c.reclamante_id;

comment on view public.vw_dls_calculos_produtividade is
  'Uma linha por cálculo, com prazo efetivo e crédito oficial. Não substitui as métricas de demandas.';

-- ------------------------------------------------------------
-- 10. Relatório de validação da migração
-- ------------------------------------------------------------
create or replace function public.dls_relatorio_migracao_v5()
returns jsonb
language sql
security invoker
set search_path = public
stable
as $$
  select jsonb_build_object(
    'total_demandas', (select count(*) from public.dls_demandas),
    'demandas_coletivas', (select count(*) from public.dls_demandas where modalidade_demanda = 'coletiva'),
    'demandas_com_reclamante_legado', (select count(*) from public.dls_demandas where btrim(coalesce(reclamante, '')) <> ''),
    'reclamantes_total', (select count(*) from public.dls_demanda_reclamantes),
    'reclamantes_ativos', (select count(*) from public.dls_demanda_reclamantes where ativo),
    'calculos_total', (select count(*) from public.dls_demanda_calculos),
    'calculos_ativos', (select count(*) from public.dls_demanda_calculos where ativo),
    'calculos_concluidos', (select count(*) from public.dls_demanda_calculos where status = 'entregue'),
    'calculos_legado_sem_executor', (
      select count(*) from public.dls_demanda_calculos
       where origem_registro = 'legado' and calculista_executor_id is null
    ),
    'calculos_legado_entregues_sem_credito', (
      select count(*) from public.dls_demanda_calculos
       where origem_registro = 'legado' and status = 'entregue'
         and concluido_por_calculista_id is null
    ),
    'calculos_legado_credito_presumido', (
      select count(*) from public.dls_demanda_calculos where credito_legado_presumido
    ),
    'equipe_total', (select count(*) from public.dls_demanda_responsaveis),
    'demandas_com_mais_de_um_principal', (
      select count(*) from (
        select demanda_id from public.dls_demanda_responsaveis
         where ativo and papel = 'principal'
         group by demanda_id having count(*) > 1
      ) x
    ),
    'demandas_com_filhos_sem_principal', (
      select count(*) from public.dls_demandas d
       where exists (select 1 from public.dls_demanda_calculos c where c.demanda_id = d.id and c.ativo)
         and not exists (
           select 1 from public.dls_demanda_responsaveis r
            where r.demanda_id = d.id and r.ativo and r.papel = 'principal'
         )
    ),
    'excecoes_legado', coalesce((
      select jsonb_agg(jsonb_build_object(
        'calculo_id', c.id,
        'demanda_id', c.demanda_id,
        'tipo', c.tipo,
        'status', c.status,
        'motivo', case
          when c.calculista_executor_id is null then 'sem executor legado válido'
          when c.status = 'entregue' and c.concluido_por_calculista_id is null then 'entregue sem crédito individual confirmado'
          when c.status = 'entregue' and c.concluido_em is null then 'entregue sem data de conclusão'
          else 'outro'
        end
      ) order by c.demanda_id)
      from public.dls_demanda_calculos c
      where c.origem_registro = 'legado'
        and (c.calculista_executor_id is null
             or (c.status = 'entregue' and c.concluido_por_calculista_id is null)
             or (c.status = 'entregue' and c.concluido_em is null))
    ), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- 11. RLS e permissões
--
-- LIMITAÇÃO CONHECIDA: o DLS autentica usuários no navegador com a anon key
-- e a tabela dls_user_profiles (não usa Supabase Auth). Portanto o banco não
-- consegue identificar o usuário final para aplicar RLS por responsável.
-- As políticas abaixo mantêm o mesmo modelo das tabelas existentes (anon),
-- e a segregação por usuário continua sendo aplicada pela camada DB/AUTH.
-- Não esconder essa limitação: ela está documentada no README.
-- ------------------------------------------------------------
alter table public.dls_demanda_reclamantes enable row level security;
alter table public.dls_demanda_calculos enable row level security;
alter table public.dls_demanda_responsaveis enable row level security;

drop policy if exists dls_reclamantes_browser_all on public.dls_demanda_reclamantes;
create policy dls_reclamantes_browser_all on public.dls_demanda_reclamantes
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_calculos_browser_all on public.dls_demanda_calculos;
create policy dls_calculos_browser_all on public.dls_demanda_calculos
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_responsaveis_browser_all on public.dls_demanda_responsaveis;
create policy dls_responsaveis_browser_all on public.dls_demanda_responsaveis
for all to anon, authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.dls_demanda_reclamantes,
  public.dls_demanda_calculos,
  public.dls_demanda_responsaveis
to anon, authenticated;
grant select on public.vw_dls_calculos_produtividade to anon, authenticated;
grant execute on function public.dls_salvar_demanda_coletiva(jsonb, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.dls_concluir_calculo(text, text, text) to anon, authenticated;
grant execute on function public.dls_reabrir_calculo(text, text, text) to anon, authenticated;
grant execute on function public.dls_corrigir_credito_calculo(text, text, text, text) to anon, authenticated;
grant execute on function public.dls_excluir_demanda_completa(text) to anon, authenticated;
grant execute on function public.dls_relatorio_migracao_v5() to anon, authenticated;

commit;

-- ============================================================
-- CONSULTAS DE VALIDAÇÃO (executar manualmente após a migração)
-- ============================================================
-- select public.dls_relatorio_migracao_v5();
-- select modalidade_demanda, count(*) from public.dls_demandas group by 1;
-- select count(*) from public.dls_demanda_reclamantes where legado_principal;
-- select count(*) from public.dls_demanda_calculos where legado_principal;
-- select * from public.vw_dls_calculos_produtividade order by demanda_id limit 50;
