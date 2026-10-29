/**
 * Paid Postcreator steps of a project, kept on disk the way Higgsfield's
 * Katana keeps a ledger: every generation is recorded with its idempotency
 * key before it starts, a cap stops spending past the budget the user named,
 * and a rerun finds the step it already paid for instead of paying again.
 */
import { readJson, readProject, writeJson } from './project.mjs'
import { MotionError, round } from './tools.mjs'

function totals(ledger) {
  const spent = round(ledger.entries.filter(entry => entry.status !== 'failed').reduce((sum, entry) => sum + (entry.costRub ?? 0), 0), 2)
  return { spentRub: spent, capRub: ledger.capRub, remainingRub: ledger.capRub == null ? null : round(ledger.capRub - spent, 2) }
}

export async function ledgerCommand(dir, action, options = {}) {
  const { paths } = await readProject(dir)
  const ledger = await readJson(paths.ledger, { capRub: null, entries: [] })
  const save = () => writeJson(paths.ledger, ledger)
  switch (action) {
    case 'list':
      return { ...totals(ledger), entries: ledger.entries }
    case 'cap': {
      const cap = Number(options.rub)
      if (!Number.isFinite(cap) || cap < 0) throw new MotionError('cap_invalid', '--rub должно быть числом ≥ 0.')
      ledger.capRub = cap
      await save()
      return totals(ledger)
    }
    case 'check': {
      const cost = Number(options.cost)
      if (!Number.isFinite(cost) || cost < 0) throw new MotionError('cost_invalid', '--cost — цена из котировки, ₽.')
      const sum = totals(ledger)
      return { ...sum, costRub: cost, ok: ledger.capRub == null || sum.spentRub + cost <= ledger.capRub }
    }
    case 'find': {
      const entry = ledger.entries.find(item => item.idempotencyKey === options.key)
      return { found: Boolean(entry), entry: entry ?? null }
    }
    case 'add': {
      const cost = Number(options.cost)
      if (!options.key) throw new MotionError('key_missing', '--key — idempotencyKey платного вызова.')
      if (!Number.isFinite(cost) || cost < 0) throw new MotionError('cost_invalid', '--cost — цена из котировки, ₽.')
      const existing = ledger.entries.find(item => item.idempotencyKey === options.key)
      if (existing) return { duplicate: true, entry: existing, ...totals(ledger) }
      const sum = totals(ledger)
      if (ledger.capRub != null && sum.spentRub + cost > ledger.capRub) {
        throw new MotionError('cap_exceeded', `Шаг стоит ${cost} ₽, осталось ${sum.remainingRub} ₽ из лимита ${ledger.capRub} ₽.`, 'Спросите пользователя, поднять ли лимит (`pc-motion ledger cap --rub N`), или пропустите шаг.')
      }
      const entry = {
        at: new Date().toISOString(),
        tool: options.tool ?? 'generate_to_chat',
        model: options.model ?? null,
        idempotencyKey: options.key,
        taskId: options.task ?? null,
        costRub: cost,
        slot: options.slot ?? null,
        note: options.note ?? '',
        status: 'started',
      }
      ledger.entries.push(entry)
      await save()
      return { duplicate: false, entry, ...totals(ledger) }
    }
    case 'done':
    case 'failed': {
      const entry = ledger.entries.find(item => (options.key && item.idempotencyKey === options.key) || (options.task && item.taskId === options.task))
      if (!entry) throw new MotionError('entry_missing', 'Шаг не найден: укажите --key или --task.')
      entry.status = action === 'done' ? 'completed' : 'failed'
      if (options.task) entry.taskId = options.task
      if (options.file) entry.file = options.file
      await save()
      return { entry, ...totals(ledger) }
    }
    default:
      throw new MotionError('action_invalid', 'ledger: list | cap --rub N | check --cost N | find --key K | add --key K --cost N [--task ID --model M --slot I] | done|failed --key K [--task ID --file F]')
  }
}
