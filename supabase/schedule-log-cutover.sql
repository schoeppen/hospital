-- ============================================================
-- FASE 1 — Passar a app para o modo novo (células + registo)
-- Só depois de schedule-log-install.sql e da nova versão da app estar publicada.
-- Tudo numa transação: se a verificação falhar, nada muda.
-- ============================================================
begin;

-- 0. Nenhuma outra regra pode deixar a app escrever diretamente na escala antiga
do $$
declare extra text;
begin
  select string_agg(policyname || ' (' || cmd || ')', ', ') into extra
  from pg_policies
  where schemaname = 'public' and tablename = 'app_data'
    and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
    and policyname not in ('app_data_admin_all', 'app_data_tarefeiro_update', 'app_data_tarefeiro_insert');
  if extra is not null then
    raise exception 'NADA FOI ALTERADO. Há outras regras de escrita em app_data: %. Envie esta mensagem.', extra;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'app_data'
        and policyname in ('app_data_tarefeiro_update', 'app_data_tarefeiro_insert')
        and coalesce(qual, '') || coalesce(with_check, '') not like '%chbv_terceiros%') > 0 then
    raise exception 'NADA FOI ALTERADO. As regras dos tarefeiros não estão limitadas a chbv_terceiros.';
  end if;
end $$;

-- 1. Cópia de segurança antes da mudança
select public._snapshot_state('Antes de passar a escala para o modo novo');
insert into public.app_data_archive (key, value, note)
select key, value::jsonb, 'Antes da mudança para o modo novo' from public.app_data;

-- 2. Trazer para as células o que a app antiga tenha alterado desde a instalação
--    (cada diferença fica registada como alteração, por isso pode ser desfeita)
select public._set_cells(
  coalesce((select jsonb_agg(jsonb_build_object('day', day, 'shift', shift, 'people', to_jsonb(coalesce(blob, '{}'))))
            from public._cells_vs_blob()), '[]'::jsonb),
  'Sincronização com a app antiga', gen_random_uuid());

-- 3. Verificar turno a turno: tem de ser 0 diferenças
do $$
declare diffs int;
begin
  select count(*) into diffs from public._cells_vs_blob();
  if diffs > 0 then
    raise exception 'VERIFICAÇÃO FALHOU: % turnos diferentes. Nada foi alterado.', diffs;
  end if;
end $$;

-- 4. Ligar o modo novo
update public.app_settings set value = 'cells' where key = 'schedule_store';

-- 5. A escala antiga (blob) passa a ser escrita só pela base de dados, que a mantém
--    sempre igual às células. Uma app antiga ainda aberta já não a consegue estragar.
drop policy if exists app_data_admin_all on public.app_data;
create policy app_data_admin_all on public.app_data
  for all to authenticated
  using      (public.current_app_role() = 'admin' and key <> 'chbv_schedules')
  with check (public.current_app_role() = 'admin' and key <> 'chbv_schedules');

commit;

select 'modo' as item, value as valor from public.app_settings where key = 'schedule_store'
union all
select 'diferenças (tem de ser 0)', count(*)::text from public._cells_vs_blob();
