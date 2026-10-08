-- ============================================================
-- FASE 1 — Escala por células + registo de alterações (instalação)
-- ------------------------------------------------------------
-- SÓ ACRESCENTA. Não altera nem apaga nada do que existe:
--   • cria tabelas novas (schedule_cells, schedule_log, app_settings, ...)
--   • guarda uma cópia integral de app_data em app_data_archive
--   • copia a escala para schedule_cells e VERIFICA turno a turno
-- A app continua a usar o armazenamento antigo até se correr o ficheiro
-- schedule-log-cutover.sql. Pode correr-se de novo sem problema.
-- Requer supabase-backups.sql já instalado (cópias automáticas).
-- ============================================================
do $$ begin
  if to_regprocedure('public._snapshot_state(text,text,jsonb)') is null then
    raise exception 'Instale primeiro supabase-backups.sql (cópias automáticas).';
  end if;
end $$;

-- 0. Cópia integral do que existe hoje (nunca é apagada nem alterada)
create table if not exists public.app_data_archive (
  archived_at timestamptz not null default now(),
  key text not null,
  value jsonb,
  note text
);
alter table public.app_data_archive enable row level security;   -- sem políticas: invisível para a app
insert into public.app_data_archive (key, value, note)
select key, value::jsonb, 'Antes da instalação da Fase 1' from public.app_data;

-- 1. Definições (modo de armazenamento da escala: 'blob' = antigo, 'cells' = novo)
create table if not exists public.app_settings (key text primary key, value text not null);
insert into public.app_settings values ('schedule_store', 'blob') on conflict (key) do nothing;
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);

-- 2. Uma linha por turno (dia + diurno/noturno), pessoas pela ordem Médico 1, Médico 2
create table if not exists public.schedule_cells (
  day date not null,
  shift text not null check (shift in ('day', 'night')),
  people text[] not null default '{}',
  rev bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (day, shift)
);
alter table public.schedule_cells enable row level security;
drop policy if exists schedule_cells_read on public.schedule_cells;
create policy schedule_cells_read on public.schedule_cells for select to authenticated using (true);
-- sem políticas de escrita: só as funções abaixo escrevem

-- 3. Registo de todas as alterações (só se acrescenta; nunca se altera nem apaga)
create table if not exists public.schedule_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  by_user uuid,
  by_name text,
  op_id uuid unique,               -- id da edição gerado no dispositivo: repetir = não faz nada
  batch_id uuid,                   -- edições feitas juntas (ex.: Auto-preencher)
  label text,                      -- 'Edição', 'Auto-preencher', 'Desfazer', ...
  day date not null,
  shift text not null,
  before text[] not null,
  after text[] not null,
  undo_of bigint references public.schedule_log(id)
);
create index if not exists schedule_log_at on public.schedule_log (at desc);
create index if not exists schedule_log_cell on public.schedule_log (day, shift, at);
alter table public.schedule_log enable row level security;
drop policy if exists schedule_log_read_admin on public.schedule_log;
create policy schedule_log_read_admin on public.schedule_log for select to authenticated
  using (public.current_app_role() = 'admin');

create sequence if not exists public.schedule_rev;

-- 4. Funções auxiliares ------------------------------------------------------
-- Chave de semana da app (segunda-feira 00:00 hora de Lisboa, em UTC)
create or replace function public._week_key(d date) returns text
language sql immutable as $$
  select to_char((date_trunc('week', d::timestamp) at time zone 'Europe/Lisbon') at time zone 'UTC', 'YYYY-MM-DD')
$$;

-- A escala antiga (blob) achatada: um valor por turno, lido da semana certa
-- (a mesma que a app lê). Entradas noutras semanas são ignoradas aqui.
create or replace function public._blob_cells(s jsonb)
returns table (day date, shift text, people text[])
language sql immutable as $$
  select left(t.key, 10)::date, substr(t.key, 12),
         array(select jsonb_array_elements_text(t.value))
  from jsonb_each(case when jsonb_typeof(s) = 'object' then s else '{}'::jsonb end) w,
       jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) t
  where t.key ~ '^\d{4}-\d{2}-\d{2}_(day|night)$'
    and jsonb_typeof(t.value) = 'array'
    and w.key = public._week_key(left(t.key, 10)::date)
$$;

-- Entradas da escala antiga que a app NÃO mostra (semana errada ou formato estranho)
create or replace function public._blob_orphans(s jsonb)
returns table (week_key text, shift_key text, value jsonb)
language sql immutable as $$
  select w.key, t.key, t.value
  from jsonb_each(case when jsonb_typeof(s) = 'object' then s else '{}'::jsonb end) w,
       jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) t
  where not (t.key ~ '^\d{4}-\d{2}-\d{2}_(day|night)$'
             and jsonb_typeof(t.value) = 'array'
             and w.key = public._week_key(left(t.key, 10)::date))
$$;

-- Diferenças entre a escala antiga e as células (vazio = iguais)
create or replace function public._cells_vs_blob()
returns table (day date, shift text, blob text[], cells text[])
language sql stable as $$
  with b as (select * from public._blob_cells((select value::jsonb from public.app_data where key = 'chbv_schedules'))
             where cardinality(people) > 0),
       c as (select day, shift, people from public.schedule_cells where cardinality(people) > 0)
  select coalesce(b.day, c.day), coalesce(b.shift, c.shift), b.people, c.people
  from b full join c on b.day = c.day and b.shift = c.shift
  where b.people is distinct from c.people
$$;

-- Escreve na escala antiga (blob) os turnos indicados, a partir das células,
-- para que a app antiga e as cópias de segurança continuem certas.
create or replace function public._sync_blob(p_cells jsonb)   -- [{day, shift}, ...]
returns void language plpgsql security definer set search_path = public as $$
declare s jsonb; r record; wk text; sk text;
begin
  select value::jsonb into s from app_data where key = 'chbv_schedules' for update;
  s := coalesce(s, '{}'::jsonb);
  for r in select c.day, c.shift, coalesce(sc.people, '{}') as people
           from jsonb_to_recordset(p_cells) as c(day date, shift text)
           left join schedule_cells sc on sc.day = c.day and sc.shift = c.shift loop
    wk := _week_key(r.day);
    sk := to_char(r.day, 'YYYY-MM-DD') || '_' || r.shift;
    if cardinality(r.people) = 0 then
      if s ? wk then s := jsonb_set(s, array[wk], (s->wk) - sk); end if;
    else
      if not (s ? wk) then s := s || jsonb_build_object(wk, '{}'::jsonb); end if;
      s := jsonb_set(s, array[wk, sk], to_jsonb(r.people));
    end if;
  end loop;
  update app_data set value = s where key = 'chbv_schedules';
end $$;

-- Aplica um conjunto de valores às células, regista cada alteração e
-- sincroniza a escala antiga. Uso interno.
create or replace function public._set_cells(p_items jsonb, p_label text, p_batch uuid, p_undo_of bigint default null)
returns int language plpgsql security definer set search_path = public as $$
declare it record; cur text[]; n int := 0; nm text; removed int := 0;
begin
  select name into nm from profiles where id = auth.uid();
  -- cópia de segurança se esta operação remove 4 ou mais turnos
  select coalesce(sum(greatest(cardinality(coalesce(sc.people, '{}')) - cardinality(i.people), 0)), 0) into removed
  from jsonb_to_recordset(p_items) as i(day date, shift text, people text[])
  left join schedule_cells sc on sc.day = i.day and sc.shift = i.shift;
  if removed >= 4 then
    perform _snapshot_state(format('Antes de %s (remove %s turnos)', lower(p_label), removed));
  end if;

  for it in select * from jsonb_to_recordset(p_items) as i(day date, shift text, people text[]) loop
    select people into cur from schedule_cells where day = it.day and shift = it.shift for update;
    cur := coalesce(cur, '{}');
    if cur is distinct from it.people then
      insert into schedule_cells (day, shift, people, rev, updated_at, updated_by)
      values (it.day, it.shift, it.people, nextval('schedule_rev'), now(), auth.uid())
      on conflict (day, shift) do update
        set people = excluded.people, rev = excluded.rev, updated_at = now(), updated_by = auth.uid();
      insert into schedule_log (by_user, by_name, batch_id, label, day, shift, before, after, undo_of)
      values (auth.uid(), nm, p_batch, p_label, it.day, it.shift, cur, it.people, p_undo_of);
      n := n + 1;
    end if;
  end loop;
  perform _sync_blob((select jsonb_agg(jsonb_build_object('day', day, 'shift', shift))
                      from jsonb_to_recordset(p_items) as i(day date, shift text)));
  return n;
end $$;

create or replace function public._require_admin() returns void
language plpgsql stable as $$
begin
  if public.current_app_role() is distinct from 'admin' then
    raise exception 'apenas administradores';
  end if;
end $$;

-- 5. Funções chamadas pela app ----------------------------------------------
-- Escala completa + modo + revisão atual
create or replace function public.get_schedule()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'mode', (select value from app_settings where key = 'schedule_store'),
    'rev',  (select coalesce(max(rev), 0) from schedule_cells),
    'cells', coalesce((select jsonb_agg(jsonb_build_array(to_char(day, 'YYYY-MM-DD'), shift, people))
                       from schedule_cells where cardinality(people) > 0), '[]'::jsonb))
  where auth.uid() is not null
$$;

-- Edições da app. Cada uma: {op_id, day, shift, expected, people}.
-- • op_id já registado → 'duplicate' (repetição; nada muda)
-- • célula diferente de 'expected' → 'conflict' (alguém mudou entretanto; nada muda nesta célula)
-- • caso contrário → 'ok'
create or replace function public.apply_schedule_changes(p_changes jsonb, p_label text default 'Edição')
returns jsonb language plpgsql security definer set search_path = public as $$
declare ch record; cur text[]; out jsonb := '[]'::jsonb; batch uuid := gen_random_uuid();
        nm text; removed int := 0; synced jsonb := '[]'::jsonb;
begin
  perform _require_admin();
  if (select value from app_settings where key = 'schedule_store') <> 'cells' then
    raise exception 'a escala ainda não está no modo novo';
  end if;
  select name into nm from profiles where id = auth.uid();

  select coalesce(sum(greatest(cardinality(coalesce(sc.people, '{}')) - cardinality(c.people), 0)), 0) into removed
  from jsonb_to_recordset(p_changes) as c(day date, shift text, people text[])
  left join schedule_cells sc on sc.day = c.day and sc.shift = c.shift;
  if removed >= 4 then
    perform _snapshot_state(format('Antes de %s (remove %s turnos)', lower(left(p_label, 60)), removed));
  end if;

  for ch in select * from jsonb_to_recordset(p_changes)
            as c(op_id uuid, day date, shift text, expected text[], people text[]) loop
    if ch.shift not in ('day', 'night') or ch.people is null or ch.expected is null then
      out := out || jsonb_build_object('op_id', ch.op_id, 'status', 'invalid');
      continue;
    end if;
    if ch.op_id is not null and exists (select 1 from schedule_log where op_id = ch.op_id) then
      out := out || jsonb_build_object('op_id', ch.op_id, 'status', 'duplicate');
      continue;
    end if;
    select people into cur from schedule_cells where day = ch.day and shift = ch.shift for update;
    cur := coalesce(cur, '{}');
    if cur is distinct from ch.expected then
      out := out || jsonb_build_object('op_id', ch.op_id, 'status', 'conflict',
                                       'day', ch.day, 'shift', ch.shift, 'current', to_jsonb(cur));
      continue;
    end if;
    if cur is distinct from ch.people then
      insert into schedule_cells (day, shift, people, rev, updated_at, updated_by)
      values (ch.day, ch.shift, ch.people, nextval('schedule_rev'), now(), auth.uid())
      on conflict (day, shift) do update
        set people = excluded.people, rev = excluded.rev, updated_at = now(), updated_by = auth.uid();
      insert into schedule_log (by_user, by_name, op_id, batch_id, label, day, shift, before, after)
      values (auth.uid(), nm, ch.op_id, batch, left(p_label, 60), ch.day, ch.shift, cur, ch.people);
      synced := synced || jsonb_build_object('day', ch.day, 'shift', ch.shift);
    end if;
    out := out || jsonb_build_object('op_id', ch.op_id, 'status', 'ok');
  end loop;
  if jsonb_array_length(synced) > 0 then perform _sync_blob(synced); end if;
  return jsonb_build_object('rev', (select coalesce(max(rev), 0) from schedule_cells), 'results', out);
end $$;

-- Lista de alterações (mais recentes primeiro)
create or replace function public.list_schedule_log(p_limit int default 200, p_before_id bigint default null)
returns setof public.schedule_log language sql stable security definer set search_path = public as $$
  select * from schedule_log
  where public.current_app_role() = 'admin'
    and (p_before_id is null or id < p_before_id)
  order by id desc limit least(greatest(p_limit, 1), 1000)
$$;

-- Desfazer uma alteração (ou um grupo inteiro). Só se a célula ainda estiver
-- como essa alteração a deixou; senão não faz nada e explica.
create or replace function public.undo_schedule_change(p_log_id bigint, p_whole_batch boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare e record; cur text[]; batch uuid := gen_random_uuid(); n int := 0; items jsonb := '[]'::jsonb;
begin
  perform _require_admin();
  for e in select * from schedule_log
           where (p_whole_batch and batch_id = (select batch_id from schedule_log where id = p_log_id))
              or id = p_log_id
           order by id desc loop
    select people into cur from schedule_cells where day = e.day and shift = e.shift;
    if coalesce(cur, '{}') is distinct from e.after then
      raise exception 'Não é possível desfazer: o turno % % foi alterado depois desta alteração.',
        to_char(e.day, 'DD/MM'), case e.shift when 'day' then 'diurno' else 'noturno' end;
    end if;
    items := items || jsonb_build_object('day', e.day, 'shift', e.shift, 'people', to_jsonb(e.before));
  end loop;
  if jsonb_array_length(items) = 0 then raise exception 'alteração não encontrada'; end if;
  n := _set_cells(items, 'Desfazer', batch, p_log_id);
  return n;
end $$;

-- Voltar a escala ao estado que tinha num momento (todas as alterações depois dele
-- são invertidas, e ficam elas próprias registadas — também se pode desfazer).
create or replace function public.revert_schedule_to(p_at timestamptz)
returns int language plpgsql security definer set search_path = public as $$
declare items jsonb;
begin
  perform _require_admin();
  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'shift', shift, 'people', to_jsonb(before))), '[]'::jsonb)
  into items
  from (select distinct on (day, shift) day, shift, before
        from schedule_log where at > p_at order by day, shift, id) first_after;
  return _set_cells(items, 'Voltar a ' || to_char(p_at at time zone 'Europe/Lisbon', 'DD/MM HH24:MI'), gen_random_uuid());
end $$;

-- Repor a escala de uma cópia de segurança (Histórico), registado como alterações.
create or replace function public.restore_schedule_from_history(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare s jsonb; items jsonb;
begin
  perform _require_admin();
  select schedules::jsonb into s from app_data_history where id = p_id;
  if s is null or jsonb_typeof(s) <> 'object' then raise exception 'cópia não encontrada ou inválida'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('day', coalesce(b.day, c.day), 'shift', coalesce(b.shift, c.shift),
                                               'people', to_jsonb(coalesce(b.people, '{}')))), '[]'::jsonb)
  into items
  from (select * from _blob_cells(s)) b
  full join (select day, shift from schedule_cells where cardinality(people) > 0) c
    on b.day = c.day and b.shift = c.shift;
  return _set_cells(items, 'Restaurar cópia #' || p_id, gen_random_uuid());
end $$;

-- Versões (como no Google Sheets): a escala tal como estava logo a seguir à
-- alteração nº p_id do registo (0 = antes de qualquer alteração registada).
create or replace function public._cells_after_log(p_id bigint)
returns table (day date, shift text, people text[])
language sql stable security definer set search_path = public as $$
  select coalesce(c.day, f.day), coalesce(c.shift, f.shift), coalesce(f.before, c.people)
  from schedule_cells c
  full join (select distinct on (day, shift) day, shift, before
             from schedule_log where id > p_id order by day, shift, id) f
    on f.day = c.day and f.shift = c.shift
$$;

create or replace function public.get_schedule_at_log(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return jsonb_build_object('cells', coalesce((
    select jsonb_agg(jsonb_build_array(to_char(day, 'YYYY-MM-DD'), shift, people))
    from _cells_after_log(p_id) where cardinality(people) > 0), '[]'::jsonb));
end $$;

-- Restaurar essa versão. Fica registado como alterações, por isso pode ser desfeito.
create or replace function public.revert_schedule_to_log(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare items jsonb; quando text;
begin
  perform _require_admin();
  select to_char(at at time zone 'Europe/Lisbon', 'DD/MM HH24:MI') into quando from schedule_log where id = p_id;
  select coalesce(jsonb_agg(jsonb_build_object('day', v.day, 'shift', v.shift, 'people', to_jsonb(v.people))), '[]'::jsonb)
  into items
  from _cells_after_log(p_id) v
  left join schedule_cells c on c.day = v.day and c.shift = v.shift
  where coalesce(c.people, '{}') is distinct from v.people;
  return _set_cells(items, 'Restaurar versão de ' || coalesce(quando, 'início'), gen_random_uuid());
end $$;

-- 6. Permissões
-- Tabelas novas: ler sim (com as regras acima); escrever diretamente nunca —
-- só através das funções. O arquivo não é acessível de todo pela app.
revoke all on public.schedule_cells, public.schedule_log, public.app_settings, public.app_data_archive from anon, authenticated;
grant select on public.schedule_cells, public.schedule_log, public.app_settings to authenticated;
revoke all on function public._sync_blob(jsonb) from public, anon, authenticated;
revoke all on function public._set_cells(jsonb, text, uuid, bigint) from public, anon, authenticated;
revoke all on function public._cells_vs_blob() from public, anon, authenticated;
revoke all on function public.get_schedule() from public, anon;
revoke all on function public.apply_schedule_changes(jsonb, text) from public, anon;
revoke all on function public.list_schedule_log(int, bigint) from public, anon;
revoke all on function public.undo_schedule_change(bigint, boolean) from public, anon;
revoke all on function public.revert_schedule_to(timestamptz) from public, anon;
revoke all on function public.restore_schedule_from_history(bigint) from public, anon;
revoke all on function public._cells_after_log(bigint) from public, anon, authenticated;
revoke all on function public.get_schedule_at_log(bigint) from public, anon;
revoke all on function public.revert_schedule_to_log(bigint) from public, anon;
grant execute on function public.get_schedule_at_log(bigint) to authenticated;
grant execute on function public.revert_schedule_to_log(bigint) to authenticated;
grant execute on function public.get_schedule() to authenticated;
grant execute on function public.apply_schedule_changes(jsonb, text) to authenticated;
grant execute on function public.list_schedule_log(int, bigint) to authenticated;
grant execute on function public.undo_schedule_change(bigint, boolean) to authenticated;
grant execute on function public.revert_schedule_to(timestamptz) to authenticated;
grant execute on function public.restore_schedule_from_history(bigint) to authenticated;

-- 7. Cópia inicial da escala para as células (só se ainda estiver vazia)
do $$
declare diffs int;
begin
  if not exists (select 1 from public.schedule_cells) then
    insert into public.schedule_cells (day, shift, people, rev)
    select day, shift, people, nextval('public.schedule_rev')
    from public._blob_cells((select value::jsonb from public.app_data where key = 'chbv_schedules'))
    where cardinality(people) > 0;
  end if;
  select count(*) into diffs from public._cells_vs_blob();
  if diffs > 0 then
    raise exception 'VERIFICAÇÃO FALHOU: % turnos diferentes entre a escala e a cópia. Nada foi instalado.', diffs;
  end if;
end $$;

-- 8. Relatório (para conferir)
select 'turnos copiados' as item, count(*)::text as valor from public.schedule_cells where cardinality(people) > 0
union all
select 'vagas preenchidas', sum(cardinality(people))::text from public.schedule_cells
union all
select 'diferenças (tem de ser 0)', count(*)::text from public._cells_vs_blob()
union all
select 'entradas antigas que a app não mostra (ficam guardadas, não copiadas)',
       count(*)::text from public._blob_orphans((select value::jsonb from public.app_data where key = 'chbv_schedules'))
union all
select 'modo da escala', value from public.app_settings where key = 'schedule_store';
