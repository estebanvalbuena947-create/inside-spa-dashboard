-- ============================================================================
-- INSIDE SPA · DASHBOARD DE RESERVAS
-- Migración + auditoría para el proyecto Supabase "SPA" (ncutewymydclypuqlbfk)
--
-- CÓMO USARLO
--   1. Entra a https://supabase.com/dashboard/project/ncutewymydclypuqlbfk/sql/new
--   2. Pega TODO este archivo y pulsa RUN.
--   3. Devuelve dos resultados: "RESUMEN DE AUDITORIA" y
--      "COLUMNAS EXACTAS". Con esos dos se valida todo el dashboard.
--
-- Es idempotente: se puede ejecutar varias veces sin romper nada.
-- No borra ni modifica datos de reservas: solo permisos, políticas y la función
-- que registra las decisiones del dashboard.
-- Las políticas se reemplazan por nombre; las tablas y los datos no se tocan.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PERMISOS (lo que hoy bloquea el dashboard)
--    Sin GRANT, PostgREST responde "permission denied for table ...".
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on public.reservas_draft to authenticated;
grant select on public.reservas to authenticated;
grant select on public.spa_comprobantes_pago to authenticated;
grant select on public.dashboard_reservation_decisions to authenticated;

-- El dashboard registra decisiones y actualiza el estado de la pre-reserva.
grant insert, select on public.dashboard_reservation_decisions to authenticated;
grant update on public.reservas_draft to authenticated;

-- ---------------------------------------------------------------------------
-- 2) RLS + POLÍTICAS PARA LOS ADMINISTRADORES DEL DASHBOARD
--    Autoriza únicamente a los correos del dashboard (los mismos de
--    supabase-config.js). El service_role de n8n no se ve afectado.
-- ---------------------------------------------------------------------------
alter table public.reservas_draft enable row level security;
alter table public.spa_comprobantes_pago enable row level security;
alter table public.dashboard_reservation_decisions enable row level security;

create or replace function public.inside_spa_dashboard_emails()
returns text[]
language sql
stable
as $$
  select array['contacto@insidespa.com.mx', 'estebanvalbuena947@gmail.com']::text[];
$$;

grant execute on function public.inside_spa_dashboard_emails() to authenticated;

drop policy if exists "Inside Spa dashboard admins read confirmed reservations" on public.reservas;
drop policy if exists "Inside Spa dashboard admins read drafts" on public.reservas_draft;
drop policy if exists "Inside Spa dashboard admins update drafts" on public.reservas_draft;
drop policy if exists "Inside Spa dashboard admins read receipts" on public.spa_comprobantes_pago;
drop policy if exists "Inside Spa dashboard admins update receipts" on public.spa_comprobantes_pago;
drop policy if exists "Inside Spa dashboard admins read decisions" on public.dashboard_reservation_decisions;
drop policy if exists "Inside Spa dashboard admins write decisions" on public.dashboard_reservation_decisions;

create policy "Inside Spa dashboard admins read confirmed reservations"
  on public.reservas for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins read drafts"
  on public.reservas_draft for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins update drafts"
  on public.reservas_draft for update to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()))
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins read receipts"
  on public.spa_comprobantes_pago for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins update receipts"
  on public.spa_comprobantes_pago for update to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()))
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins read decisions"
  on public.dashboard_reservation_decisions for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

create policy "Inside Spa dashboard admins write decisions"
  on public.dashboard_reservation_decisions for insert to authenticated
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = any (public.inside_spa_dashboard_emails()));

-- ---------------------------------------------------------------------------
-- 3) RPC DE DECISIONES
--    El dashboard llama:
--      process_dashboard_reservation_decision(p_reservation_draft_id bigint,
--                                             p_action text,
--                                             p_note text)
--    Si existía una versión vieja con otros parámetros, se elimina.
-- ---------------------------------------------------------------------------
drop function if exists public.process_dashboard_reservation_decision(bigint, text, text);
drop function if exists public.process_dashboard_reservation_decision(bigint, text);
drop function if exists public.process_dashboard_reservation_decision(integer, text);
drop function if exists public.process_dashboard_reservation_decision(text, text);

create or replace function public.process_dashboard_reservation_decision(
  p_reservation_draft_id bigint,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_previous text;
  v_resulting text;
  v_new_state text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  -- 1. Autorización: solo los correos del dashboard pueden decidir.
  if v_email = '' or not (v_email = any (public.inside_spa_dashboard_emails())) then
    raise exception 'Not authorized for Inside Spa dashboard';
  end if;

  if p_action not in ('approved', 'rejected', 'needs_info') then
    raise exception 'Accion no valida: %', p_action;
  end if;

  select estado_reserva into v_previous
    from public.reservas_draft
   where id = p_reservation_draft_id
     for update;

  if not found then
    raise exception 'La pre-reserva % no existe', p_reservation_draft_id;
  end if;

  if p_action = 'approved' then
    v_new_state := 'confirmado';
    v_resulting := 'confirmado';
  elsif p_action = 'rejected' then
    v_new_state := 'rechazado';
    v_resulting := 'rechazado';
  else
    -- "Pedir información" no cambia el estado del pago: si el comprobante ya
    -- estaba en revisión se deja igual, y si no, pasa a revisión manual.
    v_new_state := case when v_previous in ('requiere_revision', 'requiere_revision_pago')
                        then v_previous else 'requiere_revision' end;
    v_resulting := 'requiere_revision';
  end if;

  -- 2. Actualiza la pre-reserva con las columnas reales del proyecto.
  --    (reservas_draft no tiene updated_at: su marca de tiempo es comprobante_revision_at).
  update public.reservas_draft
     set estado_reserva = v_new_state,
         reserva_confirmada = case when p_action = 'approved' then true
                                   when p_action = 'rejected' then false
                                   else reserva_confirmada end,
         pago_recibido = case when p_action = 'approved' then true else pago_recibido end,
         fecha_pago = case when p_action = 'approved' then current_date::text else fecha_pago end,
         comprobante_revision_at = now()
   where id = p_reservation_draft_id;

  -- 3. Deja rastro en la evidencia guardada dentro de la pre-reserva, para que
  --    el dashboard y n8n sepan quién revisó y con qué resultado.
  update public.reservas_draft
     set comprobante_revision_datos = coalesce(comprobante_revision_datos, '{}'::jsonb)
         || jsonb_build_object(
              'decision_dashboard', p_action,
              'decision_dashboard_at', now(),
              'decision_dashboard_por', v_email,
              'comprobante_estado', case p_action
                                      when 'approved' then 'aprobado'
                                      when 'rejected' then 'rechazado'
                                      else 'revision_manual' end,
              'decision_nota', v_note
            )
   where id = p_reservation_draft_id;

  -- 4. Marca el comprobante de la tabla como aprobado o rechazado.
  update public.spa_comprobantes_pago
     set estado = case p_action when 'approved' then 'aprobado'
                                when 'rejected' then 'rechazado'
                                else 'revision' end,
         actualizado_at = now()
   where reserva_draft_id = p_reservation_draft_id;

  -- 5. Registro histórico de la decisión.
  insert into public.dashboard_reservation_decisions
    (reservation_draft_id, action, note, previous_status, resulting_status, decided_by_email)
  values
    (p_reservation_draft_id, p_action, v_note, v_previous, v_resulting, v_email);

  return jsonb_build_object(
    'ok', true,
    'reservation_draft_id', p_reservation_draft_id,
    'action', p_action,
    'previous_status', v_previous,
    'resulting_status', v_resulting,
    'decided_by_email', v_email
  );
end
$$;

revoke all on function public.process_dashboard_reservation_decision(bigint, text, text) from public;
grant execute on function public.process_dashboard_reservation_decision(bigint, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) AUDITORÍA (solo lectura): RESUMEN
-- ---------------------------------------------------------------------------
with tablas(nombre) as (
  values ('reservas_draft'), ('reservas'), ('spa_comprobantes_pago'), ('dashboard_reservation_decisions')
),
columnas(tabla, nombre) as (
  values
    ('reservas_draft', 'estado_reserva'), ('reservas_draft', 'monto_pagado'), ('reservas_draft', 'nombre_servicio'),
    ('reservas_draft', 'masaje_inicio'), ('reservas_draft', 'jacuzzi_inicio'), ('reservas_draft', 'comprobante_revision_at'),
    ('reservas_draft', 'reserva_confirmada'), ('reservas_draft', 'email'), ('reservas_draft', 'phone'),
    ('reservas', 'pabau_confirmado_at'), ('reservas', 'nombre_servicio'), ('reservas', 'monto_pagado'),
    ('reservas', 'masaje_inicio'), ('reservas', 'jacuzzi_inicio'), ('reservas', 'reserva_confirmada'),
    ('spa_comprobantes_pago', 'reserva_draft_id'), ('spa_comprobantes_pago', 'datos'), ('spa_comprobantes_pago', 'estado'),
    ('spa_comprobantes_pago', 'actualizado_at'),
    ('dashboard_reservation_decisions', 'reservation_draft_id'), ('dashboard_reservation_decisions', 'action'),
    ('dashboard_reservation_decisions', 'decided_by_email'), ('dashboard_reservation_decisions', 'created_at')
)
select 1 as orden, 'TABLA' as seccion, t.nombre as item,
       case when c.relname is null then 'FALTA' else 'ok' end as estado,
       coalesce(pg_size_pretty(pg_total_relation_size(c.oid)), '-') as detalle
  from tablas t
  left join pg_class c on c.relname = t.nombre and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'

union all
select 2, 'COLUMNA CLAVE', col.tabla || '.' || col.nombre,
       case when exists (
         select 1 from information_schema.columns ic
          where ic.table_schema = 'public' and ic.table_name = col.tabla and ic.column_name = col.nombre
       ) then 'ok' else 'FALTA' end,
       coalesce((select ic.data_type from information_schema.columns ic
                  where ic.table_schema = 'public' and ic.table_name = col.tabla and ic.column_name = col.nombre), '-')
  from columnas col

union all
select 3, 'RLS', c.relname,
       case when c.relrowsecurity then 'ACTIVO' else 'DESACTIVADO' end, ''
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in (select nombre from tablas)

union all
select 4, 'PERMISO authenticated', t.nombre || ' · ' || p.priv,
       case when has_table_privilege('authenticated', ('public.' || t.nombre), p.priv) then 'ok' else 'FALTA' end, ''
  from tablas t
 cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as p(priv)
 where exists (select 1 from pg_class c where c.relname = t.nombre and c.relnamespace = 'public'::regnamespace and c.relkind = 'r')

union all
select 5, 'POLÍTICA', p.tablename || ' · ' || p.policyname, p.cmd, array_to_string(p.roles, ', ')
  from pg_policies p
 where p.schemaname = 'public' and p.tablename in (select nombre from tablas)

union all
select 6, 'FUNCIÓN',
       p.proname || '(' || pg_get_function_arguments(p.oid) || ')',
       case when p.prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end,
       p.prorettype::regtype::text
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('process_dashboard_reservation_decision', 'inside_spa_dashboard_emails')

union all
select 7, 'FILAS', t.nombre, '',
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.nombre), false, true, '')))[1]::text
  from tablas t
 where exists (select 1 from pg_class c where c.relname = t.nombre and c.relnamespace = 'public'::regnamespace and c.relkind = 'r')

order by 1, 2, 3;

-- ---------------------------------------------------------------------------
-- 5) AUDITORÍA (solo lectura): COLUMNAS EXACTAS DE CADA TABLA
-- ---------------------------------------------------------------------------
select table_name as tabla, ordinal_position as pos, column_name as columna,
       data_type as tipo, is_nullable as nulo, column_default as por_defecto
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('reservas_draft', 'reservas', 'spa_comprobantes_pago', 'dashboard_reservation_decisions')
 order by table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- 6) EXTRA (opcional): valores reales de estado_reserva
--    Descomenta estas líneas para saber con qué estados trabaja hoy la operación.
-- ---------------------------------------------------------------------------
-- select estado_reserva, count(*) as total,
--        min(comprobante_revision_at) as mas_antiguo, max(comprobante_revision_at) as mas_reciente
--   from public.reservas_draft
--  group by estado_reserva
--  order by total desc;
