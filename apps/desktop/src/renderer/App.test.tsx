import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('bootstrap shell', () => {
  it('renders the product identity and the protocol version', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Layup');
    expect(screen.getByText(/protocol v\d+/)).toBeTruthy();
  });
});
