import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import PremiumGate from '$lib/components/PremiumGate.svelte';

describe('<PremiumGate />', () => {
  it('does not render the Premium-required note when premium', () => {
    render(PremiumGate, { props: { product: 'premium' } });
    expect(screen.queryByText(/Premium required/i)).toBeNull();
  });
  it('renders the Premium-required note when free', () => {
    render(PremiumGate, { props: { product: 'free' } });
    expect(screen.getByText(/Premium required/i)).toBeTruthy();
  });
  it('renders the Premium-required note for "open" (no Spotify product)', () => {
    render(PremiumGate, { props: { product: 'open' } });
    expect(screen.getByText(/Premium required/i)).toBeTruthy();
  });
});
