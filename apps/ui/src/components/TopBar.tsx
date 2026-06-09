import { UserMenu } from './UserMenu';
import { EnvLabelPill } from './EnvLabelPill';
import { MobileNav } from './MobileNav';

export function TopBar() {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-hive-border bg-hive-bg px-3">
      <MobileNav />
      <div className="flex items-center gap-2">
        <EnvLabelPill />
        <UserMenu />
      </div>
    </div>
  );
}
