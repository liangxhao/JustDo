import React, { type PropsWithChildren } from 'react';

const BottomRightStatusStack: React.FC<PropsWithChildren> = ({ children }) => (
  <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[min(520px,calc(100vw-2rem))] flex-col items-end gap-2">
    {children}
  </div>
);

export default BottomRightStatusStack;
