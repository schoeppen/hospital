-- ============================================================
-- Médicos marcam as suas próprias indisponibilidades e férias
-- Correr no Supabase → SQL Editor. Pode voltar a correr-se sem problema
-- (substitui a versão anterior, que só tinha indisponibilidades).
-- ============================================================
--
-- O que faz:
--   1. Acrescenta o papel 'medico' aos papéis permitidos.
--   2. Cria UMA função que deixa um médico marcar ou retirar indisponibilidade ou
--      férias no seu próprio registo — e só nisso. Aceita um dia ou um intervalo.
--
-- Porque é uma função e não uma regra de escrita:
--   Os médicos estão todos guardados num único bloco (chbv_doctors). Uma regra de
--   escrita sobre esse bloco deixaria qualquer médico alterar a ficha de qualquer
--   colega (limite de horas, "pode 24h", indisponibilidades dos outros). A função
--   descobre quem é o médico pelo email da sessão e só toca nos campos
--   monthlyUnavailability e monthlyVacation dele.
--
--   Também não acrescenta nenhuma regra de escrita a app_data, por isso não interfere
--   com schedule-log-cutover.sql, e as cópias automáticas (supabase-backups.sql)
--   continuam a cobrir estas alterações, porque ficam dentro de chbv_doctors.
--
-- O que a função garante, no servidor (não só no ecrã):
--   • só funciona para contas com o papel 'medico'
--   • o médico é identificado pelo email da sessão — não pode escolher outro
--   • não aceita dias que já passaram, nem mais de 12 meses à frente, nem
--     intervalos de mais de 62 dias
--   • RECUSA meses cuja escala já foi feita (qualquer turno preenchido nesse mês)
--   • um turno é OU indisponível OU férias (marcar um retira o outro), como no
--     ecrã do administrador
--   • regista cada alteração (quando, marcou/retirou, o quê, que dias, que turno)
-- ============================================================


-- 1. Papel 'medico' -------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('read', 'admin', 'tarefeiro', 'medico'));


-- 2. Função ---------------------------------------------------------------------
-- A versão anterior (só indisponibilidades, um dia de cada vez) deixa de ser usada.
drop function if exists public.medico_indisponibilidade(date, text, boolean);

-- Aplica uma marcação ao registo de UM médico (só os mapas de indisponibilidade e
-- férias). Usada pela função abaixo e pela proteção (trigger) no fim do ficheiro.
create or replace function public._medico_aplica(
  p_doc jsonb, p_de date, p_ate date, p_turno text, p_tipo text, p_marcar boolean)
returns jsonb language plpgsql immutable as $$
declare
  v_campo text := case when p_tipo = 'ferias' then 'monthlyVacation' else 'monthlyUnavailability' end;
  v_outro text := case when p_tipo = 'ferias' then 'monthlyUnavailability' else 'monthlyVacation' end;
  v_alvo  jsonb := case when jsonb_typeof(p_doc->v_campo) = 'object' then p_doc->v_campo else '{}'::jsonb end;
  v_outr  jsonb := case when jsonb_typeof(p_doc->v_outro) = 'object' then p_doc->v_outro else '{}'::jsonb end;
  v_dia   jsonb;
  v_od    jsonb;
  v_dk    text;
  d       date := p_de;
  t       text;
begin
  while d <= p_ate loop
    v_dk  := to_char(d, 'YYYY-MM-DD');
    v_dia := case when jsonb_typeof(v_alvo->v_dk) = 'object' then v_alvo->v_dk else '{}'::jsonb end;
    v_od  := case when jsonb_typeof(v_outr->v_dk) = 'object' then v_outr->v_dk else '{}'::jsonb end;
    foreach t in array (case when p_turno = 'both' then array['day','night'] else array[p_turno] end) loop
      if p_marcar then
        v_dia := v_dia || jsonb_build_object(t, true);
        v_od  := v_od - t;          -- um turno é indisponível OU férias
      else
        v_dia := v_dia - t;
      end if;
    end loop;
    v_alvo := case when v_dia = '{}'::jsonb then v_alvo - v_dk else jsonb_set(v_alvo, array[v_dk], v_dia, true) end;
    v_outr := case when v_od  = '{}'::jsonb then v_outr - v_dk else jsonb_set(v_outr, array[v_dk], v_od,  true) end;
    d := d + 1;
  end loop;
  return jsonb_set(jsonb_set(p_doc, array[v_campo], v_alvo, true), array[v_outro], v_outr, true);
end $$;

-- p_de, p_ate: primeiro e último dia (iguais para um só dia)
-- p_turno:     'day', 'night' ou 'both' (dia inteiro)
-- p_tipo:      'indisp' (indisponível) ou 'ferias'
-- p_marcar:    true = marcar, false = retirar
-- Devolve o estado novo do médico: { unavailability, vacation, log }
create or replace function public.medico_ausencia(
  p_de date, p_ate date, p_turno text, p_tipo text, p_marcar boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email  text := lower(trim(coalesce(auth.email(), '')));
  v_hoje   date := (now() at time zone 'Europe/Lisbon')::date;
  v_docs   jsonb;
  v_idx    int;
  v_doc    jsonb;
  v_mes    text;
  v_log    jsonb;
  v_ent    jsonb;
begin
  if public.current_app_role() is distinct from 'medico' then
    raise exception 'Só contas de médico podem marcar indisponibilidade ou férias.';
  end if;
  if p_de is null or p_ate is null or p_turno is null or p_tipo is null or p_marcar is null then
    raise exception 'Pedido incompleto.';
  end if;
  if p_turno not in ('day', 'night', 'both') then
    raise exception 'Turno inválido.';
  end if;
  if p_tipo not in ('indisp', 'ferias') then
    raise exception 'Tipo inválido.';
  end if;
  if p_ate < p_de then
    raise exception 'A data final é anterior à inicial.';
  end if;
  if p_ate - p_de > 61 then
    raise exception 'Marque no máximo 62 dias de cada vez.';
  end if;
  if p_de < v_hoje then
    raise exception 'Não é possível alterar dias que já passaram.';
  end if;
  if p_ate > (v_hoje + interval '12 months')::date then
    raise exception 'Só é possível marcar até 12 meses à frente.';
  end if;

  -- Algum mês do intervalo já tem escala feita? A escala antiga (chbv_schedules) é
  -- mantida igual às células pela base de dados nos dois modos, por isso basta olhar
  -- para ela.
  select min(left(s.key, 7)) into v_mes
    from app_data a,
         jsonb_each(case when jsonb_typeof(a.value::jsonb) = 'object' then a.value::jsonb else '{}'::jsonb end) w,
         jsonb_each(case when jsonb_typeof(w.value) = 'object' then w.value else '{}'::jsonb end) s
   where a.key = 'chbv_schedules'
     and left(s.key, 7) between to_char(p_de, 'YYYY-MM') and to_char(p_ate, 'YYYY-MM')
     and jsonb_typeof(s.value) = 'array'
     and jsonb_array_length(s.value) > 0;
  if v_mes is not null then
    raise exception 'A escala de %/% já foi feita. Para alterar, fale com o administrador.',
      right(v_mes, 2), left(v_mes, 4);
  end if;

  -- Bloquear a linha: duas alterações ao mesmo tempo não se apagam uma à outra.
  select value::jsonb into v_docs from app_data where key = 'chbv_doctors' for update;
  if v_docs is null or jsonb_typeof(v_docs) <> 'array' then
    raise exception 'Lista de médicos indisponível.';
  end if;

  select (e.ord - 1)::int into v_idx
    from jsonb_array_elements(v_docs) with ordinality as e(d, ord)
   where v_email <> '' and lower(trim(coalesce(e.d->>'email', ''))) = v_email
   limit 1;
  if v_idx is null then
    raise exception 'Esta conta não está ligada a nenhum médico. Fale com o administrador.';
  end if;

  v_doc := public._medico_aplica(v_docs -> v_idx, p_de, p_ate, p_turno, p_tipo, p_marcar);

  v_ent := jsonb_build_object(
             'ts', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'tipo', case when p_marcar then 'marcou' else 'retirou' end,
             'motivo', p_tipo, 'dk', to_char(p_de, 'YYYY-MM-DD'), 'shift', p_turno);
  if p_ate > p_de then
    v_ent := v_ent || jsonb_build_object('ate', to_char(p_ate, 'YYYY-MM-DD'));
  end if;
  v_log := case when jsonb_typeof(v_doc->'indispLog') = 'array' then v_doc->'indispLog' else '[]'::jsonb end;
  v_log := v_log || jsonb_build_array(v_ent);
  -- Limite para o registo não crescer sem fim (fica dentro de cada gravação).
  if jsonb_array_length(v_log) > 300 then
    v_log := (select jsonb_agg(x order by o)
                from jsonb_array_elements(v_log) with ordinality as l(x, o)
               where o > jsonb_array_length(v_log) - 300);
  end if;

  v_doc  := jsonb_set(v_doc, '{indispLog}', v_log, true);
  v_docs := jsonb_set(v_docs, array[v_idx::text], v_doc, false);

  -- A coluna pode ser json ou jsonb consoante a instalação. A marca app.medico_ausencia
  -- (só nesta transação) diz à proteção abaixo que esta gravação é a própria marcação.
  perform set_config('app.medico_ausencia', '1', true);
  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'app_data' and column_name = 'value') = 'jsonb' then
    update app_data set value = v_docs where key = 'chbv_doctors';
  else
    update app_data set value = v_docs::json where key = 'chbv_doctors';
  end if;
  perform set_config('app.medico_ausencia', '', true);

  return jsonb_build_object('unavailability', v_doc->'monthlyUnavailability',
                            'vacation', v_doc->'monthlyVacation', 'log', v_log);
end $$;

revoke all on function public.medico_ausencia(date, date, text, text, boolean) from public, anon;
grant execute on function public.medico_ausencia(date, date, text, text, boolean) to authenticated;


-- 3. Proteção contra perda de marcações -----------------------------------------
-- A app do admin grava a lista de médicos inteira: lê, junta as suas alterações e
-- escreve. Se um médico marcar alguma coisa nesse intervalo (fração de segundo), ou
-- se um separador antigo da app gravar uma ficha sem o histórico, a marcação podia
-- perder-se. Antes de qualquer gravação de chbv_doctors que não venha desta função,
-- a base de dados compara o histórico (indispLog) de cada médico: entradas que a
-- gravação nova "esqueceu" voltam ao histórico, e as dos últimos 10 minutos — as que
-- uma cópia desatualizada pode ter perdido — voltam a ser aplicadas aos dias.
create or replace function public._app_data_protege_medicos()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old    jsonb := OLD.value::jsonb;
  v_new    jsonb := NEW.value::jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_doc    jsonb;
  v_antigo jsonb;
  v_log    jsonb;
  v_falta  jsonb;
  e        jsonb;
  v_mudou  boolean := false;
begin
  if OLD.key is distinct from 'chbv_doctors'
     or current_setting('app.medico_ausencia', true) = '1'
     or jsonb_typeof(v_old) <> 'array' or jsonb_typeof(v_new) <> 'array' then
    return NEW;
  end if;

  for v_doc in select x from jsonb_array_elements(v_new) x loop
    select o into v_antigo from jsonb_array_elements(v_old) o where o->>'id' = v_doc->>'id' limit 1;
    if v_antigo is not null and jsonb_typeof(v_antigo->'indispLog') = 'array' then
      v_log := case when jsonb_typeof(v_doc->'indispLog') = 'array' then v_doc->'indispLog' else '[]'::jsonb end;
      -- pela ordem em que foram feitas (a ordem do histórico)
      select coalesce(jsonb_agg(l order by o), '[]'::jsonb) into v_falta
        from jsonb_array_elements(v_antigo->'indispLog') with ordinality as h(l, o)
       where not (v_log @> jsonb_build_array(l));
      if jsonb_array_length(v_falta) > 0 then
        v_mudou := true;
        for e in select x from jsonb_array_elements(v_falta) x loop
          if (e->>'ts')::timestamptz >= now() - interval '10 minutes' then
            v_doc := public._medico_aplica(v_doc, (e->>'dk')::date, coalesce(e->>'ate', e->>'dk')::date,
                       e->>'shift', coalesce(e->>'motivo', 'indisp'), e->>'tipo' = 'marcou');
          end if;
        end loop;
        v_log := v_log || v_falta;
        if jsonb_array_length(v_log) > 300 then
          select jsonb_agg(l order by o) into v_log
            from jsonb_array_elements(v_log) with ordinality as h(l, o)
           where o > jsonb_array_length(v_log) - 300;
        end if;
        v_doc := jsonb_set(v_doc, '{indispLog}', v_log, true);
      end if;
    end if;
    v_out := v_out || jsonb_build_array(v_doc);
  end loop;

  if v_mudou then
    if pg_typeof(NEW.value) = 'jsonb'::regtype then
      NEW.value := v_out;
    else
      NEW.value := v_out::json;
    end if;
  end if;
  return NEW;
exception when others then
  -- Nunca impedir uma gravação por causa desta proteção: em caso de dados inesperados,
  -- grava tal como veio (o comportamento de antes desta proteção existir).
  raise warning 'app_data_protege_medicos: %', sqlerrm;
  return NEW;
end $$;

revoke all on function public._app_data_protege_medicos() from public, anon, authenticated;
drop trigger if exists app_data_protege_medicos on public.app_data;
create trigger app_data_protege_medicos
  before update on public.app_data
  for each row execute function public._app_data_protege_medicos();


-- Verificação ------------------------------------------------------------------
select 'instalado' as verificacao, proname as nome
  from pg_proc where proname in ('medico_ausencia', '_medico_aplica', '_app_data_protege_medicos', 'medico_indisponibilidade')
union all
select 'proteção ativa', tgname from pg_trigger where tgname = 'app_data_protege_medicos';
