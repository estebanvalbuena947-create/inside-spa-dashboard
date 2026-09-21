-- Allows only the two dashboard administrators to read confirmed reservations.
-- This table remains protected by RLS for every other authenticated user.
grant select on public.reservas to authenticated;

create policy "Inside Spa dashboard admins read confirmed reservations"
  on public.reservas
  for select
  to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', '')) in (
      'contacto@insidespa.com.mx',
      'estebanvalbuena947@gmail.com'
    )
  );
