import { LayoutGrid, Bot, BookTemplate, ListChecks, Cpu, Wand2, Clock, TrendingUp, Info, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Shared by the desktop Sidebar and the mobile slide-over nav.
export const NAV: NavItem[] = [
  { href: '/dashboard',  label: 'Dashboard',  icon: LayoutGrid },
  { href: '/bots',       label: 'Bots',       icon: Bot },
  { href: '/bot-builder', label: 'AI Builder', icon: Wand2 },
  { href: '/templates',  label: 'Templates',  icon: BookTemplate },
  { href: '/jobs',       label: 'Jobs',       icon: ListChecks },
  { href: '/schedules',  label: 'Schedules',  icon: Clock },
  { href: '/trading',    label: 'Trading',    icon: TrendingUp },
  { href: '/workers',    label: 'Workers',    icon: Cpu },
  { href: '/info',       label: 'Info',       icon: Info },
];
