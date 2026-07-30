import React from 'react';

const BrainIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 4.5A2.5 2.5 0 0 0 5 6a3 3 0 0 0-1.25 5.55A3.5 3.5 0 0 0 6 17.5a3 3 0 0 0 5 1.8V6.5a2 2 0 0 0-1.5-2Z" />
      <path d="M14.5 4.5A2.5 2.5 0 0 1 19 6a3 3 0 0 1 1.25 5.55A3.5 3.5 0 0 1 18 17.5a3 3 0 0 1-5 1.8V6.5a2 2 0 0 1 1.5-2Z" />
      <path d="M7 8.5c1.1 0 2 .9 2 2M17 8.5c-1.1 0-2 .9-2 2M7 15c1.1 0 2-.9 2-2M17 15c-1.1 0-2-.9-2-2" />
    </svg>
  );
};

export default BrainIcon;
