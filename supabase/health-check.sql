-- ============================================================
-- Verificação completa (SÓ LEITURA — não altera nada)
-- ✅ = certo · ❌ = problema (enviar o resultado) · ℹ️ = informação
-- ============================================================
with
fn(name) as (values ('get_schedule'), ('apply_schedule_changes'), ('list_schedule_log'), ('undo_schedule_change'),
  ('revert_schedule_to_log'), ('get_schedule_at_log'), ('restore_schedule_from_history'), ('_set_cells'),
  ('_sync_blob'), ('_snapshot_state'), ('_app_data_before_change'), ('list_history'), ('snapshot_app_data')),
people as (
  select p->>'id' as id from app_data a, jsonb_array_elements(a.value::jsonb) p
  where a.key in ('chbv_doctors', 'chbv_terceiros')),
last_log as (
  select distinct on (day, shift) day, shift, after from schedule_log order by day, shift, id desc),
checks(n, check_name, result, ok) as (
  select 1, 'Modo da escala', (select value from app_settings where key = 'schedule_store'),
         (select value from app_settings where key = 'schedule_store') = 'cells'
  union all
  select 2, 'Diferenças entre escala nova e antiga', (select count(*)::text from _cells_vs_blob()),
         (select count(*) from _cells_vs_blob()) = 0
  union all
  select 3, 'Turnos na escala antiga fora da semana certa',
         (select count(*)::text from _blob_orphans((select value::jsonb from app_data where key = 'chbv_schedules'))),
         (select count(*) from _blob_orphans((select value::jsonb from app_data where key = 'chbv_schedules'))) = 0
  union all
  select 4, 'Cada turno igual à sua última alteração registada',
         (select count(*)::text || ' diferentes' from schedule_cells c join last_log l using (day, shift) where l.after is distinct from c.people),
         (select count(*) from schedule_cells c join last_log l using (day, shift) where l.after is distinct from c.people) = 0
  union all
  select 5, 'Funções instaladas', (select count(*)::text || ' de ' || (select count(*) from fn) from fn
           where exists (select 1 from pg_proc where proname = fn.name and pronamespace = 'public'::regnamespace)),
         (select count(*) from fn where not exists (select 1 from pg_proc where proname = fn.name and pronamespace = 'public'::regnamespace)) = 0
  union all
  select 6, 'Funções corrigidas (passo 4)',
         case when pg_get_functiondef('public.apply_schedule_changes(jsonb,text)'::regprocedure) like '%one writer at a time%'
              and pg_get_functiondef('public.undo_schedule_change(bigint,boolean)'::regprocedure) like '%for update%' then 'sim' else 'não' end,
         pg_get_functiondef('public.apply_schedule_changes(jsonb,text)'::regprocedure) like '%one writer at a time%'
  union all
  select 7, 'Cópia automática (trigger) ativa',
         coalesce((select case tgenabled when 'O' then 'ativa' else 'desligada' end from pg_trigger
                   where tgname = 'app_data_snapshot' and tgrelid = 'public.app_data'::regclass), 'em falta'),
         exists (select 1 from pg_trigger where tgname = 'app_data_snapshot' and tgrelid = 'public.app_data'::regclass and tgenabled = 'O')
  union all
  select 8, 'App não pode escrever a escala antiga diretamente',
         (select coalesce(with_check, '') from pg_policies where tablename = 'app_data' and policyname = 'app_data_admin_all'),
         (select coalesce(with_check, '') from pg_policies where tablename = 'app_data' and policyname = 'app_data_admin_all') like '%chbv_schedules%'
  union all
  select 9, 'Outras regras de escrita em app_data',
         coalesce((select string_agg(policyname, ', ') from pg_policies where schemaname = 'public' and tablename = 'app_data'
                   and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
                   and policyname not in ('app_data_admin_all', 'app_data_tarefeiro_update', 'app_data_tarefeiro_insert')), 'nenhuma'),
         not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_data'
                   and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
                   and policyname not in ('app_data_admin_all', 'app_data_tarefeiro_update', 'app_data_tarefeiro_insert'))
  union all
  select 10, 'Segurança (RLS) ligada nas tabelas',
         (select string_agg(relname || case when relrowsecurity then ' ✓' else ' ✗' end, ', ' order by relname) from pg_class
          where relnamespace = 'public'::regnamespace and relname in ('app_data', 'app_data_history', 'schedule_cells',
                'schedule_log', 'app_settings', 'app_data_archive', 'app_data_backup_manual', 'profiles')),
         not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and not relrowsecurity
                and relname in ('app_data', 'app_data_history', 'schedule_cells', 'schedule_log', 'app_settings',
                                'app_data_archive', 'app_data_backup_manual', 'profiles'))
  union all
  select 11, 'Utilizadores não escrevem turnos/registo diretamente',
         case when has_table_privilege('authenticated', 'public.schedule_cells', 'INSERT,UPDATE,DELETE')
                or has_table_privilege('authenticated', 'public.schedule_log', 'INSERT,UPDATE,DELETE') then 'podem' else 'não podem' end,
         not (has_table_privilege('authenticated', 'public.schedule_cells', 'INSERT,UPDATE,DELETE')
              or has_table_privilege('authenticated', 'public.schedule_log', 'INSERT,UPDATE,DELETE'))
  union all
  select 12, 'Funções internas fechadas aos utilizadores',
         case when has_function_privilege('authenticated', 'public._set_cells(jsonb,text,uuid,bigint)', 'EXECUTE')
                or has_function_privilege('authenticated', 'public._sync_blob(jsonb)', 'EXECUTE')
                or has_function_privilege('authenticated', 'public._snapshot_state(text,text,jsonb)', 'EXECUTE') then 'abertas' else 'fechadas' end,
         not (has_function_privilege('authenticated', 'public._set_cells(jsonb,text,uuid,bigint)', 'EXECUTE')
              or has_function_privilege('authenticated', 'public._sync_blob(jsonb)', 'EXECUTE')
              or has_function_privilege('authenticated', 'public._snapshot_state(text,text,jsonb)', 'EXECUTE'))
  union all
  select 13, 'Cópias de segurança: ninguém as apaga pela app',
         coalesce((select string_agg(policyname, ', ') from pg_policies where tablename = 'app_data_history' and cmd in ('DELETE', 'ALL')), 'nenhuma regra de apagar'),
         not exists (select 1 from pg_policies where tablename = 'app_data_history' and cmd in ('DELETE', 'ALL'))
  union all
  select 14, 'Só o admin muda papéis (profiles)',
         coalesce((select string_agg(policyname, ', ') from pg_policies where tablename = 'profiles' and cmd in ('UPDATE', 'ALL')), 'nenhuma'),
         not exists (select 1 from pg_policies where tablename = 'profiles' and cmd in ('UPDATE', 'ALL')
                     and coalesce(qual, '') not like '%admin%')
  union all
  select 15, 'Cópia de segurança mais recente',
         coalesce((select to_char(max(saved_at) at time zone 'Europe/Lisbon', 'DD/MM HH24:MI') || ' · ' || count(*) || ' cópias' from app_data_history), 'nenhuma'),
         (select count(*) from app_data_history) > 0
  union all
  select 16, 'Cópias completas guardadas (passo 1 e instalação)',
         (select count(*)::text from app_data_backup_manual) || ' + ' || (select count(*)::text from app_data_archive) || ' linhas',
         (select count(*) from app_data_backup_manual) >= 4 and (select count(*) from app_data_archive) >= 4
  union all
  select 17, 'Turnos com pessoa repetida',
         (select count(*)::text from schedule_cells where cardinality(people) <> (select count(distinct x) from unnest(people) x)),
         (select count(*) from schedule_cells where cardinality(people) <> (select count(distinct x) from unnest(people) x)) = 0
  union all
  select 18, 'Turnos com pessoa que já não existe (médico/tarefeiro apagado)',
         (select count(*)::text from schedule_cells c where exists (select 1 from unnest(c.people) x where x not in (select id from people))),
         null
  union all
  select 19, 'Turnos com mais de 2 pessoas',
         (select count(*)::text from schedule_cells where cardinality(people) > 2), null
  union all
  select 20, 'Registo de alterações',
         (select count(*) || ' alterações · ' || count(*) filter (where by_name is null) || ' sem nome (sincronização)' from schedule_log), null
)
select n as "#", check_name as "verificação", result as "resultado",
       case when ok is null then 'ℹ️' when ok then '✅' else '❌' end as "estado"
from checks order by n;
