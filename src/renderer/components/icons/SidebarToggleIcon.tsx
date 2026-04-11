import React from 'react';

const SidebarToggleIcon: React.FC<{ className?: string; isCollapsed: boolean }> = ({ className, isCollapsed }) => {
  const dividerX = isCollapsed ? 3.5 : 5.5;
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <line x1={dividerX} y1="2" x2={dividerX} y2="14" />
    </svg>
  );
};

export default SidebarToggleIcon;
