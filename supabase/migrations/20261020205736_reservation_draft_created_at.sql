-- No asignar la fecha de migración a reservas históricas.
-- Al aplicar, ejecutar ambas instrucciones en una transacción.
alter table public.reservas_draft
  add column if not exists created_at timestamptz;

alter table public.reservas_draft
  alter column created_at set default now();

comment on column public.reservas_draft.created_at is
  'Creación real de la fila. NULL indica historia desconocida; no inferir desde revisión o cita.';
