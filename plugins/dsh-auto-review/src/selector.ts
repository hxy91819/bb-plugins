export const selectorSource = `export const name = 'bb-dsh-auto-review';
export const inject = ['permissionPresets'];
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return;
    ctx.permissionPresets.set(agent.session, 'auto');
  });
}
`;
