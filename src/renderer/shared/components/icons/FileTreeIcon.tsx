import React from 'react';

const FileTreeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="1.5" y="1" width="3" height="3" rx="0.5" />
    <path d="M3 4v9h3M3 8h3" />
    <rect x="6" y="6.5" width="8" height="3" rx="0.75" />
    <rect x="6" y="11.5" width="8" height="3" rx="0.75" />
  </svg>
);

export default FileTreeIcon;
