// TSX fixture — exercises the tsx grammar (JSX + TS types).
import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps): JSX.Element {
  return (
    <button onClick={onClick} className="px-2 py-1">
      {label}
    </button>
  );
}

export const Card: React.FC<{ title: string }> = ({ title, children }) => {
  return (
    <div className="card">
      <h3>{title}</h3>
      {children}
    </div>
  );
};
