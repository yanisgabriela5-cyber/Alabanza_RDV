-- =====================================================================
-- APP ALABANZA · Actualización 010 · Aviso de reemplazo y calendario
--   1. Cuando alguien marca "No puedo", se escribe en el chat del día
--      mencionando a @admins (les llega la notificación push de mención).
--   2. Link privado de calendario por persona (lo usa la Edge Function
--      "calendario"; ver supabase/functions/calendario/index.ts).
-- Requiere: 004, 007 y 008 ejecutados.
-- Supabase → SQL Editor → New query → pegar todo → Run
-- Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. AVISO DE REEMPLAZO
-- ---------------------------------------------------------------------
create or replace function public.avisar_rechazo() returns trigger
language plpgsql security definer set search_path = public as $$
declare rol_txt text;
begin
  -- solo cuando la propia persona marca "No puedo" (no cuando un admin la edita)
  if new.estado <> 'rechazado' or old.estado = 'rechazado' or auth.uid() is distinct from new.perfil_id then
    return new;
  end if;
  -- si tenía varios roles ese día, un solo mensaje
  if exists (select 1 from mensajes_evento where setlist_id = new.setlist_id and autor_id = new.perfil_id
             and texto like '❌ No puedo servir%' and created_at > now() - interval '2 minutes') then
    return new;
  end if;
  select string_agg(case a.rol
      when 'voz' then 'Voz' when 'piano' then 'Piano / Teclado' when 'guitarra' then 'Guitarra acústica'
      when 'guitarra_electrica' then 'Guitarra eléctrica' when 'bajo' then 'Bajo' when 'bateria' then 'Batería'
      when 'percusion' then 'Percusión menor' else a.rol end
      || case when a.dirige then ' (dirige)' else '' end, ', ')
    into rol_txt
  from asignaciones a
  where a.setlist_id = new.setlist_id and a.perfil_id = new.perfil_id and a.estado = 'rechazado';
  insert into mensajes_evento (setlist_id, autor_id, texto)
  values (new.setlist_id, new.perfil_id,
    '❌ No puedo servir este día (' || coalesce(rol_txt, new.rol) || '). @[admins](grupo) hay que buscar reemplazo.'
    || coalesce(' Motivo: ' || nullif(trim(new.nota), ''), ''));
  return new;
end $$;

drop trigger if exists trg_avisar_rechazo on public.asignaciones;
create trigger trg_avisar_rechazo after update of estado on public.asignaciones
  for each row execute function public.avisar_rechazo();

-- ---------------------------------------------------------------------
-- 2. CALENDARIO: un token secreto por persona
-- ---------------------------------------------------------------------
create table if not exists public.calendario_tokens (
  perfil_id  uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  token      uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table public.calendario_tokens enable row level security;
drop policy if exists "cal_mio" on public.calendario_tokens;
create policy "cal_mio" on public.calendario_tokens for select to authenticated using (perfil_id = auth.uid());

-- Devuelve el token del usuario (lo crea si no existe). p_nuevo = true invalida el link anterior.
create or replace function public.mi_token_calendario(p_nuevo boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if not public.es_aprobado() then raise exception 'Cuenta no aprobada'; end if;
  if p_nuevo then delete from calendario_tokens where perfil_id = auth.uid(); end if;
  insert into calendario_tokens (perfil_id) values (auth.uid()) on conflict (perfil_id) do nothing;
  select token into t from calendario_tokens where perfil_id = auth.uid();
  return t;
end $$;
revoke all on function public.mi_token_calendario(boolean) from public, anon;
grant execute on function public.mi_token_calendario(boolean) to authenticated;
