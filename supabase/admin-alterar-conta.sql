-- ============================================================
-- O admin altera o email e/ou a palavra-passe de uma conta, a partir da app
-- (Utilizadores → Alterar). Correr uma vez no Supabase → SQL Editor.
-- Pode voltar a correr-se sem problema.
-- ============================================================
--
-- • Só funciona para contas com o papel 'admin'.
-- • Email: tem de ter formato válido e não pode estar a ser usado por outra conta.
--   A ficha de médico ou tarefeiro que tinha o email antigo passa a ter o novo, para
--   a conta continuar ligada à ficha.
-- • Palavra-passe: mínimo 6 caracteres.
-- • Tudo ou nada: se algo falhar, nada fica alterado.
-- ============================================================

create or replace function public.admin_alterar_conta(p_user uuid, p_email text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_antigo text;
  v_novo   text := lower(trim(coalesce(p_email, '')));
  v_fichas int := 0;
  v_n      int;
  v_key    text;
  v_val    jsonb;
begin
  if public.current_app_role() is distinct from 'admin' then
    raise exception 'Só administradores podem alterar contas.';
  end if;

  select lower(email) into v_antigo from auth.users where id = p_user;
  if not found then
    raise exception 'Conta não encontrada.';
  end if;

  if v_novo = '' and coalesce(p_password, '') = '' then
    raise exception 'Nada para alterar.';
  end if;

  -- Email ----------------------------------------------------------------------
  if v_novo <> '' and v_novo is distinct from v_antigo then
    if v_novo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Email inválido: %', v_novo;
    end if;
    if exists (select 1 from auth.users where lower(email) = v_novo and id <> p_user) then
      raise exception 'O email % já é usado por outra conta.', v_novo;
    end if;

    update auth.users
       set email = v_novo, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
     where id = p_user;
    update auth.identities
       set identity_data = identity_data || jsonb_build_object('email', v_novo), updated_at = now()
     where user_id = p_user and provider = 'email';
    update public.profiles set email = v_novo where id = p_user;

    -- Fichas (médicos e tarefeiros) ligadas pelo email antigo passam ao novo
    if v_antigo is not null and v_antigo <> '' then
      foreach v_key in array array['chbv_doctors', 'chbv_terceiros'] loop
        select count(*) into v_n
          from app_data a, jsonb_array_elements(a.value::jsonb) e
         where a.key = v_key and lower(trim(coalesce(e->>'email', ''))) = v_antigo;
        if v_n > 0 then
          select jsonb_agg(case when lower(trim(coalesce(e->>'email', ''))) = v_antigo
                                then e || jsonb_build_object('email', v_novo) else e end order by o)
            into v_val
            from app_data a, jsonb_array_elements(a.value::jsonb) with ordinality as x(e, o)
           where a.key = v_key;
          if (select data_type from information_schema.columns
               where table_schema = 'public' and table_name = 'app_data' and column_name = 'value') = 'jsonb' then
            update app_data set value = v_val where key = v_key;
          else
            update app_data set value = v_val::json where key = v_key;
          end if;
          v_fichas := v_fichas + v_n;
        end if;
      end loop;
    end if;
  end if;

  -- Palavra-passe ---------------------------------------------------------------
  if coalesce(p_password, '') <> '' then
    if length(p_password) < 6 then
      raise exception 'A palavra-passe tem de ter pelo menos 6 caracteres.';
    end if;
    update auth.users
       set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
     where id = p_user;
  end if;

  return jsonb_build_object('email', (select email from auth.users where id = p_user), 'fichas', v_fichas);
end $$;

revoke all on function public.admin_alterar_conta(uuid, text, text) from public, anon;
grant execute on function public.admin_alterar_conta(uuid, text, text) to authenticated;

select 'função instalada' as verificacao, proname, prosecdef as security_definer
  from pg_proc where proname = 'admin_alterar_conta';
