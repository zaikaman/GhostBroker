import React from 'react';

interface SkeletonProps {
  variant?: 'text' | 'title' | 'circle' | 'rect';
  width?: string | number;
  height?: string | number;
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({
  variant = 'text',
  width,
  height,
  className = '',
  style = {},
}: SkeletonProps): React.JSX.Element {
  const baseClass = 'skeleton-bone';
  const variantClass = `skeleton-${variant}`;
  
  const customStyle: React.CSSProperties = {
    ...style,
  };

  if (width !== undefined) {
    customStyle.width = typeof width === 'number' ? `${width}px` : width;
  }
  
  if (height !== undefined) {
    customStyle.height = typeof height === 'number' ? `${height}px` : height;
  }

  return (
    <div
      className={`${baseClass} ${variantClass} ${className}`.trim()}
      style={customStyle}
    />
  );
}

export default Skeleton;
