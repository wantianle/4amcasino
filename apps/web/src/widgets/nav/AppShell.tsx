import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button as ZeusButton } from '@zeus/ui/base';
import {
  RiHome5Line,
  RiTrophyLine,
  RiExchangeDollarLine,
  RiBarChartBoxLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiAdminLine,
  RiPokerClubsLine,
  RiSearchLine,
  RiSideBarLine,
  RiLogoutBoxLine,
  RiMenuLine,
  RiArrowRightSLine,
  RiRobot2Line,
  RiFlag2Line,
} from '@remixicon/react';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { Dialog, Input } from '../../shared/ui/index.tsx';

interface RoomRow {
  id: string;
  name: string;
  playerCount: number;
}
interface PendingTasks {
  settlementsAwaitingMe: number;
  openDebts: number;
  iOweCount: number;
  invites: number;
  friendRequests: number;
  houseOutstanding: number;
}
interface Destination {
  to: string;
  label: string;
  icon: typeof RiHome5Line;
  badge?: number;
}
const SIDEBAR_KEY = '4am-sidebar';

/** Zeus Sidebar pattern, adapted to real routes and account state.
 * Reference: @zeus/ui 0.2.3 DashboardSidebar (MIT, copyright notpritam).
 * One destination model drives the rail, expanded sidebar, mobile and search.
 */
export function AppShell({ children, newTab = false }: { children: ReactNode; newTab?: boolean }) {
  const auth = useStore((s) => s.auth);
  const prefs = useStore((s) => s.prefs);
  const logout = useStore((s) => s.logout);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== 'full');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [pending, setPending] = useState<PendingTasks | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const searchInput = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    void api
      .myRooms()
      .then((r) => {
        if (active) setRooms(r.rooms.slice(0, 12));
      })
      .catch(() => {});
    void api
      .pendingTasks()
      .then((r) => {
        if (active) setPending(r);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loc.pathname, auth.userId]);
  useEffect(() => {
    setDrawerOpen(false);
    setSearchOpen(false);
    setQuery('');
  }, [loc.pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDrawerOpen(false);
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (searchOpen) searchInput.current?.querySelector('input')?.focus();
  }, [searchOpen]);

  const primary: Destination[] = [
    { to: '/lobby', label: 'Lobby', icon: RiHome5Line },
    { to: '/leaderboard', label: 'Leaderboard', icon: RiTrophyLine },
    { to: '/tournaments', label: 'Tournaments', icon: RiFlag2Line },
    { to: '/agents', label: 'Agent access', icon: RiRobot2Line },
    {
      to: '/settle',
      label: 'Settle up',
      icon: RiExchangeDollarLine,
      badge: (pending?.settlementsAwaitingMe ?? 0) + (pending?.iOweCount ?? 0),
    },
    { to: '/players/' + auth.userId, label: 'My stats', icon: RiBarChartBoxLine },
  ];
  const secondary: Destination[] = [
    { to: '/settings', label: 'Settings', icon: RiSettings3Line },
    { to: '/fair', label: "How it's fair", icon: RiShieldCheckLine },
    ...(auth.isPlatform ? [{ to: '/admin', label: 'Admin', icon: RiAdminLine }] : []),
  ];
  const tableLinks: Destination[] = rooms.map((room) => ({
    to: '/room/' + room.id,
    label: room.name,
    icon: RiPokerClubsLine,
  }));
  const all = [...primary, ...tableLinks, ...secondary];
  const pageName =
    all.find((item) => item.to === loc.pathname)?.label ??
    (loc.pathname.startsWith('/tournaments/') ? 'Tournament' : 'Table');
  const waiting = (pending?.invites ?? 0) + (pending?.friendRequests ?? 0);
  // Match either the English source or its translation, so both languages
  // find the same destination in the ⌘K dialog.
  const q = query.trim().toLowerCase();
  const matches = (item: Destination) =>
    item.label.toLowerCase().includes(q) || t(item.label).toLowerCase().includes(q);

  function toggleSidebar() {
    setCollapsed((previous) => {
      localStorage.setItem(SIDEBAR_KEY, previous ? 'full' : 'rail');
      return !previous;
    });
  }
  async function doLogout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api.logout();
      logout();
      navigate('/login', { replace: true });
    } catch {
      setLogoutError(t('Could not log out. Check your connection and try again.'));
    } finally {
      setLoggingOut(false);
    }
  }
  const row = (item: Destination, rail = false) => {
    const active =
      loc.pathname === item.to ||
      (item.to === '/tournaments' && loc.pathname.startsWith('/tournaments/'));
    const Icon = item.icon;
    const label = t(item.label);
    const name = item.badge ? t('{label} ({n} waiting)', { label, n: item.badge }) : label;
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-label={newTab && !active ? t('{name} (opens in a new tab)', { name }) : name}
        aria-current={active ? 'page' : undefined}
        title={rail ? name : undefined}
        {...(newTab && !active ? { target: '_blank', rel: 'noreferrer' } : {})}
        onClick={() => {
          setDrawerOpen(false);
          setSearchOpen(false);
        }}
        className={cn('zeus-nav-item', active && 'is-active', rail && 'is-rail')}
      >
        <Icon className="size-5 shrink-0" aria-hidden />
        {!rail && <span className="min-w-0 flex-1 truncate">{label}</span>}
        {!!item.badge && (
          <span className={cn('zeus-nav-badge', rail && 'is-dot')} aria-hidden>
            {!rail && item.badge}
          </span>
        )}
      </Link>
    );
  };
  const navigation = (rail: boolean) => (
    <>
      <nav aria-label={t('Main navigation')} className="zeus-nav-list">
        {primary.map((item) => row(item, rail))}
        {tableLinks.length > 0 && (
          <div className="zeus-nav-section">
            {!rail && <p className="zeus-nav-label">{t('Your tables')}</p>}
            {tableLinks.map((item) => row(item, rail))}
          </div>
        )}
      </nav>
      <div className="mt-auto space-y-1 pt-5">
        {waiting > 0 && (
          <Link
            to="/lobby"
            {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
            className={cn('zeus-nav-item', rail && 'is-rail')}
            title={t('Invites and friend requests')}
            aria-label={
              newTab
                ? t('{name} (opens in a new tab)', {
                    name: t('{n} invites and friend requests', { n: waiting }),
                  })
                : t('{n} invites and friend requests', { n: waiting })
            }
          >
            <span className="zeus-pending-count">{waiting}</span>
            {!rail && <span className="truncate text-xs">{t('Invites & requests')}</span>}
          </Link>
        )}
        <nav aria-label={t('Account navigation')}>{secondary.map((item) => row(item, rail))}</nav>
        <div className="zeus-account">
          <Link
            to={'/players/' + auth.userId}
            aria-label={
              newTab
                ? t('{name} (opens in a new tab)', { name: t('Your profile') })
                : t('Your profile')
            }
            title={rail ? t('Your profile') : undefined}
            {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <Avatar
              userId={auth.userId ?? 0}
              name={prefs.displayName || auth.username || t('You')}
              size="sm"
              version={prefs.avatarVersion}
            />
            {!rail && (
              <span className="min-w-0 truncate text-sm font-medium">
                {prefs.displayName || auth.username}
              </span>
            )}
          </Link>
          {!rail && (
            <ZeusButton
              variant="ghost"
              iconOnly
              aria-label={t('Log out')}
              title={t('Log out')}
              disabled={loggingOut}
              onClick={() => void doLogout()}
              leadingIcon={RiLogoutBoxLine}
            />
          )}
        </div>
        {rail && (
          <ZeusButton
            variant="ghost"
            iconOnly
            aria-label={t('Log out')}
            title={t('Log out')}
            disabled={loggingOut}
            onClick={() => void doLogout()}
            leadingIcon={RiLogoutBoxLine}
            className="w-full"
          />
        )}
      </div>
    </>
  );

  return (
    <div className={cn('zeus-app-shell', collapsed && 'rail-mode')}>
      <a href="#app-content" className="zeus-skip-link">
        {t('Skip to content')}
      </a>
      <aside className="zeus-sidebar" aria-label={t('Sidebar')}>
        <Link
          to="/lobby"
          aria-label={
            newTab
              ? t('{name} (opens in a new tab)', { name: t('4AM Casino lobby') })
              : t('4AM Casino lobby')
          }
          {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
          title="4AM Casino"
          className="zeus-brand"
        >
          <span className="zeus-brand-mark">
            <RiPokerClubsLine className="size-5" aria-hidden />
          </span>
          {!collapsed && (
            <span className="min-w-0 truncate font-semibold tracking-tight">4AM Casino</span>
          )}
        </Link>
        <div className={cn('zeus-sidebar-tools', collapsed && 'flex-col')}>
          <ZeusButton
            variant="ghost"
            iconOnly={collapsed}
            leadingIcon={RiSearchLine}
            aria-label={t('Search navigation')}
            title={t('Search navigation (⌘K)')}
            onClick={() => setSearchOpen(true)}
            className={cn('min-w-0', !collapsed && 'flex-1 justify-start')}
          >
            {!collapsed && t('Search')}
          </ZeusButton>
          <ZeusButton
            variant="ghost"
            iconOnly
            leadingIcon={RiSideBarLine}
            aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            title={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          />
        </div>
        {navigation(collapsed)}
      </aside>
      <div className="zeus-main">
        <header className="zeus-page-header">
          <ZeusButton
            variant="ghost"
            iconOnly
            leadingIcon={RiMenuLine}
            aria-label={t('Open navigation')}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="md:hidden"
          />
          <span className="text-text-tertiary">4AM Casino</span>
          <RiArrowRightSLine className="size-4 text-foreground-icon-tertiary" aria-hidden />
          <span className="truncate text-text-primary">{t(pageName)}</span>
          <ZeusButton
            variant="ghost"
            iconOnly
            leadingIcon={RiSearchLine}
            aria-label={t('Search pages')}
            onClick={() => setSearchOpen(true)}
            className="ml-auto"
          />
        </header>
        <main id="app-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} title={t('Navigation')}>
        <div className="zeus-mobile-nav">{navigation(false)}</div>
      </Dialog>
      <Dialog
        open={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          setQuery('');
        }}
        title={t('Go to')}
      >
        <div ref={searchInput}>
          <Input
            aria-label={t('Search pages and tables')}
            placeholder={t('Search pages and tables…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav
          aria-label={t('Search results')}
          className="mt-3 max-h-[55dvh] space-y-1 overflow-y-auto"
        >
          {all.filter(matches).map((item) => row(item))}
          {!all.some(matches) && (
            <p role="status" className="px-2 py-6 text-sm text-text-secondary">
              {t('No pages or tables match “{query}”.', { query })}
            </p>
          )}
        </nav>
      </Dialog>
      <Dialog open={!!logoutError} onClose={() => setLogoutError('')} title={t('Log out')}>
        <p role="alert" className="mb-4 text-sm">
          {logoutError}
        </p>
        <ZeusButton disabled={loggingOut} onClick={() => void doLogout()}>
          {t('Try again')}
        </ZeusButton>
      </Dialog>
    </div>
  );
}
