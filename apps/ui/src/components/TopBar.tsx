import { UserMenu } from './UserMenu';
import { EnvLabelPill } from './EnvLabelPill';

export function TopBar() {
  return (
    <div className="flex h-10 shrink-0 items-center justify-end border-b border-hive-border bg-hive-bg px-3">
      <EnvLabelPill />
      <UserMenu />
    </div>
  );
}
