import {
  Database,
  LayoutDashboard,
  History,
  Layers3,
  MessageSquare,
  Network,
  Search,
} from 'lucide-react';
import { locationHash, type ExplorerState, type Page } from './state';

type SidebarProps = {
  page: Page;
  explorer: ExplorerState;
  historyCount: number;
  sourceCount: number;
  onNavigate: (page: Page) => void;
};

export function Sidebar({ page, explorer, historyCount, sourceCount, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <a
        className="brand"
        href={locationHash('explore', explorer)}
        onClick={(e) => {
          e.preventDefault();
          onNavigate('explore');
        }}
        aria-label="Warroom home"
      >
        <span className="brand-mark">
          <Layers3 size={23} />
        </span>
        <span>
          warroom<span className="brand-dot">.</span>
        </span>
      </a>
      <div className="nav-label primary-nav-label">EXPLORE</div>
      {(
        [
          { page: 'explore', label: 'Explore', icon: Search },
          { page: 'dashboards', label: 'Dashboards', icon: LayoutDashboard },
          { page: 'investigate', label: 'Investigate', icon: MessageSquare },
          { page: 'service-graph', label: 'Service graph', icon: Network },
          { page: 'history', label: 'Query history', icon: History },
          { page: 'sources', label: 'Data sources', icon: Database },
        ] as const
      ).map((item) => (
        <a
          key={item.page}
          className={`nav-item ${page === item.page ? 'selected' : ''}`}
          aria-current={page === item.page ? 'page' : undefined}
          aria-label={item.label}
          href={locationHash(item.page, explorer)}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(item.page);
          }}
        >
          <item.icon size={18} />
          <span>{item.label}</span>
          {(item.page === 'history' || item.page === 'sources') && (
            <span className="nav-number">
              {item.page === 'history' ? historyCount : sourceCount}
            </span>
          )}
        </a>
      ))}
    </aside>
  );
}
