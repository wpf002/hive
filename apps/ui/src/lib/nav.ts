import { LayoutGrid, Bot, BookTemplate, ListChecks, Cpu, Wand2, Clock, TrendingUp, Info, type LucideIcon } from 'lucide-react';

// Lifecycle groups, top → bottom: overview → build things → operate them →
// watch the fleet → get help. `group` only drives the subtle dividers the
// Sidebar / MobileNav render at each boundary (and leaves room for section
// labels later) — the array order is what actually orders the nav.
export type NavGroup = 'overview' | 'build' | 'operate' | 'fleet' | 'help';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: NavGroup;
}

// Shared by the desktop Sidebar and the mobile slide-over nav.
export const NAV: NavItem[] = [
  { href: '/dashboard',   label: 'Dashboard',  icon: LayoutGrid,   group: 'overview' },

  { href: '/bots',        label: 'Bots',       icon: Bot,          group: 'build' },
  { href: '/bot-builder', label: 'AI Builder', icon: Wand2,        group: 'build' },
  { href: '/templates',   label: 'Templates',  icon: BookTemplate, group: 'build' },

  { href: '/schedules',   label: 'Schedules',  icon: Clock,        group: 'operate' },
  { href: '/jobs',        label: 'Jobs',       icon: ListChecks,   group: 'operate' },

  { href: '/trading',     label: 'Trading',    icon: TrendingUp,   group: 'fleet' },
  { href: '/workers',     label: 'Workers',    icon: Cpu,          group: 'fleet' },

  { href: '/info',        label: 'Info',       icon: Info,         group: 'help' },
];
