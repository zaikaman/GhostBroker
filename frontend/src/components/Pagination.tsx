import React from 'react';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  itemsPerPage?: number;
}

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  totalItems,
  itemsPerPage,
}: PaginationProps): React.JSX.Element | null {
  if (totalPages <= 1) return null;

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      pages.push(1);
      
      if (currentPage > 3) {
        pages.push('...');
      }
      
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      
      for (let i = start; i <= end; i++) {
        // Prevent duplicate page numbers if start/end overlaps with boundaries
        if (i > 1 && i < totalPages) {
          pages.push(i);
        }
      }
      
      if (currentPage < totalPages - 2) {
        pages.push('...');
      }
      
      pages.push(totalPages);
    }
    return pages;
  };

  const pages = getPageNumbers();

  const startItem = totalItems !== undefined && itemsPerPage !== undefined 
    ? (currentPage - 1) * itemsPerPage + 1 
    : null;
  const endItem = totalItems !== undefined && itemsPerPage !== undefined
    ? Math.min(currentPage * itemsPerPage, totalItems)
    : null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 'var(--spacing-sm) 0 0 0',
      borderTop: '1px solid var(--color-border)',
      marginTop: 'var(--spacing-md)',
      flexWrap: 'wrap',
      gap: 'var(--spacing-sm)'
    }}>
      {/* Items info */}
      {startItem !== null && endItem !== null && totalItems !== undefined ? (
        <div style={{
          fontSize: '0.7rem',
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.02em'
        }}>
          Showing <span style={{ color: 'var(--color-text-primary)' }}>{startItem}-{endItem}</span> of <span style={{ color: 'var(--color-text-primary)' }}>{totalItems}</span> entries
        </div>
      ) : (
        <div />
      )}

      {/* Page Controls */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px'
      }}>
        {/* Previous Button */}
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            color: currentPage === 1 ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
            cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
            padding: '4px 10px',
            fontSize: '0.7rem',
            fontFamily: 'var(--font-mono)',
            transition: 'all var(--transition-fast)',
            opacity: currentPage === 1 ? 0.4 : 1,
            outline: 'none'
          }}
          className="pagination-btn"
        >
          &larr; PREV
        </button>

        {/* Page numbers */}
        {pages.map((page, index) => {
          if (page === '...') {
            return (
              <span
                key={`dots-${index}`}
                style={{
                  color: 'var(--color-text-muted)',
                  padding: '4px 8px',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ...
              </span>
            );
          }

          const isCurrent = page === currentPage;

          return (
            <button
              key={`page-${page}`}
              type="button"
              onClick={() => onPageChange(page as number)}
              style={{
                background: isCurrent ? 'rgba(94, 210, 156, 0.08)' : 'transparent',
                border: '1px solid',
                borderColor: isCurrent ? 'var(--color-accent)' : 'transparent',
                borderRadius: '4px',
                color: isCurrent ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                fontWeight: isCurrent ? 'bold' : 'normal',
                cursor: 'pointer',
                minWidth: '26px',
                height: '24px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 6px',
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                transition: 'all var(--transition-fast)',
                outline: 'none'
              }}
              className="pagination-btn"
            >
              {page}
            </button>
          );
        })}

        {/* Next Button */}
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--color-border)',
            borderRadius: '4px',
            color: currentPage === totalPages ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
            cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
            padding: '4px 10px',
            fontSize: '0.7rem',
            fontFamily: 'var(--font-mono)',
            transition: 'all var(--transition-fast)',
            opacity: currentPage === totalPages ? 0.4 : 1,
            outline: 'none'
          }}
          className="pagination-btn"
        >
          NEXT &rarr;
        </button>
      </div>
    </div>
  );
}

export default Pagination;
