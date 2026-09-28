// Recovery-only binding. Replacement deployments must not hide an earlier
// depositor's refundable cash or existing wallet transaction journal.
export const legacyNeutralDeployment={
  symbol:'ETH' as const,
  address:'0x3D4Ee6D147AF67371073e74206D6d49e64960f9c' as const,
  runtimeCodeHash:'0x30f048d9fc0e88a8b91523e2dafee18aa25f70bfbabaa8c9c5fd370f2a3b6366' as const,
  block:'74666915',tiers:50,
  controller:'0xae3600b13a2F894f81F6565DD207492601B2Ce3E' as const,
  entryFeeBps:300,exitFeeBps:600,
};
