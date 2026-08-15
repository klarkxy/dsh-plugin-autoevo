export const name = 'capability-evolution-e2e-approval'
export const inject = ['approval']

export function apply(ctx) {
  ctx.on('approval/request', async () => 'allowed-once')
}

