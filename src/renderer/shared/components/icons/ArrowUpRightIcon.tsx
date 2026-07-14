import React from 'react';

interface ArrowUpRightIconProps {
  className?: string;
}

const ArrowUpRightIcon: React.FC<ArrowUpRightIconProps> = ({ className = 'h-4 w-4' }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 12L12 4" />
      <path d="M6 4H12V10" />
    </svg>
  );
};

export default ArrowUpRightIcon;
