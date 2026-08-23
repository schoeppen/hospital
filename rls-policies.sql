-- ============================================================
-- Escalas CHBV — Políticas de segurança (RLS) do Supabase
-- ============================================================
-- Problema que isto resolve: hoje qualquer pessoa com a chave `anon` (que está
-- publicada no app.js, num repositório público) consegue LER e ESCREVER em
-- app_data sem fazer login — ou seja, apagar a escala toda.
--
-- Objetivo:
--   • ninguém sem sessão iniciada lê ou escreve nada
--   • admin        -> lê e escreve tudo
--   • tarefeiro    -> lê tudo; escreve APENAS a chave chbv_terceiros
--   • leitura      -> lê tudo; não escreve
--
-- APLICAR POR FASES, verificando entre cada uma (instruções no fim).
-- Se algo correr mal, a saída de emergência está no fim do ficheiro.
--
-- ============================================================
-- ESTADO ATUAL (aplicado e verificado em 2026-08-23)
-- ============================================================
--   FASE 1  função current_app_role()      -> APLICADA
--   FASE 2  app_data                        -> APLICADA. Sem sessão: ler devolve []
--                                              e escrever devolve HTTP 401.
--   FASE 3  app_data_history                -> APLICADA. Mantivemos de propósito a
--                                              política antiga que deixa qualquer sessão
--                                              LER o histórico: os tarefeiros já leem os
--                                              mesmos dados ao vivo em app_data, logo
--                                              restringir versões antigas não acrescenta nada.
--   FASE 4  profiles                        -> NÃO APLICADA. A tabela já tinha RLS de
--                                              antes (sem sessão devolve []). Mexer aqui
--                                              pode quebrar o registo de contas — ver avisos.
--
-- ⚠️  ARMADILHA QUE NOS CUSTOU TEMPO — LER ANTES DE MEXER:
-- As políticas RLS SOMAM-SE (são permissivas, em OR). Basta UMA a autorizar para
-- o acesso passar. O app_data tinha uma política antiga:
--
--     "Allow all"  |  ALL  |  {public}  |  using true  |  with check true
--
-- Com ela presente, ativar RLS e criar políticas novas não muda absolutamente nada
-- — tudo continua aberto, inclusive sem login. Antes de dar por concluída qualquer
-- fase, listar SEMPRE o que existe:
--
--     select policyname, cmd, roles from pg_policies where tablename = '<tabela>';
--
-- e apagar as permissivas antigas (atenção às aspas em nomes com espaços):
--
--     drop policy "Allow all" on public.<tabela>;


-- ------------------------------------------------------------
-- FASE 1 — função auxiliar que devolve o papel de quem chama
-- ------------------------------------------------------------
-- SECURITY DEFINER é essencial: a função lê `profiles`, e sem isto as políticas
-- de `profiles` que a usam entrariam em recursão infinita.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated;


-- ------------------------------------------------------------
-- FASE 2 — app_data  (o buraco principal)
-- ------------------------------------------------------------
alter table public.app_data enable row level security;

drop policy if exists app_data_select           on public.app_data;
drop policy if exists app_data_admin_all        on public.app_data;
drop policy if exists app_data_tarefeiro_update on public.app_data;
drop policy if exists app_data_tarefeiro_insert on public.app_data;

-- Ler: qualquer utilizador com sessão iniciada (a app precisa de todos os dados)
create policy app_data_select on public.app_data
  for select to authenticated
  using (true);

-- Admin: escreve tudo
create policy app_data_admin_all on public.app_data
  for all to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

-- Tarefeiro: só pode tocar no bloco dos tarefeiros (a sua disponibilidade).
-- Precisa de UPDATE e de INSERT porque a app usa upsert: em Postgres, um
-- "INSERT ... ON CONFLICT DO UPDATE" exige política de INSERT para a tentativa
-- de inserção, mesmo que a linha já exista e acabe por seguir o caminho do UPDATE.
create policy app_data_tarefeiro_update on public.app_data
  for update to authenticated
  using      (public.current_app_role() = 'tarefeiro' and key = 'chbv_terceiros')
  with check (public.current_app_role() = 'tarefeiro' and key = 'chbv_terceiros');

create policy app_data_tarefeiro_insert on public.app_data
  for insert to authenticated
  with check (public.current_app_role() = 'tarefeiro' and key = 'chbv_terceiros');


-- ------------------------------------------------------------
-- FASE 3 — app_data_history  (cópias de segurança)
-- ------------------------------------------------------------
alter table public.app_data_history enable row level security;

drop policy if exists history_insert       on public.app_data_history;
drop policy if exists history_select_admin on public.app_data_history;
drop policy if exists history_delete_admin on public.app_data_history;

-- Qualquer sessão pode gravar uma versão (a app faz isto ao guardar)
create policy history_insert on public.app_data_history
  for insert to authenticated
  with check (true);

-- Só o admin pode ver e apagar versões (contêm a base de dados inteira).
-- Nota: a app tenta apagar versões com mais de 30 dias ao guardar; se quem
-- guardar não for admin, essa limpeza é simplesmente ignorada (sem erro visível).
create policy history_select_admin on public.app_data_history
  for select to authenticated
  using (public.current_app_role() = 'admin');

create policy history_delete_admin on public.app_data_history
  for delete to authenticated
  using (public.current_app_role() = 'admin');


-- ------------------------------------------------------------
-- FASE 4 — profiles  (a mais delicada: mexe no login)
-- ------------------------------------------------------------
-- ATENÇÃO: só aplicar depois de confirmar as fases anteriores. Se a criação de
-- contas deixar de funcionar, o mais provável é o gatilho que cria o perfil no
-- registo não ser SECURITY DEFINER — nesse caso volta atrás nesta fase.
alter table public.profiles enable row level security;

drop policy if exists profiles_select_self   on public.profiles;
drop policy if exists profiles_select_admin  on public.profiles;
drop policy if exists profiles_update_admin  on public.profiles;
drop policy if exists profiles_delete_admin  on public.profiles;

-- Cada um vê o seu perfil (necessário no login para descobrir o papel)
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- O admin vê todos (tab Utilizadores)
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.current_app_role() = 'admin');

-- IMPORTANTE: só o admin muda papéis. Sem isto, um tarefeiro podia
-- pôr-se a si próprio como admin com uma linha na consola do browser.
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using      (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.current_app_role() = 'admin');


-- ------------------------------------------------------------
-- Rever a função de eliminar utilizadores
-- ------------------------------------------------------------
-- A app chama db.rpc('delete_user_completely'). Se for SECURITY DEFINER e
-- estiver acessível a `authenticated`, qualquer tarefeiro pode apagar contas.
-- Ver quem pode executá-la:
--
--   select p.proname, p.prosecdef as security_definer,
--          pg_get_functiondef(p.oid) as definicao
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'delete_user_completely';
--
-- Se não tiver verificação de papel lá dentro, restringir:
--   revoke all on function public.delete_user_completely(uuid) from public, anon, authenticated;
--   grant execute on function public.delete_user_completely(uuid) to authenticated;
--   -- e acrescentar no início do corpo da função:
--   --   if public.current_app_role() <> 'admin' then
--   --     raise exception 'apenas administradores';
--   --   end if;


-- ------------------------------------------------------------
-- VERIFICAR (correr depois de aplicar)
-- ------------------------------------------------------------
-- 1. Que tabelas têm RLS ativo:
--      select relname, relrowsecurity from pg_class
--      where relname in ('app_data','app_data_history','profiles');
--
-- 2. Políticas existentes:
--      select tablename, policyname, cmd, roles from pg_policies
--      where schemaname = 'public' order by tablename, policyname;
--
-- 3. Teste externo (deve passar a FALHAR ou devolver vazio) — no terminal:
--      curl -s "https://gptovrbtiosdfqawwwcb.supabase.co/rest/v1/app_data?select=key" \
--        -H "apikey: <CHAVE_ANON>"
--    Antes das políticas devolvia as 4 chaves. Depois deve devolver [].


-- ------------------------------------------------------------
-- SAÍDA DE EMERGÊNCIA
-- ------------------------------------------------------------
-- Se a app deixar de gravar ou de entrar, desativa o RLS na tabela em causa e
-- volta ao estado anterior (fica outra vez aberta, mas funcional):
--
--   alter table public.app_data disable row level security;
--   alter table public.app_data_history disable row level security;
--   alter table public.profiles disable row level security;
