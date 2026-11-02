/**
 * Achievement catalogue. Definitions are data-only; unlock rules are wired
 * to simulation events in main.js so saves remain simple and testable.
 */
export const ACHIEVEMENTS = Object.freeze([
  {
    id: 'first_surge',
    name: 'First Surge',
    description: 'Collect your first energy node.',
    icon: '⚡',
    tier: 'bronze',
  },
  {
    id: 'chain_8',
    name: 'Chain Reaction',
    description: 'Reach an 8× combo streak.',
    icon: '⌁',
    tier: 'bronze',
  },
  {
    id: 'chain_16',
    name: 'Cascade',
    description: 'Reach a 16× combo streak.',
    icon: '≋',
    tier: 'silver',
  },
  {
    id: 'shield_burn',
    name: 'Live Wire',
    description: 'Survive a fatal collision with a shield.',
    icon: '⬡',
    tier: 'silver',
  },
  {
    id: 'century',
    name: 'Century Coil',
    description: 'Collect 100 energy nodes across all runs.',
    icon: '◎',
    tier: 'silver',
  },
  {
    id: 'high_voltage',
    name: 'High Voltage',
    description: 'Score 10,000 in a single Endless run.',
    icon: '↯',
    tier: 'gold',
  },
  {
    id: 'power_four',
    name: 'Full Spectrum',
    description: 'Activate all four power-ups in one run.',
    icon: '✦',
    tier: 'gold',
  },
  {
    id: 'cpu_clear',
    name: 'Core Protocol',
    description: 'Stabilise the CPU Core (level 5).',
    icon: '▣',
    tier: 'bronze',
  },
  {
    id: 'memory_clear',
    name: 'Bank Cleared',
    description: 'Stabilise the Memory Banks (level 10).',
    icon: '▤',
    tier: 'bronze',
  },
  {
    id: 'power_clear',
    name: 'Full Charge',
    description: 'Stabilise the Power Supply (level 15).',
    icon: '⌁',
    tier: 'silver',
  },
  {
    id: 'gpu_clear',
    name: 'Frame Perfect',
    description: 'Stabilise the Graphics Processor (level 20).',
    icon: '◫',
    tier: 'silver',
  },
  {
    id: 'nexus_clear',
    name: 'Nexus Unlocked',
    description: 'Stabilise the Circuit Nexus (level 25).',
    icon: '✧',
    tier: 'gold',
  },
  {
    id: 'reactor_clear',
    name: 'Meltdown Averted',
    description: 'Stabilise the Reactor Core (level 30).',
    icon: '☢',
    tier: 'gold',
  },
  {
    id: 'hard_clear',
    name: 'Overclocked',
    description: 'Complete any campaign level on Hard.',
    icon: '▲',
    tier: 'gold',
  },
  {
    id: 'untouchable',
    name: 'Untouchable',
    description: 'Complete a campaign level without burning a shield.',
    icon: '◇',
    tier: 'silver',
  },
  {
    id: 'survivor',
    name: 'Long Haul',
    description: 'Survive 5 minutes in Endless.',
    icon: '∞',
    tier: 'gold',
  },
]);

export const ACHIEVEMENT_IDS = Object.freeze(ACHIEVEMENTS.map((a) => a.id));

export function getAchievement(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}
