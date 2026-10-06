import { cn } from '../../../shared/lib/cn.ts';

export const desktopIconClass =
  'relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white';

function DesktopIconButton({
  label,
  onClick,
  children,
  active = false,
  badge = 0,
  buttonRef,
  className,
  hasPopup,
  expanded,
  'data-testid': dataTestId,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  badge?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
  className?: string;
  hasPopup?: boolean;
  expanded?: boolean;
  'data-testid'?: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup={hasPopup ? 'menu' : undefined}
      aria-expanded={hasPopup ? expanded : undefined}
      data-testid={dataTestId}
      className={cn(
        desktopIconClass,
        active && 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
        className,
      )}
    >
      {children}
      {badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-[0.62rem] font-bold text-white ring-2 ring-slate-100 dark:ring-slate-950">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

export { DesktopIconButton };
