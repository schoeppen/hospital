-- ============================================================
-- FASE 1 — VOLTAR ATRÁS (para a app antiga). Não se perde nada:
-- a escala antiga foi sempre mantida igual às células.
-- Depois de correr isto, publicar de novo a versão anterior da app.
-- ============================================================
begin;
select public._snapshot_state('Antes de voltar ao modo antigo');
update public.app_settings set value = 'blob' where key = 'schedule_store';
drop policy if exists app_data_admin_all on public.app_data;
create policy app_data_admin_all on public.app_data
  for all to authenticated
  using      (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');
commit;
select value as modo from public.app_settings where key = 'schedule_store';
