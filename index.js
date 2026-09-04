// dsh-sidechat — node (host) half.
// All cleanup is done by the browser half through public RPCs
// (workspace.archiveSession). The loader still resolves this package's
// `main` for the node side of the row, so provide a minimal plugin body.
export const name = 'dsh-sidechat';
export const inject = [];
export function apply() {}
export default { name, inject, apply };
