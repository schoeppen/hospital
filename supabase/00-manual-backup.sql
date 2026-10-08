-- PASSO 1 — Cópia completa de segurança (só lê e copia; não altera nada)
create table if not exists public.app_data_backup_manual (
  copied_at timestamptz not null default now(),
  key text not null,
  value jsonb
);
alter table public.app_data_backup_manual enable row level security;   -- invisível para a app
insert into public.app_data_backup_manual (key, value)
select key, value::jsonb from public.app_data;

-- Conferir: deve mostrar as 4 chaves e os turnos de Out/Nov (124 e 109)
select key, copied_at,
       case when key = 'chbv_schedules' then
         (select string_agg(m || ': ' || n, ', ' order by m) from (
            select left(t.key, 7) m, sum(jsonb_array_length(t.value)) n
            from jsonb_each(value) w, jsonb_each(w.value) t
            where t.key like '2026-1%' and jsonb_typeof(t.value) = 'array' group by 1) x)
       else jsonb_array_length(case when jsonb_typeof(value) = 'array' then value else '[]' end)::text || ' registos' end as conteudo
from public.app_data_backup_manual
where copied_at = (select max(copied_at) from public.app_data_backup_manual)
order by key;
