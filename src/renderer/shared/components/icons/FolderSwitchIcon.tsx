import React from 'react';

const FolderSwitchIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6h-7.2a2 2 0 0 1-1.4-.6L9.6 3.6A2 2 0 0 0 8.2 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z" />
    <path d="M7 11h10m-2.5-2.5L17 11l-2.5 2.5M17 16H7m2.5-2.5L7 16l2.5 2.5" />
  </svg>
);

export default FolderSwitchIcon;
