import { render, screen } from '@testing-library/react';
import App from '../app/App';

describe('Dashboard Accessibility', () => {
  it('should render correct HTML landmarks and aria attributes', () => {
    render(<App />);

    // Validate main landmark sections
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();

    // Validate headers
    const mainHeading = screen.getByRole('heading', { level: 1 });
    expect(mainHeading).toHaveTextContent(/GhostBroker/i);

    const sectionHeadings = screen.getAllByRole('heading', { level: 2 });
    expect(sectionHeadings.length).toBeGreaterThanOrEqual(3);
  });

  it('should display status landmarks with secure connection labels', () => {
    render(<App />);
    
    // Check for Enclave status, Telemetry status and Sandbox network labels
    expect(screen.getByText(/TEE Enclave Status/i)).toBeInTheDocument();
    expect(screen.getByText(/Telemetry Link/i)).toBeInTheDocument();
    expect(screen.getByText(/T3 Sandbox Network/i)).toBeInTheDocument();
  });
});
