import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDraft, buildKpis, filterDrafts } from '../js/domain.js';
import { loadDashboard } from '../js/data.js';

const row = (id, created_at, extra = {}) => normalizeDraft({
  id, created_at, estado_reserva: 'pendiente_pago', monto_pagado: 100,
  comprobante_revision_at: '2026-10-21T18:00:00Z', masaje_inicio: '2026-10-25T18:00:00Z', ...extra
});
const rows = [
  row(1, '2026-10-20T05:59:59Z'),
  row(2, '2026-10-20T06:00:00Z'),
  row(3, '2026-10-21T05:59:59Z', { estado_reserva: 'requiere_revision_pago' }),
  row(4, '2026-10-21T06:00:00Z'), row(5, null), row(6, 'invalida'),
  row(7, '2026-10-20T08:00:00Z', { estado_reserva: 'cancelando_expirada' })
];
const calculate = date => buildKpis(rows, [], [], new Map(), { date });

test('creación conserva su instante aunque revisión y cita sean posteriores', () => {
  assert.equal(rows[1].enteredAt.toISOString(), '2026-10-20T06:00:00.000Z');
  assert.deepEqual(filterDrafts(rows, calculate().statuses, { date: '2026-10-20' }).map(r => r.id), [2, 3, 7]);
});
test('límites de medianoche en México', () => {
  assert.deepEqual(filterDrafts(rows, calculate().statuses, { date: '2026-10-19' }).map(r => r.id), [1]);
  assert.deepEqual(filterDrafts(rows, calculate().statuses, { date: '2026-10-21' }).map(r => r.id), [4]);
});
test('sin creación válida no se utiliza revisión, actualización ni cita', () => {
  assert.equal(rows[4].createdAt, null);
  assert.equal(rows[4].enteredAt, null);
  assert.equal(rows[5].enteredAt, null);
  assert.equal(row(8, null, { updated_at: '2026-10-20T12:00:00Z' }).enteredAt, null);
});
test('alias de creación se conservan sin depender de revisión', () => {
  for (const key of ['creado_at', 'fecha_creacion']) {
    assert.equal(row(9, null, { [key]: '2026-10-20T10:00:00Z' }).enteredAt.toISOString(), '2026-10-20T10:00:00.000Z');
  }
});
test('contador y monto operativo usan el día de creación y excluyen cancelaciones', () => {
  const result = calculate('2026-10-20');
  assert.equal(result.toManage, 2);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.pendingAmount, 200);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.missingCreationCount, 2);
  assert.equal(result.creationDate, '2026-10-20');
});
test('día vacío devuelve cero y limpiar fecha recupera también las filas sin creación', () => {
  assert.equal(calculate('2026-10-22').toManage, 0);
  assert.equal(calculate('2026-10-22').pendingAmount, 0);
  assert.equal(calculate('').toManage, 6);
  assert.equal(filterDrafts(rows, calculate().statuses).length, 7);
});
test('cambiar la fecha no altera los estados para el detalle ni el contrato de confirmaciones', () => {
  assert.equal(calculate('2026-10-19').statuses.size, 7);
  assert.equal(calculate('2026-10-20').confirmedTodayCount, calculate().confirmedTodayCount);
});

function sourceWithCreation(hasColumn) {
  const selections = [];
  return {
    selections,
    from(table) {
      let columns;
      const query = {
        select(value) { columns = value; selections.push({ table, columns }); return query; },
        limit() { return query; }, order() { return query; },
        then(resolve) {
          const missing = table === 'reservas_draft' && !hasColumn && columns.includes('created_at');
          return Promise.resolve(missing
            ? { data: null, error: { code: '42703', message: 'column created_at does not exist' } }
            : { error: null, data: table === 'reservas_draft' ? [{
              id: 900, estado_reserva: 'pendiente_pago', comprobante_revision_at: '2026-10-21T10:00:00Z',
              ...(hasColumn ? { created_at: '2026-10-20T10:00:00Z' } : {})
            }] : [] }).then(resolve);
        }
      };
      return query;
    }
  };
}
test('lectura solicita la creación real cuando existe', async () => {
  const source = sourceWithCreation(true);
  const result = await loadDashboard(source);
  assert.ok(source.selections.some(s => s.table === 'reservas_draft' && s.columns.includes('created_at')));
  assert.equal(result.drafts[0].enteredAt.toISOString(), '2026-10-20T10:00:00.000Z');
  assert.equal(result.warnings.length, 0);
});
test('base sin migrar sigue operable y la creación desconocida no se inventa', async () => {
  const result = await loadDashboard(sourceWithCreation(false));
  assert.equal(result.problems.length, 0);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].enteredAt, null);
  assert.equal(result.warnings.length, 1);
});
