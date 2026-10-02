import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RiKeyboardLine } from '@remixicon/react';
import { Button, Dialog } from '../../shared/ui/index.tsx';
import { useStore } from '../../shared/store.ts';
import { cn } from '../../shared/lib/cn.ts';
import { KeyboardShortcuts } from './KeyboardShortcuts.tsx';
import { t } from '../../shared/i18n/index.ts';
import { useLocaleStore } from '../../shared/i18n/locale.ts';

export function PokerShortcutButton({ className }: { className?: string }) {
  // Re-render on language switch: every label below is a render-time t() call,
  // so the button follows the active locale immediately (no reload, and no
  // reliance on App.tsx's keyed remount).
  useLocaleStore((s) => s.locale);
  const [open, setOpen] = useState(false);
  const enabled = useStore(
    (s) =>
      s.prefs.pokerHotkeys.enabled && s.auth.userId !== null && s.pokerHotkeysFor === s.auth.userId,
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className={cn(
          'min-h-8! gap-1.5 bg-transparent! px-2! text-xs! text-inherit! hover:bg-slate-500/15!',
          className,
        )}
        onClick={() => setOpen(true)}
        aria-label={t('Edit keyboard shortcuts')}
      >
        <RiKeyboardLine size={16} aria-hidden />
        {enabled ? t('Shortcuts') : t('Shortcuts off')}
      </Button>
      {createPortal(
        <Dialog open={open} onClose={() => setOpen(false)} title={t('Keyboard shortcuts')} size="lg">
          <KeyboardShortcuts />
        </Dialog>,
        document.body,
      )}
    </>
  );
}
