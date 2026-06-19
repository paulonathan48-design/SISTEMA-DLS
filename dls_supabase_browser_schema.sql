-- DLS schema for a static browser-only Supabase setup.
-- Run this in Supabase SQL Editor.
-- This allows the anon key to read/write the DLS tables because the app has no login layer.

begin;

create table if not exists public.dls_sequences (
  name varchar(40) primary key,
  current_value integer not null default 100,
  updated_at timestamptz not null default now()
);

create table if not exists public.dls_calculistas (
  id varchar(30) primary key,
  nome varchar(160) not null,
  cargo varchar(80) not null,
  email varchar(160) not null,
  tel varchar(40),
  espec varchar(80),
  status varchar(30) not null default 'online',
  meta integer not null default 20,
  concluidas integer not null default 0,
  sla numeric(5,2) not null default 95.00,
  ativas integer not null default 0,
  tempo_medio numeric(6,2) not null default 2.00,
  obs text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dls_clientes (
  id varchar(30) primary key,
  nome varchar(180) not null,
  tipo varchar(40) not null,
  cnpj varchar(40),
  cidade varchar(120),
  contato varchar(160),
  email varchar(160),
  tel varchar(40),
  sla_contratado integer not null default 95,
  status_rel varchar(40) not null default 'ativo',
  total_historico integer not null default 0,
  obs text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dls_demandas (
  id varchar(30) primary key,
  numero varchar(40) not null,
  processo varchar(80),
  data_requisicao date,
  reclamante varchar(180),
  cliente_id varchar(30),
  tipo varchar(100) not null,
  responsavel_id varchar(30),
  prazo date,
  prioridade varchar(30) not null default 'media',
  origem varchar(60),
  status varchar(30) not null default 'triagem',
  obs text,
  criado_em timestamp,
  updated_at timestamp,
  historico jsonb not null default '[]'::jsonb,
  comentarios jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now()
);

create table if not exists public.dls_logs (
  id bigint primary key,
  data_label varchar(40) not null,
  usuario varchar(80) not null,
  acao varchar(80) not null,
  entidade varchar(80) not null,
  detalhe text,
  logged_at timestamptz not null default now()
);

create index if not exists idx_dls_calculistas_status on public.dls_calculistas (status);
create index if not exists idx_dls_calculistas_email on public.dls_calculistas (email);
create index if not exists idx_dls_clientes_tipo on public.dls_clientes (tipo);
create index if not exists idx_dls_clientes_status_rel on public.dls_clientes (status_rel);
create index if not exists idx_dls_clientes_nome on public.dls_clientes (nome);
create index if not exists idx_dls_demandas_numero on public.dls_demandas (numero);
create index if not exists idx_dls_demandas_cliente on public.dls_demandas (cliente_id);
create index if not exists idx_dls_demandas_responsavel on public.dls_demandas (responsavel_id);
create index if not exists idx_dls_demandas_status on public.dls_demandas (status);
create index if not exists idx_dls_demandas_prazo on public.dls_demandas (prazo);
create index if not exists idx_dls_demandas_data_requisicao on public.dls_demandas (data_requisicao);
create index if not exists idx_dls_demandas_reclamante on public.dls_demandas (reclamante);
create index if not exists idx_dls_demandas_prioridade on public.dls_demandas (prioridade);
create index if not exists idx_dls_logs_logged_at on public.dls_logs (logged_at);
create index if not exists idx_dls_logs_acao on public.dls_logs (acao);
create index if not exists idx_dls_logs_entidade on public.dls_logs (entidade);

create or replace function public.dls_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.dls_set_touched_at()
returns trigger
language plpgsql
as $$
begin
  new.touched_at = now();
  return new;
end;
$$;

drop trigger if exists dls_sequences_set_updated_at on public.dls_sequences;
create trigger dls_sequences_set_updated_at
before update on public.dls_sequences
for each row execute function public.dls_set_updated_at();

drop trigger if exists dls_calculistas_set_updated_at on public.dls_calculistas;
create trigger dls_calculistas_set_updated_at
before update on public.dls_calculistas
for each row execute function public.dls_set_updated_at();

drop trigger if exists dls_clientes_set_updated_at on public.dls_clientes;
create trigger dls_clientes_set_updated_at
before update on public.dls_clientes
for each row execute function public.dls_set_updated_at();

drop trigger if exists dls_demandas_set_touched_at on public.dls_demandas;
create trigger dls_demandas_set_touched_at
before update on public.dls_demandas
for each row execute function public.dls_set_touched_at();

create or replace function public.dls_next_sequence(
  sequence_name text default 'main',
  default_value integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_value integer;
begin
  insert into public.dls_sequences (name, current_value)
  values (sequence_name, default_value)
  on conflict (name) do nothing;

  update public.dls_sequences
     set current_value = current_value + 1,
         updated_at = now()
   where name = sequence_name
  returning current_value into next_value;

  return next_value;
end;
$$;

insert into public.dls_sequences (name, current_value)
values ('main', 100)
on conflict (name) do nothing;

alter table public.dls_sequences enable row level security;
alter table public.dls_calculistas enable row level security;
alter table public.dls_clientes enable row level security;
alter table public.dls_demandas enable row level security;
alter table public.dls_logs enable row level security;

drop policy if exists dls_sequences_browser_all on public.dls_sequences;
create policy dls_sequences_browser_all on public.dls_sequences
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_calculistas_browser_all on public.dls_calculistas;
create policy dls_calculistas_browser_all on public.dls_calculistas
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_clientes_browser_all on public.dls_clientes;
create policy dls_clientes_browser_all on public.dls_clientes
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_demandas_browser_all on public.dls_demandas;
create policy dls_demandas_browser_all on public.dls_demandas
for all to anon, authenticated using (true) with check (true);

drop policy if exists dls_logs_browser_all on public.dls_logs;
create policy dls_logs_browser_all on public.dls_logs
for all to anon, authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.dls_sequences,
  public.dls_calculistas,
  public.dls_clientes,
  public.dls_demandas,
  public.dls_logs
to anon, authenticated;
grant execute on function public.dls_next_sequence(text, integer) to anon, authenticated;

commit;
