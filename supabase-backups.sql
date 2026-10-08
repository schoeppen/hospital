-- ============================================================
-- Cópias de segurança feitas pela BASE DE DADOS (não pelos dispositivos)
-- Correr uma vez no Supabase → SQL Editor. Pode voltar a correr-se sem problema.
-- ============================================================

-- Motivo de cada cópia (aparece no Histórico)
alter table public.app_data_history add column if not exists reason text;

-- Turnos preenchidos numa escala { semana: { turno: [ids] } }
create or replace function public._slot_count(s jsonb)
returns int language sql immutable as $$
  select coalesce(sum(case when jsonb_typeof(t.value) = 'array'
                           then jsonb_array_length(t.value) else 0 end), 0)::int
  from jsonb_each(case when jsonb_typeof(s) = 'object' then s else '{}'::jsonb end) w,
       jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) t
$$;

-- Grava o estado ATUAL do servidor (opcionalmente com o valor antigo de uma chave
-- que está a ser alterada). Uma cópia por transação no máximo.
-- Limpeza com o relógio do SERVIDOR: apaga > 30 dias, mas guarda sempre as 50 mais recentes.
create or replace function public._snapshot_state(p_reason text, p_key text default null, p_old jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if exists (select 1 from app_data_history where saved_at = now()) then
    return null;   -- já há uma cópia desta mesma transação
  end if;
  insert into app_data_history (doctors, schedules, terceiros, rotations, reason, saved_at)
  select case when p_key = 'chbv_doctors'   then p_old else (select value::jsonb from app_data where key = 'chbv_doctors')   end,
         case when p_key = 'chbv_schedules' then p_old else (select value::jsonb from app_data where key = 'chbv_schedules') end,
         case when p_key = 'chbv_terceiros' then p_old else (select value::jsonb from app_data where key = 'chbv_terceiros') end,
         case when p_key = 'chbv_rotations' then p_old else (select value::jsonb from app_data where key = 'chbv_rotations') end,
         p_reason, now()
  returning id into new_id;
  delete from app_data_history
   where saved_at < now() - interval '30 days'
     and id not in (select id from app_data_history order by saved_at desc limit 50);
  return new_id;
end $$;

-- Antes de cada alteração aos dados: cópia automática de hora a hora, e SEMPRE
-- antes de uma alteração que remove 4 ou mais turnos, ou remove médicos/tarefeiros.
create or replace function public._app_data_before_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_v jsonb := OLD.value::jsonb;
  new_v jsonb := case when TG_OP = 'DELETE' then null else NEW.value::jsonb end;
  removed int := 0;
  last_at timestamptz;
begin
  if OLD.key not in ('chbv_doctors', 'chbv_schedules', 'chbv_terceiros', 'chbv_rotations')
     or (TG_OP = 'UPDATE' and new_v is not distinct from old_v) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  if OLD.key = 'chbv_schedules' then
    removed := public._slot_count(old_v) - public._slot_count(new_v);
  elsif OLD.key in ('chbv_doctors', 'chbv_terceiros') then
    removed := (case when jsonb_typeof(old_v) = 'array' then jsonb_array_length(old_v) else 0 end)
             - (case when jsonb_typeof(new_v) = 'array' then jsonb_array_length(new_v) else 0 end);
  end if;

  if TG_OP = 'DELETE' then
    perform public._snapshot_state('Antes de apagar dados', OLD.key, old_v);
  elsif OLD.key = 'chbv_schedules' and removed >= 4 then
    perform public._snapshot_state(format('Antes de remover %s turnos', removed), OLD.key, old_v);
  elsif OLD.key = 'chbv_doctors' and removed >= 1 then
    perform public._snapshot_state('Antes de remover médico', OLD.key, old_v);
  elsif OLD.key = 'chbv_terceiros' and removed >= 1 then
    perform public._snapshot_state('Antes de remover tarefeiro', OLD.key, old_v);
  else
    select max(saved_at) into last_at from app_data_history;
    if last_at is null or last_at < now() - interval '1 hour' then
      perform public._snapshot_state('Automática', OLD.key, old_v);
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

drop trigger if exists app_data_snapshot on public.app_data;
create trigger app_data_snapshot
  before update or delete on public.app_data
  for each row execute function public._app_data_before_change();

-- Chamadas pela app (só admin):
-- cópia do estado do servidor antes de restaurar
create or replace function public.snapshot_app_data(p_reason text)
returns bigint language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if public.current_app_role() is distinct from 'admin' then
    raise exception 'apenas administradores';
  end if;
  insert into app_data_history (doctors, schedules, terceiros, rotations, reason)
  select (select value::jsonb from app_data where key = 'chbv_doctors'),
         (select value::jsonb from app_data where key = 'chbv_schedules'),
         (select value::jsonb from app_data where key = 'chbv_terceiros'),
         (select value::jsonb from app_data where key = 'chbv_rotations'),
         left(p_reason, 100)
  returning id into new_id;
  return new_id;
end $$;

-- lista do Histórico com o nº de turnos por mês de cada cópia
create or replace function public.list_history()
returns table (id bigint, saved_at timestamptz, reason text, slots jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_app_role() is distinct from 'admin' then
    raise exception 'apenas administradores';
  end if;
  return query
  select h.id::bigint, h.saved_at, h.reason,
         coalesce((select jsonb_object_agg(m, n) from (
            select left(t.key, 7) as m, sum(jsonb_array_length(t.value)) as n
            from jsonb_each(case when jsonb_typeof(h.schedules::jsonb) = 'object' then h.schedules::jsonb else '{}' end) w,
                 jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}' end) t
            where jsonb_typeof(t.value) = 'array'
            group by 1) x), '{}'::jsonb)
  from app_data_history h
  order by h.saved_at desc
  limit 500;
end $$;

revoke all on function public._slot_count(jsonb) from public, anon;
revoke all on function public._snapshot_state(text, text, jsonb) from public, anon, authenticated;
revoke all on function public._app_data_before_change() from public, anon, authenticated;
revoke all on function public.snapshot_app_data(text) from public, anon;
revoke all on function public.list_history() from public, anon;
grant execute on function public.snapshot_app_data(text) to authenticated;
grant execute on function public.list_history() to authenticated;

-- Permissões das cópias: só o admin as cria pela app; ninguém as apaga pela app
-- (a limpeza é feita pela própria base de dados).
drop policy if exists history_insert on public.app_data_history;
drop policy if exists "Write/admin can insert history" on public.app_data_history;
drop policy if exists history_delete_admin on public.app_data_history;
drop policy if exists history_insert_admin on public.app_data_history;
create policy history_insert_admin on public.app_data_history
  for insert to authenticated
  with check (public.current_app_role() = 'admin');

-- Cópia inicial do estado atual, e verificação
select public._snapshot_state('Cópia inicial (backups automáticos ativados)') as nova_copia;
select id, saved_at, reason from public.app_data_history order by saved_at desc limit 3;
